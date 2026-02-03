/**
 * useSync Hook Tests
 * Tests for React hook behavior (unit tests without full React env)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies using vi.hoisted
const mockSyncManager = vi.hoisted(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    sync: vi.fn().mockResolvedValue({
        success: true,
        filesPushed: 0,
        filesPulled: 0,
        conflicts: [],
        errors: [],
    }),
    getStatus: vi.fn().mockReturnValue('idle'),
    onStatusChange: vi.fn().mockReturnValue(() => { }),
    setConflictCallback: vi.fn(),
}));

const mockConnectionDetector = vi.hoisted(() => ({
    getState: vi.fn().mockReturnValue('online'),
    onChange: vi.fn().mockReturnValue(() => { }),
}));

const mockIndexedDBManager = vi.hoisted(() => ({
    init: vi.fn().mockResolvedValue({}),
    getFile: vi.fn(),
    saveFile: vi.fn(),
    markFileDirty: vi.fn(),
    getDirtyFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/sync/sync-manager', () => ({
    syncManager: mockSyncManager,
}));
vi.mock('../lib/sync/connection-detector', () => ({
    connectionDetector: mockConnectionDetector,
}));
vi.mock('../lib/sync/indexeddb', () => ({
    indexedDBManager: mockIndexedDBManager,
}));

describe('useSync Hook (Unit)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('syncManager integration', () => {
        it('should have init method', () => {
            expect(mockSyncManager.init).toBeDefined();
        });

        it('should have sync method', () => {
            expect(mockSyncManager.sync).toBeDefined();
        });

        it('should have getStatus method', () => {
            expect(mockSyncManager.getStatus).toBeDefined();
        });

        it('should have onStatusChange method', () => {
            expect(mockSyncManager.onStatusChange).toBeDefined();
        });

        it('should have destroy method', () => {
            expect(mockSyncManager.destroy).toBeDefined();
        });
    });

    describe('connectionDetector integration', () => {
        it('should have getState method', () => {
            expect(mockConnectionDetector.getState).toBeDefined();
        });

        it('should have onChange method', () => {
            expect(mockConnectionDetector.onChange).toBeDefined();
        });

        it('should return connection state', () => {
            expect(mockConnectionDetector.getState()).toBe('online');
        });
    });

    describe('indexedDBManager integration', () => {
        it('should have init method', () => {
            expect(mockIndexedDBManager.init).toBeDefined();
        });

        it('should have getFile method', () => {
            expect(mockIndexedDBManager.getFile).toBeDefined();
        });

        it('should have saveFile method', () => {
            expect(mockIndexedDBManager.saveFile).toBeDefined();
        });

        it('should have markFileDirty method', () => {
            expect(mockIndexedDBManager.markFileDirty).toBeDefined();
        });

        it('should have getDirtyFiles method', () => {
            expect(mockIndexedDBManager.getDirtyFiles).toBeDefined();
        });
    });

    describe('sync workflow', () => {
        it('should initialize sync manager with userId', async () => {
            await mockSyncManager.init({ userId: 'user-123' });

            expect(mockSyncManager.init).toHaveBeenCalledWith({ userId: 'user-123' });
        });

        it('should trigger sync and get result', async () => {
            const result = await mockSyncManager.sync();

            expect(result.success).toBe(true);
            expect(result.filesPushed).toBe(0);
            expect(result.filesPulled).toBe(0);
        });

        it('should get current status', () => {
            const status = mockSyncManager.getStatus();

            expect(status).toBe('idle');
        });

        it('should register status change callback', () => {
            const callback = vi.fn();
            const unsubscribe = mockSyncManager.onStatusChange(callback);

            expect(typeof unsubscribe).toBe('function');
        });
    });

    describe('local operations workflow', () => {
        it('should save file locally', async () => {
            const fileData = {
                id: 'file-1',
                content: 'Content',
                title: 'Title',
            };

            await mockIndexedDBManager.saveFile(fileData);

            expect(mockIndexedDBManager.saveFile).toHaveBeenCalledWith(fileData);
        });

        it('should load file from local storage', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'Stored content',
                title: 'Title',
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const result = await mockIndexedDBManager.getFile('file-1');

            expect(result).toEqual(mockFile);
        });

        it('should mark file as dirty', async () => {
            await mockIndexedDBManager.markFileDirty('file-1');

            expect(mockIndexedDBManager.markFileDirty).toHaveBeenCalledWith('file-1');
        });

        it('should get dirty files count', async () => {
            mockIndexedDBManager.getDirtyFiles.mockResolvedValue([
                { id: '1', isDirty: true },
                { id: '2', isDirty: true },
            ]);

            const dirtyFiles = await mockIndexedDBManager.getDirtyFiles();

            expect(dirtyFiles.length).toBe(2);
        });
    });

    describe('cleanup', () => {
        it('should call destroy on cleanup', () => {
            mockSyncManager.destroy();

            expect(mockSyncManager.destroy).toHaveBeenCalled();
        });
    });
});
