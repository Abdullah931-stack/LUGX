/**
 * Sync Manager Tests
 * Tests for core synchronization orchestration
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
}));

const mockConnectionDetector = vi.hoisted(() => ({
    init: vi.fn(),
    destroy: vi.fn(),
    isOnline: vi.fn().mockReturnValue(true),
    getState: vi.fn().mockReturnValue('online'),
    onChange: vi.fn().mockReturnValue(() => { }),
}));

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

vi.mock('./indexeddb', () => ({ indexedDBManager: mockIndexedDBManager }));
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

import { SyncManager } from './sync-manager';

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

    describe('init', () => {
        it('should initialize all components', async () => {
            await manager.init({ userId: 'user-123' });

            expect(mockIndexedDBManager.init).toHaveBeenCalled();
            expect(mockConnectionDetector.init).toHaveBeenCalled();
        });

        it('should only initialize once', async () => {
            await manager.init({ userId: 'user-123' });
            await manager.init({ userId: 'user-123' });

            expect(mockIndexedDBManager.init).toHaveBeenCalledTimes(1);
        });
    });

    describe('destroy', () => {
        it('should clean up resources', async () => {
            await manager.init({ userId: 'user-123' });
            manager.destroy();

            expect(mockConnectionDetector.destroy).toHaveBeenCalled();
        });

        it('should be safe to call multiple times', async () => {
            await manager.init({ userId: 'user-123' });
            manager.destroy();
            expect(() => manager.destroy()).not.toThrow();
        });
    });

    describe('getStatus', () => {
        it('should return current status', async () => {
            await manager.init({ userId: 'user-123' });

            const status = manager.getStatus();
            expect(['idle', 'syncing', 'error', 'offline']).toContain(status);
        });
    });

    describe('onStatusChange', () => {
        it('should return unsubscribe function', async () => {
            await manager.init({ userId: 'user-123' });

            const callback = vi.fn();
            const unsubscribe = manager.onStatusChange(callback);

            expect(typeof unsubscribe).toBe('function');
        });
    });

    describe('sync', () => {
        it('should throw if not initialized', async () => {
            await expect(manager.sync()).rejects.toThrow();
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
        it('should add file to sync queue', async () => {
            await manager.init({ userId: 'user-123' });

            expect(() => manager.queueSync('file-1')).not.toThrow();
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
});
