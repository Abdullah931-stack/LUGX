/**
 * @vitest-environment jsdom
 *
 * useSync Hook Tests
 *
 * REAL hook tests: the useSync hook is imported and executed against
 * mocked unit modules (@/lib/sync singletons), so assertions cover the
 * hook's actual state management, initialization and effect behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------- mock the unit modules the hook depends on ----------
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
        setConflictCallback: vi.fn(),
    },
    connectionDetector: {
        init: vi.fn(),
        destroy: vi.fn(),
        getState: vi.fn().mockReturnValue('online'),
        onChange: vi.fn().mockReturnValue(() => undefined),
    },
    indexedDBManager: {
        getFile: vi.fn().mockResolvedValue(undefined),
        saveFile: vi.fn().mockResolvedValue(undefined),
        markFileDirty: vi.fn().mockResolvedValue(undefined),
        getDirtyFiles: vi.fn().mockResolvedValue([]),
    },
    operationsGC: {
        cleanup: vi.fn().mockResolvedValue(undefined),
        schedule: vi.fn(),
    },
}));

vi.mock('@/lib/sync', async importOriginal => {
    const original = await importOriginal<typeof import('@/lib/sync')>();
    return {
        ...original,
        syncManager: mocks.syncManager,
        connectionDetector: mocks.connectionDetector,
        indexedDBManager: mocks.indexedDBManager,
        operationsGC: mocks.operationsGC,
    };
});

import { useSync } from './use-sync';

describe('useSync hook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should initialize the sync manager with the provided userId and auto-sync interval', async () => {
        const { result } = renderHook(() =>
            useSync({ userId: 'user-123', autoSyncInterval: 60_000 }),
        );

        await waitFor(() => expect(result.current.isInitialized).toBe(true));

        expect(mocks.syncManager.init).toHaveBeenCalledWith({
            userId: 'user-123',
            autoSyncInterval: 60_000,
        });
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

        // Extract the registered callback and invoke it
        const registeredCb = mocks.syncManager.setConflictCallback.mock.calls[0][0];
        const syncConflict = {
            fileId: 'file-abc',
            localContent: 'a',
            localEtag: undefined,
            serverContent: 'b',
            serverEtag: undefined,
        };

        let transformedConflict: Record<string, unknown> | undefined;
        await act(async () => {
            await registeredCb(syncConflict);
        });

        // The hook wraps the raw sync conflict into the UI-friendly
        // SyncConflict shape before forwarding it to onConflict
        expect(onConflict).toHaveBeenCalledTimes(1);
        transformedConflict = onConflict.mock.calls[0][0];
        expect(transformedConflict?.fileId).toBe('file-abc');
        expect((transformedConflict?.localVersion as { content: string })?.content).toBe('a');
        expect((transformedConflict?.serverVersion as { content: string })?.content).toBe('b');
        expect(transformedConflict?.operations).toEqual([]);
        expect(transformedConflict?.detectedAt).toBeDefined();
    });

    it('should unsubscribe and destroy the sync manager on unmount', async () => {
        const unsubscribeStatus = vi.fn();
        const unsubscribeConnection = vi.fn();
        mocks.syncManager.onStatusChange.mockReturnValue(unsubscribeStatus);
        mocks.connectionDetector.onChange.mockReturnValue(unsubscribeConnection);

        const { unmount } = renderHook(() => useSync({ userId: 'user-123' }));

        await waitFor(() =>
            expect(mocks.syncManager.init).toHaveBeenCalled(),
        );

        unmount();

        expect(unsubscribeStatus).toHaveBeenCalled();
        expect(unsubscribeConnection).toHaveBeenCalled();
        expect(mocks.syncManager.destroy).toHaveBeenCalled();
    });
});
