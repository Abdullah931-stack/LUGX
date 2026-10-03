/**
 * Comprehensive Concurrency, Lean CAS, and Coalescing Test Suite
 *
 * Verifies:
 * - Lean CAS concurrency control in IndexedDB via localRevision counter.
 * - Elimination of in-flight lost updates when local edits occur while sync is active.
 * - Strict coalescing invariants (only 'queued' operations, never 'syncing' or terminal states).
 * - Preservation of local mutations on push network failure (elimination of destructive rollback).
 *
 * Remediates: LUGX-003, LUGX-010, LUGX-011, LUGX-013, LUGX-040
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createIndexedDBManager, IndexedDBManager } from '@/lib/sync/indexeddb';
import { canCoalesce, coalesceOperations } from '@/lib/sync/coalescing';
import { createSyncManager, SyncManager } from '@/lib/sync/sync-manager';
import { connectionDetector } from '@/lib/sync/connection-detector';
import { IDBFile, IDBOperation } from '@/lib/sync/idb-types';
import 'fake-indexeddb/auto';

describe('Phase 14: Local Sync Queue & Atomic CAS with localRevision', () => {
    const TEST_USER_ID = 'test-user-cas-14';
    let idb: IndexedDBManager;

    beforeEach(async () => {
        idb = createIndexedDBManager(TEST_USER_ID);
        await idb.init();
    });

    afterEach(async () => {
        idb.close();
        vi.restoreAllMocks();
    });

    describe('Coalescing Module (src/lib/sync/coalescing.ts)', () => {
        it('should allow coalescing for identical fileId in queued status with compatible operations', () => {
            const op1: IDBOperation = {
                id: 'op-1',
                fileId: 'file-1',
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 1',
                timestamp: 1000,
                localRevision: 1,
            };

            const op2: IDBOperation = {
                id: 'op-2',
                fileId: 'file-1',
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 2',
                timestamp: 2000,
                localRevision: 2,
            };

            expect(canCoalesce(op1, op2)).toBe(true);
        });

        it('should strictly prohibit coalescing when existing operation is in syncing status (LUGX-010)', () => {
            const inFlightOp: IDBOperation = {
                id: 'op-in-flight',
                fileId: 'file-1',
                status: 'syncing',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 1',
                timestamp: 1000,
                localRevision: 1,
            };

            const incomingOp: IDBOperation = {
                id: 'op-new',
                fileId: 'file-1',
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 2',
                timestamp: 2000,
                localRevision: 2,
            };

            expect(canCoalesce(inFlightOp, incomingOp)).toBe(false);
        });

        it('should strictly prohibit coalescing when existing operation is in terminal or conflict status (LUGX-040)', () => {
            const baseOp: IDBOperation = {
                id: 'op-terminal',
                fileId: 'file-1',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 1',
                timestamp: 1000,
                localRevision: 1,
            };

            const incomingOp: IDBOperation = {
                id: 'op-new',
                fileId: 'file-1',
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'edit 2',
                timestamp: 2000,
                localRevision: 2,
            };

            expect(canCoalesce({ ...baseOp, status: 'conflict' }, incomingOp)).toBe(false);
            expect(canCoalesce({ ...baseOp, status: 'failed' }, incomingOp)).toBe(false);
            expect(canCoalesce({ ...baseOp, status: 'dead_letter' }, incomingOp)).toBe(false);
            expect(canCoalesce({ ...baseOp, status: 'synced', synced: true }, incomingOp)).toBe(false);
        });

        it('should merge operations, advancing localRevision and resetting retry backoff', () => {
            const op1: IDBOperation = {
                id: 'op-1',
                fileId: 'file-1',
                baseVersion: 3,
                status: 'queued',
                synced: false,
                attempts: 2,
                nextRetryAt: 50000,
                lastError: 'Temporary network timeout',
                operationType: 'update',
                position: 0,
                content: 'initial draft',
                timestamp: 1000,
                localRevision: 4,
            };

            const op2: IDBOperation = {
                id: 'op-2',
                fileId: 'file-1',
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'latest revised text',
                timestamp: 2000,
                localRevision: 5,
            };

            const merged = coalesceOperations(op1, op2);

            expect(merged.id).toBe('op-1');
            expect(merged.baseVersion).toBe(3);
            expect(merged.content).toBe('latest revised text');
            expect(merged.localRevision).toBe(5);
            expect(merged.status).toBe('queued');
            expect(merged.attempts).toBe(0);
            expect(merged.nextRetryAt).toBeUndefined();
            expect(merged.lastError).toBeUndefined();
        });
    });

    describe('Lean CAS Concurrency Control in IndexedDB', () => {
        it('should atomically mark file clean when sentRevision matches current localRevision', async () => {
            const file: IDBFile = {
                id: 'file-cas-clean',
                title: 'Clean Doc',
                content: 'Confirmed Version Content',
                etag: 'etag-old',
                version: 1,
                localRevision: 3,
                isDirty: true,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            };
            await idb.saveFile(file);

            const op: IDBOperation = {
                id: 'op-cas-clean',
                fileId: 'file-cas-clean',
                baseVersion: 1,
                localRevision: 3,
                status: 'syncing',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'Confirmed Version Content',
                timestamp: Date.now(),
            };
            await idb.addOperation(op);

            // Server completes push for sentRevision = 3
            await idb.commitFileAndOperationSync(
                file.id,
                'etag-confirmed-2',
                op.id,
                1,
                2, // newVersion
                3  // sentRevision === file.localRevision
            );

            const updatedFile = await idb.getFile(file.id);
            expect(updatedFile).toBeDefined();
            expect(updatedFile!.isDirty).toBe(false);
            expect(updatedFile!.version).toBe(2);
            expect(updatedFile!.etag).toBe('etag-confirmed-2');
            expect(updatedFile!.baseSnapshot?.etag).toBe('etag-confirmed-2');
            expect(updatedFile!.baseSnapshot?.version).toBe(2);

            const updatedOp = await idb.getOperation(op.id);
            expect(updatedOp!.status).toBe('synced');
            expect(updatedOp!.synced).toBe(true);
            expect(updatedOp!.sentRevision).toBe(3);
        });

        it('should preserve isDirty = true and retain newer edits when localRevision > sentRevision (LUGX-010)', async () => {
            // Step 1: File created and sent at localRevision = 1
            const file: IDBFile = {
                id: 'file-cas-lost-update',
                title: 'Concurrency Doc',
                content: 'v1 in flight',
                etag: 'etag-v0',
                version: 1,
                localRevision: 1,
                isDirty: true,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now() - 1000,
                lastSyncedAt: 0,
            };
            await idb.saveFile(file);

            const op1: IDBOperation = {
                id: 'op-in-flight-v1',
                fileId: file.id,
                baseVersion: 1,
                localRevision: 1,
                status: 'syncing',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'v1 in flight',
                timestamp: Date.now() - 1000,
            };
            await idb.addOperation(op1);

            // Step 2: While v1 is in flight across the network, user saves v2 locally
            const fileV2: IDBFile = {
                ...file,
                content: 'v2 modified while in flight',
                localRevision: 2, // Incremented local revision
                isDirty: true,
                lastModified: Date.now(),
            };
            await idb.saveFile(fileV2);

            // Step 3: Server responds with 200 OK for the v1 push (sentRevision = 1)
            await idb.commitFileAndOperationSync(
                file.id,
                'etag-server-v1',
                op1.id,
                1,
                2, // new server version
                1  // sentRevision: was 1, but localRevision is now 2
            );

            // Step 4: Verify Lean CAS protected the in-flight modification
            const committedFile = await idb.getFile(file.id);
            expect(committedFile).toBeDefined();
            // Crucial Invariant: File MUST remain dirty so v2 will be pushed
            expect(committedFile!.isDirty).toBe(true);
            // File content MUST remain v2
            expect(committedFile!.content).toBe('v2 modified while in flight');
            // Server version metadata is updated so subsequent push uses expectedVersion = 2
            expect(committedFile!.version).toBe(2);
            // Local revision remains at 2
            expect(committedFile!.localRevision).toBe(2);

            // The in-flight op1 is acknowledged as synced on the server
            const syncedOp1 = await idb.getOperation(op1.id);
            expect(syncedOp1!.status).toBe('synced');
            expect(syncedOp1!.synced).toBe(true);
            expect(syncedOp1!.sentRevision).toBe(1);

            // Step 5: Check that the file is still picked up by getDirtyFiles()
            const dirtyFiles = await idb.getDirtyFiles();
            expect(dirtyFiles.some(f => f.id === file.id)).toBe(true);
        });

        it('should guard markFileClean with Lean CAS against in-flight local modifications', async () => {
            const file: IDBFile = {
                id: 'file-mark-clean-cas',
                title: 'Mark Clean Doc',
                content: 'local modification v3',
                etag: 'etag-initial',
                version: 1,
                localRevision: 3,
                isDirty: true,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            };
            await idb.saveFile(file);

            // Dispatched with sentRevision = 2 (older than current localRevision 3)
            await idb.markFileClean(file.id, 'etag-remote-2', 2, 2);

            const reloaded = await idb.getFile(file.id);
            expect(reloaded).toBeDefined();
            expect(reloaded!.isDirty).toBe(true);
            expect(reloaded!.content).toBe('local modification v3');
            expect(reloaded!.version).toBe(2);

            // When confirmed with sentRevision = 3 (matches current localRevision)
            await idb.markFileClean(file.id, 'etag-remote-3', 3, 3);
            const cleanReloaded = await idb.getFile(file.id);
            expect(cleanReloaded!.isDirty).toBe(false);
            expect(cleanReloaded!.version).toBe(3);
        });
    });

    describe('SyncManager End-to-End In-Flight Concurrency & Error Resilience', () => {
        let manager: SyncManager;

        beforeEach(() => {
            vi.spyOn(connectionDetector, 'isOnline').mockReturnValue(true);
            manager = createSyncManager({
                userId: TEST_USER_ID,
                idb,
                autoSyncInterval: 0,
            });
        });

        afterEach(async () => {
            await manager.destroy();
        });

        it('should preserve dirty state and not rollback on push network errors (LUGX-013)', async () => {
            const file: IDBFile = {
                id: 'file-network-error',
                title: 'Network Error File',
                content: 'Fresh unsaved work that must not be wiped',
                etag: 'etag-v1',
                version: 1,
                localRevision: 2,
                isDirty: true,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            };
            await idb.saveFile(file);

            const op: IDBOperation = {
                id: 'op-network-error',
                fileId: file.id,
                baseVersion: 1,
                localRevision: 2,
                status: 'queued',
                synced: false,
                attempts: 0,
                operationType: 'update',
                position: 0,
                content: file.content,
                timestamp: Date.now(),
            };
            await idb.addOperation(op);

            // Simulate network drop during fetch
            const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch (offline)'));
            global.fetch = fetchMock;

            await manager.init({ userId: TEST_USER_ID, idb, autoSyncInterval: 0 });
            const result = await manager.processOperationsQueue();

            expect(result.failed).toBe(1);

            // Verify file local content is intact and still marked dirty
            const storedFile = await idb.getFile(file.id);
            expect(storedFile).toBeDefined();
            expect(storedFile!.isDirty).toBe(true);
            expect(storedFile!.content).toBe('Fresh unsaved work that must not be wiped');

            // Verify operation is scheduled for retry with backoff, not wiped
            const storedOp = await idb.getOperation(op.id);
            expect(storedOp!.status).toBe('failed');
            expect(storedOp!.attempts).toBe(1);
            expect(storedOp!.nextRetryAt).toBeGreaterThan(Date.now());
        });

        it('should handle in-flight modification during live SyncManager execution', async () => {
            const fileId = 'file-live-race';
            const initialFile: IDBFile = {
                id: fileId,
                title: 'Live Race Doc',
                content: 'v1 initial content',
                etag: 'etag-0',
                version: 1,
                localRevision: 1,
                isDirty: true,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            };
            await idb.saveFile(initialFile);

            const op1: IDBOperation = {
                id: 'op-live-1',
                fileId,
                baseVersion: 1,
                localRevision: 1,
                status: 'queued',
                synced: false,
                operationType: 'update',
                position: 0,
                content: 'v1 initial content',
                timestamp: Date.now(),
            };
            await idb.addOperation(op1);

            // Intercept fetch: when PUT /api/files/:id is called for v1, simulate user saving v2 before network responds
            const fetchMock = vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
                if (url.includes(`/api/files/${fileId}`) && opts.method === 'PUT') {
                    // Simulate concurrent user edit saved in IDB while the HTTP request is in-flight
                    const current = await idb.getFile(fileId);
                    if (current) {
                        await idb.saveFile({
                            ...current,
                            content: 'v2 typed during flight',
                            localRevision: 2,
                            isDirty: true,
                            lastModified: Date.now(),
                        });
                    }

                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            success: true,
                            etag: 'etag-server-v1',
                            version: 2,
                        }),
                    };
                }
                return { ok: false, status: 404, json: async () => ({}) };
            });
            global.fetch = fetchMock;

            await manager.init({ userId: TEST_USER_ID, idb, autoSyncInterval: 0 });
            const queueResult = await manager.processOperationsQueue();

            expect(queueResult.succeeded).toBe(1);

            // File in IDB MUST still be dirty because localRevision (2) > sentRevision (1)
            const postSyncFile = await idb.getFile(fileId);
            expect(postSyncFile).toBeDefined();
            expect(postSyncFile!.isDirty).toBe(true);
            expect(postSyncFile!.content).toBe('v2 typed during flight');
            expect(postSyncFile!.version).toBe(2);
            expect(postSyncFile!.localRevision).toBe(2);
        });
    });
});
