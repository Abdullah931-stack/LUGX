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

    it('should never delete syncing, conflict, rollback_failed, or queued operations even if old', async () => {
        const fileId = 'file-gc-protected';
        const testFile: IDBFile = {
            id: fileId,
            content: 'protected content',
            title: 'Protected Test',
            etag: 'etag-prot',
            version: 1,
            lastModified: Date.now(),
            lastSyncedAt: Date.now(),
            isDirty: false,
            parentFolderId: null,
            isFolder: false,
        };
        await idbManager.saveFile(testFile);

        const oldTimestamp = 1000; // Very old timestamp

        // 1. Syncing operation (in-flight)
        await idbManager.addOperation({
            id: 'op-syncing',
            operationId: 'op-syncing',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'syncing',
            timestamp: oldTimestamp,
            synced: false,
            status: 'syncing',
        });

        // 2. Conflict operation (unresolved)
        await idbManager.addOperation({
            id: 'op-conflict',
            operationId: 'op-conflict',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'conflict',
            timestamp: oldTimestamp,
            synced: false,
            status: 'conflict',
        });

        // 3. Rollback failed operation (forensic protection)
        await idbManager.addOperation({
            id: 'op-rb-failed',
            operationId: 'op-rb-failed',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'rollback_failed',
            timestamp: oldTimestamp,
            synced: false,
            status: 'rollback_failed',
        });

        // 4. Queued operation (pending)
        await idbManager.addOperation({
            id: 'op-queued',
            operationId: 'op-queued',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'queued',
            timestamp: oldTimestamp,
            synced: false,
            status: 'queued',
        });

        // 5. Old synced operation (eligible for deletion)
        await idbManager.addOperation({
            id: 'op-old-synced',
            operationId: 'op-old-synced',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'synced',
            timestamp: oldTimestamp,
            synced: true,
            status: 'synced',
        });

        // 6. Old dead_letter operation (eligible for deletion)
        await idbManager.addOperation({
            id: 'op-dead-letter',
            operationId: 'op-dead-letter',
            fileId,
            operationType: 'update',
            position: 0,
            content: 'dead',
            timestamp: oldTimestamp,
            synced: false,
            status: 'dead_letter',
        });

        // Run GC with future clock (now = 1,000,000)
        const result = await gc.run(true, 1000000);

        // Expect exactly 2 operations deleted (synced & dead_letter)
        expect(result.operationsDeleted).toBe(2);

        const remainingOps = await idbManager.getOperations(fileId);
        const remainingIds = remainingOps.map(o => o.id);

        expect(remainingIds).toContain('op-syncing');
        expect(remainingIds).toContain('op-conflict');
        expect(remainingIds).toContain('op-rb-failed');
        expect(remainingIds).toContain('op-queued');
        expect(remainingIds).not.toContain('op-old-synced');
        expect(remainingIds).not.toContain('op-dead-letter');
    });

    it('should support controllable clock injection via setClock', async () => {
        let simulatedTime = 10000;
        gc.setClock(() => simulatedTime);

        const fileId = 'file-clock-test';
        await idbManager.saveFile({
            id: fileId,
            content: 'clock',
            title: 'Clock',
            etag: 'etag-c',
            version: 1,
            lastModified: 0,
            lastSyncedAt: 0,
            isDirty: false,
            parentFolderId: null,
            isFolder: false,
        });

        await idbManager.addOperation({
            id: 'op-clock-1',
            fileId,
            operationType: 'insert',
            position: 0,
            content: 'a',
            timestamp: 9500, // 500ms old at t=10000 (within 1000ms maxAge)
            synced: true,
            status: 'synced',
        });

        // At t=10000, op is 500ms old -> should NOT be deleted
        const result1 = await gc.run(true);
        expect(result1.operationsDeleted).toBe(0);

        // Advance time to t=12000 (op is 2500ms old -> exceeds 1000ms maxAge)
        simulatedTime = 12000;
        const result2 = await gc.run(true);
        expect(result2.operationsDeleted).toBe(1);
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
