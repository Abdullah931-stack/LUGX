/**
 * @vitest-environment jsdom
 *
 * useSync Hook Tests
 *
 * Scoped hook tests: verifies that the useSync hook creates user-isolated instances,
 * properly manages user lifecycle, ensures clean resource teardown, and handles user switching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------- mock the unit modules the hook depends on ----------
const mockStopGC = vi.fn();

const mocks = vi.hoisted(() => ({
    syncManager: {
        init: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        sync: vi.fn().mockResolvedValue({
            success: true,
            filesProcessed: 0,
            filesPushed: 0,
            filesPulled: 0,
            conflicts: [],
            errors: [],
            timestamp: Date.now(),
        }),
        syncFile: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn().mockReturnValue('idle'),
        onStatusChange: vi.fn().mockReturnValue(() => undefined),
        onRemoteUpdate: vi.fn().mockReturnValue(() => undefined),
        setConflictCallback: vi.fn(),
    },
    connectionDetector: {
        init: vi.fn(),
        destroy: vi.fn(),
        getState: vi.fn().mockReturnValue('online'),
        onChange: vi.fn().mockReturnValue(() => undefined),
    },
    indexedDBManager: {
        init: vi.fn().mockResolvedValue({}),
        getFile: vi.fn().mockResolvedValue(undefined),
        saveFile: vi.fn().mockResolvedValue(undefined),
        markFileDirty: vi.fn().mockResolvedValue(undefined),
        coalesceOperation: vi.fn().mockResolvedValue(undefined),
        getDirtyFiles: vi.fn().mockResolvedValue([]),
        close: vi.fn(),
    },
    operationsGC: {
        cleanup: vi.fn().mockResolvedValue(undefined),
        schedule: vi.fn().mockImplementation(() => mockStopGC),
    },
}));

vi.mock('@/lib/sync', async importOriginal => {
    const original = await importOriginal<typeof import('@/lib/sync')>();
    return {
        ...original,
        syncManager: mocks.syncManager,
        createSyncManager: vi.fn(() => mocks.syncManager),
        connectionDetector: mocks.connectionDetector,
        indexedDBManager: mocks.indexedDBManager,
        createIndexedDBManager: vi.fn(() => mocks.indexedDBManager),
        operationsGC: mocks.operationsGC,
        createOperationsGC: vi.fn(() => mocks.operationsGC),
    };
});

import { useSync } from './use-sync';

describe('useSync hook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.operationsGC.schedule.mockImplementation(() => mockStopGC);
    });

    it('should stay in stopped state when userId is empty or null', async () => {
        const { result, rerender } = renderHook<ReturnType<typeof useSync>, { userId?: string | null }>(
            (props) => useSync({ userId: props.userId }),
            { initialProps: { userId: '' } }
        );


        expect(result.current.status).toBe('stopped');
        expect(result.current.isInitialized).toBe(false);
        expect(mocks.syncManager.init).not.toHaveBeenCalled();
        expect(mocks.indexedDBManager.init).not.toHaveBeenCalled();

        // Rerender with null
        rerender({ userId: null });
        expect(result.current.status).toBe('stopped');
        expect(result.current.isInitialized).toBe(false);
        expect(mocks.syncManager.init).not.toHaveBeenCalled();
    });


    it('should initialize the sync manager with the provided userId and auto-sync interval', async () => {
        const { result } = renderHook(() =>
            useSync({ userId: 'user-123', autoSyncInterval: 60_000 }),
        );

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        expect(mocks.indexedDBManager.init).toHaveBeenCalledWith('user-123');
        expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-123',
            autoSyncInterval: 60_000,
        }));
        expect(mocks.operationsGC.schedule).toHaveBeenCalled();
    });

    it('should reflect sync status changes via the onStatusChange subscription', async () => {
        let statusCallback: (status: string) => void = () => undefined;
        mocks.syncManager.onStatusChange.mockImplementation(
            (cb: (status: string) => void) => {
                statusCallback = cb;
                return () => undefined;
            },
        );

        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        await act(async () => {
            statusCallback('syncing');
        });

        expect(result.current.status).toBe('syncing');
    });

    it('should trigger sync and record the last sync result', async () => {
        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        await act(async () => {
            await result.current.sync();
        });

        expect(mocks.syncManager.sync).toHaveBeenCalled();
        expect(result.current.lastSyncResult?.success).toBe(true);
        expect(result.current.lastSyncResult?.filesPushed).toBe(0);
    });

    it('should delegate syncFile to the sync manager', async () => {
        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        await act(async () => {
            await result.current.syncFile('file-abc');
        });

        expect(mocks.syncManager.syncFile).toHaveBeenCalledWith('file-abc');
    });

    it('should save a file locally through the indexeddb manager', async () => {
        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        await act(async () => {
            await result.current.saveLocal({
                id: 'file-abc',
                content: 'Hello',
                title: 'Test',
            });
        });

        expect(mocks.indexedDBManager.saveFile).toHaveBeenCalled();
    });

    it('should load a file from local storage', async () => {
        const mockFile = {
            id: 'file-abc',
            content: 'Stored content',
            title: 'Test',
            etag: 'etag-1',
            version: 1,
            isDirty: false,
            parentFolderId: null,
            isFolder: false,
            lastModified: Date.now(),
            lastSyncedAt: Date.now(),
        };
        (mocks.indexedDBManager.getFile as unknown as {
            mockResolvedValue: (value: unknown) => void;
        }).mockResolvedValue(mockFile);

        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        let loaded: unknown = null;
        await act(async () => {
            loaded = await result.current.loadLocal('file-abc');
        });

        if (!loaded || typeof loaded !== 'object') {
            throw new Error('Expected loadLocal to return a file');
        }
        expect((loaded as { content: string }).content).toBe('Stored content');
        expect(mocks.indexedDBManager.getFile).toHaveBeenCalledWith('file-abc');
    });

    it('should mark a file as dirty through the indexeddb manager', async () => {
        const { result } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        await act(async () => {
            await result.current.markDirty('file-abc');
        });

        expect(mocks.indexedDBManager.markFileDirty).toHaveBeenCalledWith('file-abc');
    });

    it('should register the conflict callback when onConflict is provided', async () => {
        const onConflict = vi.fn().mockResolvedValue('local');

        renderHook(() => useSync({ userId: 'user-123', onConflict }));

        await waitFor(() =>
            expect(mocks.syncManager.setConflictCallback).toHaveBeenCalled(),
        );

        const registeredCb = mocks.syncManager.setConflictCallback.mock.calls[0][0];
        const syncConflict = {
            fileId: 'file-abc',
            localContent: 'a',
            localEtag: undefined,
            serverContent: 'b',
            serverEtag: undefined,
        };

        await act(async () => {
            await registeredCb(syncConflict);
        });

        expect(onConflict).toHaveBeenCalledTimes(1);
        const transformedConflict = onConflict.mock.calls[0][0] as Record<string, unknown> | undefined;
        expect(transformedConflict?.fileId).toBe('file-abc');
        expect((transformedConflict?.localVersion as { content: string })?.content).toBe('a');
        expect((transformedConflict?.serverVersion as { content: string })?.content).toBe('b');
        expect(transformedConflict?.operations).toEqual([]);
        expect(transformedConflict?.detectedAt).toBeDefined();
    });

    it('should handle user switching by destroying previous manager and reinitializing', async () => {
        const { result, rerender } = renderHook<ReturnType<typeof useSync>, { userId: string }>(
            (props) => useSync({ userId: props.userId }),
            { initialProps: { userId: 'user-1' } }
        );


        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));

        // Switch user
        rerender({ userId: 'user-2' });

        expect(mocks.syncManager.destroy).toHaveBeenCalled();
        expect(mockStopGC).toHaveBeenCalled();

        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-2' }));
    });

    it('should handle transition from user to null (logout) and then to another user', async () => {
        const { result, rerender } = renderHook<ReturnType<typeof useSync>, { userId?: string | null }>(
            (props) => useSync({ userId: props.userId }),
            { initialProps: { userId: 'user-alpha' } }
        );

        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-alpha' }));

        // User logs out (userId becomes null)
        rerender({ userId: null });

        expect(mocks.syncManager.destroy).toHaveBeenCalled();
        expect(mockStopGC).toHaveBeenCalled();
        expect(result.current.status).toBe('stopped');
        expect(result.current.isInitialized).toBe(false);

        // User logs in as user-beta
        rerender({ userId: 'user-beta' });

        await waitFor(() => expect(result.current.isInitialized).toBe(true));
        expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-beta' }));
    });

    it('should safely abort and clean up when unmounted during active sync', async () => {
        let resolveSync: (val: unknown) => void;
        const pendingSyncPromise = new Promise((resolve) => {
            resolveSync = resolve;
        });
        mocks.syncManager.sync.mockReturnValue(pendingSyncPromise);

        const { result, unmount } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        // Start sync (does not await)
        const syncCall = result.current.sync();

        // Unmount while sync is in-flight
        unmount();

        expect(mocks.syncManager.destroy).toHaveBeenCalled();
        expect(mockStopGC).toHaveBeenCalled();

        resolveSync!({ success: false, filesProcessed: 0, filesPushed: 0, filesPulled: 0, conflicts: [], errors: ['Aborted'], timestamp: Date.now() });
        await syncCall;
    });

    it('should handle repeated mount/unmount cycles without leaking listeners or timers', async () => {
        const unsubscribeStatus = vi.fn();
        const unsubscribeConnection = vi.fn();
        mocks.syncManager.onStatusChange.mockReturnValue(unsubscribeStatus);
        mocks.connectionDetector.onChange.mockReturnValue(unsubscribeConnection);

        for (let i = 0; i < 3; i++) {
            const { unmount } = renderHook(() => useSync({ userId: `user-cycle-${i}` }));
            await waitFor(() => expect(mocks.syncManager.init).toHaveBeenCalledWith(expect.objectContaining({ userId: `user-cycle-${i}` })));
            unmount();
            expect(unsubscribeStatus).toHaveBeenCalled();
            expect(unsubscribeConnection).toHaveBeenCalled();
            expect(mockStopGC).toHaveBeenCalled();
            expect(mocks.syncManager.destroy).toHaveBeenCalled();
        }
    });

    it('should forward onRemoteUpdate events from SyncManager to subscriber', async () => {
        let capturedCallback: ((event: any) => void) | null = null;
        mocks.syncManager.onRemoteUpdate.mockImplementation((cb) => {
            capturedCallback = cb;
            return () => { capturedCallback = null; };
        });

        const onRemoteUpdateSpy = vi.fn();
        const { unmount } = renderHook(() => useSync({ userId: 'user-123', onRemoteUpdate: onRemoteUpdateSpy }));

        await waitFor(() => expect(mocks.syncManager.init).toHaveBeenCalled());

        expect(capturedCallback).toBeDefined();

        const fakeEvent = {
            fileId: 'file-remote',
            content: '# Remote Content',
            etag: 'etag-remote-2',
            version: 2,
            updatedAt: new Date().toISOString(),
        };

        act(() => {
            capturedCallback!(fakeEvent);
        });

        expect(onRemoteUpdateSpy).toHaveBeenCalledWith(fakeEvent);

        unmount();
    });
});
