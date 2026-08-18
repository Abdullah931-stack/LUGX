import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createIndexedDBManager, IndexedDBManager } from './indexeddb';
import { createOperationsGC, OperationsGarbageCollector } from './operations-gc';
import { IDBOperation, IDBFile } from './idb-types';

describe('OperationsGarbageCollector Integration Tests', () => {
    let idbManager: IndexedDBManager;
    let gc: OperationsGarbageCollector;
    const testUserId = 'test-gc-user';

    beforeEach(async () => {
        idbManager = createIndexedDBManager(testUserId);
        await idbManager.init(testUserId);
        gc = createOperationsGC(idbManager, {
            maxOperationAgeMs: 1000, // 1 second for fast testing
            maxOperationsPerFile: 4,
            minGCIntervalMs: 0, // allow immediate consecutive runs in tests
            aggressiveGCThreshold: 0.8,
        });
    });

    afterEach(async () => {
        gc.cleanup();
        await idbManager.deleteDatabase();
        idbManager.close();
    });

    it('should delete old synced operations during garbage collection', async () => {
        const fileId = 'file-gc-1';
        const testFile: IDBFile = {
            id: fileId,
            content: 'test content',
            title: 'GC Test',
            etag: 'etag-1',
            version: 1,
            lastModified: Date.now(),
            lastSyncedAt: Date.now(),
            isDirty: false,
            parentFolderId: null,
            isFolder: false,
        };
        await idbManager.saveFile(testFile);

        const oldTimestamp = Date.now() - 5000; // 5 seconds old (exceeds 1s maxAge)
        const recentTimestamp = Date.now();

        // 1. Old synced operation (should be deleted)
        const op1: IDBOperation = {
            id: 'op-1',
            fileId,
            operationType: 'insert',
            position: 0,
            content: 'a',
            timestamp: oldTimestamp,
            synced: true,
        };

        // 2. Old unsynced operation (should NOT be deleted because unsynced)
        const op2: IDBOperation = {
            id: 'op-2',
            fileId,
            operationType: 'insert',
            position: 1,
            content: 'b',
            timestamp: oldTimestamp,
            synced: false,
        };

        // 3. Recent synced operation (should NOT be deleted because recent)
        const op3: IDBOperation = {
            id: 'op-3',
            fileId,
            operationType: 'insert',
            position: 2,
            content: 'c',
            timestamp: recentTimestamp,
            synced: true,
        };

        await idbManager.addOperation(op1);
        await idbManager.addOperation(op2);
        await idbManager.addOperation(op3);

        const beforeOps = await idbManager.getOperations(fileId);
        expect(beforeOps.length).toBe(3);

        // Run GC
        const result = await gc.run(true);

        expect(result.operationsDeleted).toBe(1);

        const afterOps = await idbManager.getOperations(fileId);
        expect(afterOps.length).toBe(2);
        expect(afterOps.find(op => op.id === 'op-1')).toBeUndefined();
        expect(afterOps.find(op => op.id === 'op-2')).toBeDefined();
        expect(afterOps.find(op => op.id === 'op-3')).toBeDefined();
    });

    it('should compact operations when a file exceeds maxOperationsPerFile limit', async () => {
        const fileId = 'file-gc-compact';
        const testFile: IDBFile = {
            id: fileId,
            content: 'compact test',
            title: 'Compact Test',
            etag: 'etag-2',
            version: 1,
            lastModified: Date.now(),
            lastSyncedAt: Date.now(),
            isDirty: false,
            parentFolderId: null,
            isFolder: false,
        };
        await idbManager.saveFile(testFile);

        // Add 6 recent synced operations (max limit is 4)
        for (let i = 1; i <= 6; i++) {
            await idbManager.addOperation({
                id: `op-compact-${i}`,
                fileId,
                operationType: 'insert',
                position: i,
                content: `change-${i}`,
                timestamp: Date.now() + i,
                synced: true,
            });
        }

        const initialOps = await idbManager.getOperations(fileId);
        expect(initialOps.length).toBe(6);

        // Run GC to compact
        const result = await gc.run(true);

        expect(result.filesCompacted).toBe(1);

        const compactedOps = await idbManager.getOperations(fileId);
        // Half of maxOperationsPerFile = 2 recent synced operations kept
        expect(compactedOps.length).toBe(2);
        // Should keep the most recent ones (5 and 6)
        expect(compactedOps.map(o => o.id)).toContain('op-compact-6');
        expect(compactedOps.map(o => o.id)).toContain('op-compact-5');
    });

    it('should schedule and cleanup timers reliably without leaking', () => {
        vi.useFakeTimers();

        const stopSchedule = gc.schedule(1000);
        expect(typeof stopSchedule).toBe('function');

        // Stop schedule
        stopSchedule();

        // Cleanup
        gc.cleanup();
        expect(gc.isGCRunning()).toBe(false);

        vi.useRealTimers();
    });
});
