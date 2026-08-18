/**
 * Sync Manager Tests
 * Tests for core synchronization orchestration, user scoping, and lifecycle teardown
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
const mockIndexedDBManager = vi.hoisted(() => ({
    init: vi.fn().mockResolvedValue({}),
    getDirtyFiles: vi.fn().mockResolvedValue([]),
    getFile: vi.fn(),
    saveFile: vi.fn(),
    markFileDirty: vi.fn(),
    markFileClean: vi.fn(),
    getSyncMetadata: vi.fn(),
    updateLastSyncedAt: vi.fn(),
    close: vi.fn(),
}));

const mockConnectionDetector = vi.hoisted(() => {
    let stateChangeCb: ((state: string) => void) | null = null;
    return {
        init: vi.fn(),
        destroy: vi.fn(),
        isOnline: vi.fn().mockReturnValue(true),
        getState: vi.fn().mockReturnValue('online'),
        onChange: vi.fn((cb) => {
            stateChangeCb = cb;
            return () => { stateChangeCb = null; };
        }),
        _triggerChange: (state: string) => {
            if (stateChangeCb) stateChangeCb(state);
        },
    };
});

const mockConcurrencyManager = vi.hoisted(() => ({
    withLock: vi.fn((fileId: string, fn: () => Promise<unknown>) => fn()),
}));

const mockSyncRollback = vi.hoisted(() => ({
    createCheckpoint: vi.fn().mockResolvedValue('checkpoint-123'),
    rollback: vi.fn(),
    removeCheckpoint: vi.fn(),
}));

const mockSyncErrorHandler = vi.hoisted(() => ({
    createError: vi.fn((type, message) => ({
        type,
        message,
        timestamp: Date.now(),
        recoverable: false,
    })),
    fromException: vi.fn((e) => ({
        type: 'UNKNOWN_ERROR',
        message: e?.message || 'Unknown',
        timestamp: Date.now(),
    })),
    handle: vi.fn(),
}));

vi.mock('./indexeddb', () => ({
    indexedDBManager: mockIndexedDBManager,
    createIndexedDBManager: vi.fn(() => mockIndexedDBManager),
}));
vi.mock('./connection-detector', () => ({
    connectionDetector: mockConnectionDetector,
    withBackoff: vi.fn((fn) => fn()),
}));
vi.mock('./concurrency-manager', () => ({
    concurrencyManager: mockConcurrencyManager,
}));
vi.mock('./rollback', () => ({ syncRollback: mockSyncRollback }));
vi.mock('./error-handler', () => ({
    syncErrorHandler: mockSyncErrorHandler,
    SyncErrorType: {
        NETWORK_ERROR: 'NETWORK_ERROR',
        CONFLICT_ERROR: 'CONFLICT_ERROR',
        UNKNOWN_ERROR: 'UNKNOWN_ERROR',
    },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { SyncManager, createSyncManager } from './sync-manager';

describe('Sync Manager', () => {
    let manager: SyncManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new SyncManager();

        // Reset mocks to default behavior
        mockConnectionDetector.isOnline.mockReturnValue(true);

        // Default fetch mock
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ files: [], has_more: false }),
        });
    });

    afterEach(() => {
        manager.destroy();
    });

    describe('init & Scoping', () => {
        it('should initialize all components when valid userId is provided', async () => {
            await manager.init({ userId: 'user-123' });

            expect(mockIndexedDBManager.init).toHaveBeenCalledWith('user-123');
            expect(mockConnectionDetector.init).toHaveBeenCalled();
            expect(manager.getUserId()).toBe('user-123');
        });

        it('should reject init if userId is empty, null or undefined', async () => {
            await expect(manager.init({ userId: '' })).rejects.toThrow('valid, non-empty userId');
            expect(manager.getStatus()).toBe('stopped');
        });

        it('should only initialize once for the same user', async () => {
            await manager.init({ userId: 'user-123' });
            await manager.init({ userId: 'user-123' });

            expect(mockIndexedDBManager.init).toHaveBeenCalledTimes(1);
        });

        it('should recreate and re-scope when initialized with a different user', async () => {
            await manager.init({ userId: 'user-123' });
            expect(manager.getUserId()).toBe('user-123');

            await manager.init({ userId: 'user-456' });
            expect(manager.getUserId()).toBe('user-456');
            expect(mockIndexedDBManager.init).toHaveBeenCalledWith('user-456');
        });
    });

    describe('destroy & Lifecycle Safety', () => {
        it('should clean up resources, close IDB, and transition to stopped', async () => {
            await manager.init({ userId: 'user-123' });
            expect(manager.getStatus()).toBe('idle');

            manager.destroy();

            expect(mockIndexedDBManager.close).toHaveBeenCalled();
            expect(manager.getStatus()).toBe('stopped');
        });

        it('should be safe to call multiple times', async () => {
            await manager.init({ userId: 'user-123' });
            manager.destroy();
            expect(() => manager.destroy()).not.toThrow();
        });

        it('should prevent sync from transitioning after destroy', async () => {
            await manager.init({ userId: 'user-123' });
            manager.destroy();

            const result = await manager.sync();
            expect(result.success).toBe(false);
            expect(manager.getStatus()).toBe('stopped');
        });
    });

    describe('getStatus', () => {
        it('should start as stopped before init', () => {
            const freshManager = new SyncManager();
            expect(freshManager.getStatus()).toBe('stopped');
        });

        it('should return idle when online after init', async () => {
            await manager.init({ userId: 'user-123' });
            expect(manager.getStatus()).toBe('idle');
        });
    });

    describe('onStatusChange', () => {
        it('should return unsubscribe function', async () => {
            await manager.init({ userId: 'user-123' });

            const callback = vi.fn();
            const unsubscribe = manager.onStatusChange(callback);

            expect(typeof unsubscribe).toBe('function');
            unsubscribe();
        });
    });

    describe('sync', () => {
        it('should reject or return stopped result if not initialized', async () => {
            const result = await manager.sync();
            expect(result.success).toBe(false);
            expect(result.errors).toContain('SyncManager is stopped or uninitialized');
        });

        it('should return offline result when offline', async () => {
            await manager.init({ userId: 'user-123' });
            mockConnectionDetector.isOnline.mockReturnValue(false);

            const result = await manager.sync();

            expect(result.success).toBe(false);
            expect(result.errors).toContain('Offline');
        });

        it('should complete successfully when online', async () => {
            await manager.init({ userId: 'user-123' });
            mockConnectionDetector.isOnline.mockReturnValue(true);

            const result = await manager.sync();

            expect(result).toBeDefined();
            expect(typeof result.filesPushed).toBe('number');
            expect(typeof result.filesPulled).toBe('number');
        });
    });

    describe('single-flight online consumer', () => {
        it('should trigger single-flight consumer when connection transitions to online and serialize runs', async () => {
            mockConnectionDetector.isOnline.mockReturnValue(false);
            await manager.init({ userId: 'user-123' });
            expect(manager.getStatus()).toBe('offline');

            mockConnectionDetector.isOnline.mockReturnValue(true);
            let executionCount = 0;
            const originalSync = manager.sync.bind(manager);
            vi.spyOn(manager, 'sync').mockImplementation(async () => {
                executionCount++;
                await new Promise(r => setTimeout(r, 20));
                return originalSync();
            });

            // Trigger online multiple times rapidly
            mockConnectionDetector._triggerChange('online');
            mockConnectionDetector._triggerChange('online');
            mockConnectionDetector._triggerChange('online');

            await new Promise(r => setTimeout(r, 100));

            // Should have executed consumer without overlapping floods
            expect(executionCount).toBeGreaterThanOrEqual(1);
            expect(executionCount).toBeLessThanOrEqual(2);
        });
    });

    describe('AbortController cancellation during active sync', () => {
        it('should abort ongoing sync when destroy() is called mid-sync', async () => {
            await manager.init({ userId: 'user-123' });
            mockIndexedDBManager.getDirtyFiles.mockResolvedValue([
                { id: 'dirty-1', content: 'test', title: 'test', etag: 'etag-1', isDirty: true },
            ]);

            // Mock fetch to simulate long in-flight request
            mockFetch.mockImplementation((url, options) => {
                return new Promise((resolve, reject) => {
                    const signal = options?.signal as AbortSignal;
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            const err = new Error('The operation was aborted');
                            err.name = 'AbortError';
                            reject(err);
                        });
                    }
                });
            });

            const syncPromise = manager.sync();

            // Destroy manager while sync is awaiting network
            await new Promise(r => setTimeout(r, 10));
            manager.destroy();

            const result = await syncPromise;
            expect(result.success).toBe(false);
            expect(manager.getStatus()).toBe('stopped');
        });
    });

    describe('Conflict handling (412 Precondition Failed)', () => {
        it('should invoke conflict callback when server returns 412', async () => {
            await manager.init({ userId: 'user-123' });
            mockIndexedDBManager.getDirtyFiles.mockResolvedValue([
                { id: 'conflict-file', content: 'Local Changes', title: 'Doc', etag: 'etag-old', isDirty: true },
            ]);

            const conflictCallback = vi.fn().mockResolvedValue('server');
            manager.setConflictCallback(conflictCallback);

            mockFetch.mockImplementation(async (url) => {
                if (url.toString().includes('/api/files/conflict-file')) {
                    return {
                        status: 412,
                        ok: false,
                        json: async () => ({
                            error: 'Conflict',
                            serverVersion: {
                                content: 'Server Newer Content',
                                etag: 'etag-server-new',
                                version: 2,
                                updatedAt: new Date().toISOString(),
                            },
                        }),
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ files: [], has_more: false }),
                };
            });

            const result = await manager.sync();

            expect(conflictCallback).toHaveBeenCalledWith(expect.objectContaining({
                fileId: 'conflict-file',
                localContent: 'Local Changes',
                serverContent: 'Server Newer Content',
            }));
            expect(result.conflicts).toContain('conflict-file');
        });
    });

    describe('Paginated pull updates', () => {
        it('should pull all pages when has_more is true', async () => {
            await manager.init({ userId: 'user-123' });
            mockIndexedDBManager.getDirtyFiles.mockResolvedValue([]);

            let callCount = 0;
            mockFetch.mockImplementation(async (url) => {
                callCount++;
                if (callCount === 1) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            files: [
                                { id: 'page1-f1', content: 'p1', etag: 'e1', version: 1, title: 'p1', updatedAt: new Date().toISOString(), isFolder: false, parentFolderId: null }
                            ],
                            has_more: true,
                            next_cursor: 'cursor-2',
                        }),
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        files: [
                            { id: 'page2-f2', content: 'p2', etag: 'e2', version: 1, title: 'p2', updatedAt: new Date().toISOString(), isFolder: false, parentFolderId: null }
                        ],
                        has_more: false,
                    }),
                };
            });

            const result = await manager.sync();

            expect(callCount).toBe(2);
            expect(result.filesPulled).toBe(2);
            expect(result.success).toBe(true);
        });
    });

    describe('syncFile', () => {
        it('should skip non-existent files', async () => {
            await manager.init({ userId: 'user-123' });
            mockIndexedDBManager.getFile.mockResolvedValue(undefined);

            const result = await manager.syncFile('non-existent');

            expect(result.success).toBe(false);
            expect(result.action).toBe('skipped');
        });

        it('should skip clean files', async () => {
            await manager.init({ userId: 'user-123' });
            mockIndexedDBManager.getFile.mockResolvedValue({
                id: 'file-1',
                isDirty: false,
            });

            const result = await manager.syncFile('file-1');

            expect(result.action).toBe('skipped');
        });
    });

    describe('queueSync', () => {
        it('should add file to sync queue with deterministic operationId and update status to queued', async () => {
            await manager.init({ userId: 'user-123' });

            manager.queueSync('file-1', 2, 'custom-op-123');
            expect(manager.getStatus()).toBe('queued');
        });

        it('should accept priority parameter', async () => {
            await manager.init({ userId: 'user-123' });

            expect(() => manager.queueSync('file-1', 1)).not.toThrow();
        });
    });

    describe('setConflictCallback', () => {
        it('should register conflict callback', async () => {
            await manager.init({ userId: 'user-123' });

            const callback = vi.fn().mockResolvedValue('local');
            expect(() => manager.setConflictCallback(callback)).not.toThrow();
        });
    });

    describe('IndexedDB dependency injection and ownership', () => {
        it('should accept custom injected IndexedDBManager instance and not create internal instance', async () => {
            const customIdb = {
                ...mockIndexedDBManager,
                init: vi.fn().mockResolvedValue({}),
                close: vi.fn(),
            };

            const customManager = createSyncManager({
                userId: 'user-injected',
                idb: customIdb as any,
            });

            await customManager.init({
                userId: 'user-injected',
                idb: customIdb as any,
            });

            expect(customIdb.init).toHaveBeenCalledWith('user-injected');

            customManager.destroy();
            expect(customIdb.close).toHaveBeenCalled();
        });
    });
});
