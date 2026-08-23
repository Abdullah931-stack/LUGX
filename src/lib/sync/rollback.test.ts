/**
 * Rollback Manager Tests
 * Tests for checkpoint creation and rollback functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mocks are created before imports
const mockIndexedDBManager = vi.hoisted(() => ({
    getFile: vi.fn(),
    saveFile: vi.fn(),
    getOperation: vi.fn().mockResolvedValue(undefined),
    updateOperationStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./indexeddb', () => ({
    indexedDBManager: mockIndexedDBManager,
}));

import { SyncRollback, createSyncRollback } from './rollback';
import { IDBOperation } from './idb-types';

describe('Sync Rollback', () => {
    let rollback: SyncRollback;

    beforeEach(() => {
        vi.clearAllMocks();
        rollback = new SyncRollback();
        rollback.clearAll(); // Clear checkpoints between tests
    });

    describe('createCheckpoint', () => {
        it('should create checkpoint and return ID', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'Original content',
                title: 'Test File',
                etag: 'abc123',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');

            expect(checkpointId).toBeDefined();
            expect(typeof checkpointId).toBe('string');
            expect(checkpointId.length).toBeGreaterThan(0);
        });

        it('should store file state at checkpoint time', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'Content at checkpoint',
                title: 'Title',
                etag: 'etag123',
                version: 5,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');

            // Verify checkpoint stores the file state
            const checkpoint = rollback.getCheckpoint(checkpointId);
            expect(checkpoint).toBeDefined();
            expect(checkpoint?.content).toBe('Content at checkpoint');
        });

        it('should throw for non-existent file', async () => {
            mockIndexedDBManager.getFile.mockResolvedValue(undefined);

            await expect(rollback.createCheckpoint('non-existent', 'pre_sync'))
                .rejects.toThrow('Cannot create checkpoint');
        });

        it('should create unique IDs for each checkpoint', async () => {
            mockIndexedDBManager.getFile.mockResolvedValue({
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            });

            const id1 = await rollback.createCheckpoint('file-1', 'pre_sync');

            // Wait a tiny bit to ensure different timestamp
            await new Promise(r => setTimeout(r, 1));

            const id2 = await rollback.createCheckpoint('file-1', 'pre_sync');

            expect(id1).not.toBe(id2);
        });
    });

    describe('rollback', () => {
        it('should restore file to checkpoint state', async () => {
            const originalFile = {
                id: 'file-1',
                content: 'Original content',
                title: 'Original Title',
                etag: 'original-etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(originalFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');

            // File was modified after checkpoint
            mockIndexedDBManager.getFile.mockResolvedValue({
                ...originalFile,
                content: 'Modified content',
            });

            const result = await rollback.rollback(checkpointId);

            expect(result).toBe(true);
            expect(mockIndexedDBManager.saveFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'Original content',
                })
            );
        });

        it('should return false for invalid checkpoint ID', async () => {
            const result = await rollback.rollback('invalid-id');
            expect(result).toBe(false);
        });

        it('should remove checkpoint after rollback', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');
            await rollback.rollback(checkpointId);

            // Checkpoint should be removed
            expect(rollback.getCheckpoint(checkpointId)).toBeUndefined();
        });
    });

    describe('removeCheckpoint', () => {
        it('should remove checkpoint without throwing', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');

            expect(() => rollback.removeCheckpoint(checkpointId)).not.toThrow();
            expect(rollback.getCheckpoint(checkpointId)).toBeUndefined();
        });

        it('should be safe to call with invalid ID', () => {
            expect(() => rollback.removeCheckpoint('invalid-id')).not.toThrow();
        });
    });

    describe('getCheckpoint', () => {
        it('should return checkpoint data', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'test content',
                title: 'Test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            const checkpointId = await rollback.createCheckpoint('file-1', 'pre_sync');
            const checkpoint = rollback.getCheckpoint(checkpointId);

            expect(checkpoint).toBeDefined();
            expect(checkpoint?.reason).toBe('pre_sync');
        });

        it('should return undefined for invalid ID', () => {
            const checkpoint = rollback.getCheckpoint('invalid-id');
            expect(checkpoint).toBeUndefined();
        });
    });

    describe('getFileCheckpoints', () => {
        it('should return all checkpoints for a file', async () => {
            // Clear first to ensure clean state
            rollback.clearAll();

            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            await rollback.createCheckpoint('file-1', 'pre_sync');
            await new Promise(r => setTimeout(r, 1));
            await rollback.createCheckpoint('file-1', 'pre_merge');

            const checkpoints = rollback.getFileCheckpoints('file-1');

            expect(checkpoints.length).toBeGreaterThanOrEqual(2);
        });

        it('should return empty array when no checkpoints', () => {
            const checkpoints = rollback.getFileCheckpoints('file-1');
            expect(checkpoints).toEqual([]);
        });
    });

    describe('getLatestCheckpoint', () => {
        it('should return the most recent checkpoint', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            await rollback.createCheckpoint('file-1', 'pre_sync');
            await new Promise(r => setTimeout(r, 10));

            mockIndexedDBManager.getFile.mockResolvedValue({
                ...mockFile,
                content: 'newer content',
            });
            await rollback.createCheckpoint('file-1', 'pre_merge');

            const latest = rollback.getLatestCheckpoint('file-1');

            expect(latest).toBeDefined();
            expect(latest?.content).toBe('newer content');
        });

        it('should return undefined when no checkpoints', () => {
            const latest = rollback.getLatestCheckpoint('file-1');
            expect(latest).toBeUndefined();
        });
    });

    describe('clearAll', () => {
        it('should remove all checkpoints', async () => {
            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            await rollback.createCheckpoint('file-1', 'pre_sync');
            await rollback.createCheckpoint('file-1', 'pre_merge');

            rollback.clearAll();

            expect(rollback.getCount()).toBe(0);
        });
    });

    describe('getCount', () => {
        it('should return correct count', async () => {
            expect(rollback.getCount()).toBe(0);

            const mockFile = {
                id: 'file-1',
                content: 'test',
                etag: 'etag',
                version: 1,
            };
            mockIndexedDBManager.getFile.mockResolvedValue(mockFile);

            await rollback.createCheckpoint('file-1', 'pre_sync');
            expect(rollback.getCount()).toBe(1);

            // Wait to ensure different timestamp (and thus different ID)
            await new Promise(r => setTimeout(r, 5));

            await rollback.createCheckpoint('file-1', 'pre_merge');
            expect(rollback.getCount()).toBe(2);
        });
    });

    describe('Phase 2 Operation Rollback & Failure Isolation', () => {
        it('should record rollback_failed in IDB when rollback fails for an operation', async () => {
            const result = await rollback.rollback('non-existent-cp', 'op-fail-1');

            expect(result).toBe(false);
            expect(mockIndexedDBManager.updateOperationStatus).toHaveBeenCalledWith(
                'op-fail-1',
                'rollback_failed',
                expect.objectContaining({ lastError: expect.stringContaining('not found') })
            );
        });

        it('should rollback directly from IDBOperation snapshot successfully', async () => {
            const operation: IDBOperation = {
                id: 'op-snap-1',
                operationId: 'op-snap-1',
                fileId: 'file-1',
                operationType: 'update',
                position: 0,
                content: 'new content',
                timestamp: Date.now(),
                synced: false,
                snapshot: {
                    content: 'snapshot original content',
                    etag: 'etag-orig',
                    version: 1,
                },
            };

            mockIndexedDBManager.getFile.mockResolvedValue({
                id: 'file-1',
                content: 'modified content',
                etag: 'etag-mod',
                version: 2,
            });

            const result = await rollback.rollbackOperation(operation);

            expect(result).toBe(true);
            expect(mockIndexedDBManager.saveFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'file-1',
                    content: 'snapshot original content',
                    etag: 'etag-orig',
                    version: 1,
                    isDirty: true,
                })
            );
        });

        it('should mark rollback_failed when operation has no snapshot', async () => {
            const operation: IDBOperation = {
                id: 'op-no-snap',
                operationId: 'op-no-snap',
                fileId: 'file-1',
                operationType: 'update',
                position: 0,
                content: 'content',
                timestamp: Date.now(),
                synced: false,
            };

            const result = await rollback.rollbackOperation(operation);

            expect(result).toBe(false);
            expect(mockIndexedDBManager.updateOperationStatus).toHaveBeenCalledWith(
                'op-no-snap',
                'rollback_failed',
                expect.objectContaining({ lastError: expect.stringContaining('no snapshot') })
            );
        });

        it('should fallback to IDBOperation snapshot when in-memory checkpoint is missing after restart', async () => {
            mockIndexedDBManager.getOperation.mockResolvedValueOnce({
                id: 'op-after-crash',
                operationId: 'op-after-crash',
                fileId: 'file-crash-recovered',
                operationType: 'update',
                position: 0,
                content: 'new crashed content',
                timestamp: Date.now(),
                synced: false,
                snapshot: {
                    content: 'pre-crash snapshot content',
                    etag: 'etag-pre-crash',
                    version: 1,
                },
            });

            mockIndexedDBManager.getFile.mockResolvedValueOnce({
                id: 'file-crash-recovered',
                content: 'dirty post-crash',
                etag: 'etag-dirty',
                version: 2,
            });

            // checkpoint-vanished is NOT in memory
            const result = await rollback.rollback('checkpoint-vanished', 'op-after-crash');

            expect(result).toBe(true);
            expect(mockIndexedDBManager.saveFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'file-crash-recovered',
                    content: 'pre-crash snapshot content',
                    etag: 'etag-pre-crash',
                    version: 1,
                    isDirty: true,
                })
            );
        });

        it('should support injected IndexedDBManager instance via createSyncRollback', async () => {
            const customIdb = {
                getFile: vi.fn().mockResolvedValue({
                    id: 'custom-file',
                    content: 'custom',
                    etag: 'c-etag',
                    version: 1,
                }),
                saveFile: vi.fn().mockResolvedValue(undefined),
                updateOperationStatus: vi.fn().mockResolvedValue(undefined),
                getOperation: vi.fn().mockResolvedValue(undefined),
            };

            const customRollback = createSyncRollback(customIdb as any);
            const cpId = await customRollback.createCheckpoint('custom-file', 'pre_sync');

            expect(cpId).toBeDefined();
            expect(customIdb.getFile).toHaveBeenCalledWith('custom-file');
        });
    });
});
