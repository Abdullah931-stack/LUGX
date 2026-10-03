/**
 * Phase 15 Acceptance Tests: Durable Conflict Quarantine in IndexedDB
 * 
 * Verifies:
 * 1. Conflict state persists in IndexedDB across database reload/browser restart.
 * 2. pullFile strictly refuses to overwrite or delete files in durable conflict quarantine.
 * 3. Tombstone pull cannot delete a file in conflict quarantine.
 * 4. Resolving conflict via conflictStore cleans quarantine and updates file appropriately.
 * 
 * Remediates: LUGX-003, LUGX-010, LUGX-089, LUGX-101
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIndexedDBManager, IndexedDBManager } from '@/lib/sync/indexeddb';
import { ConflictStore } from '@/lib/idb/conflict-store';
import { SyncManager } from '@/lib/sync/sync-manager';
import { IDBFile } from '@/lib/sync/idb-types';

describe('Phase 15: Durable Conflict Quarantine in IndexedDB', () => {
    let testUserId: string;
    let idb: IndexedDBManager;
    let conflictStore: ConflictStore;

    beforeEach(async () => {
        testUserId = `test_user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        idb = createIndexedDBManager(testUserId);
        await idb.init(testUserId);
        conflictStore = new ConflictStore(idb);
    });

    afterEach(async () => {
        try {
            await idb.deleteDatabase();
        } catch {}
    });

    it('should persist conflict state in IndexedDB across database reloads/re-openings', async () => {
        const fileId = 'file_conflict_durable_1';

        // 1. Initial file saved clean
        const originalFile: IDBFile = {
            id: fileId,
            content: 'Original Base Content',
            etag: 'etag_base_1',
            lastModified: Date.now() - 10000,
            lastSyncedAt: Date.now() - 10000,
            isDirty: false,
            syncStatus: 'synced',
            version: 1,
            title: 'Test Doc',
            parentFolderId: null,
            isFolder: false,
        };
        await idb.saveFile(originalFile);

        // 2. Put file into durable conflict quarantine
        await conflictStore.quarantineConflict({
            fileId,
            localVersion: {
                content: 'Local Edits Made Offline',
                etag: 'etag_base_1',
                version: 1,
                lastModified: Date.now() - 5000,
                title: 'Test Doc (Local)',
            },
            serverVersion: {
                content: 'Remote Edits From Server',
                etag: 'etag_server_2',
                version: 2,
                lastModified: Date.now(),
                title: 'Test Doc (Server)',
            },
            baseVersion: {
                content: 'Original Base Content',
                etag: 'etag_base_1',
                version: 1,
                lastModified: Date.now() - 10000,
                title: 'Test Doc',
            },
            detectedAt: Date.now(),
        });

        // Verify conflict state before reload
        expect(await conflictStore.isConflicted(fileId)).toBe(true);
        const storedBefore = await idb.getFile(fileId);
        expect(storedBefore?.syncStatus).toBe('conflict');
        expect(storedBefore?.conflictData).toBeDefined();

        // 3. Simulate browser close / reload by instantiating fresh IndexedDBManager
        const reloadedIdb = createIndexedDBManager(testUserId);
        await reloadedIdb.init(testUserId);
        const reloadedConflictStore = new ConflictStore(reloadedIdb);

        // 4. Assert conflict state persisted across reload!
        const isStillConflicted = await reloadedConflictStore.isConflicted(fileId);
        expect(isStillConflicted).toBe(true);

        const reloadedFile = await reloadedIdb.getFile(fileId);
        expect(reloadedFile).toBeDefined();
        expect(reloadedFile?.syncStatus).toBe('conflict');
        expect(reloadedFile?.isDirty).toBe(true);
        expect(reloadedFile?.conflictData?.serverVersion.content).toBe('Remote Edits From Server');
        expect(reloadedFile?.conflictData?.localVersion.content).toBe('Local Edits Made Offline');
        expect(reloadedFile?.conflictData?.baseVersion?.content).toBe('Original Base Content');

        const conflictObj = await reloadedConflictStore.getConflict(fileId);
        expect(conflictObj).not.toBeNull();
        expect(conflictObj?.serverVersion.etag).toBe('etag_server_2');
    });

    it('should strictly refuse to overwrite or replace a conflicted file in pullFile', async () => {
        const fileId = 'file_protected_from_pull';

        const syncManager = new SyncManager({ userId: testUserId, idb });
        await syncManager.init({ userId: testUserId, idb });

        // Place file directly in conflict quarantine
        const conflictedFile: IDBFile = {
            id: fileId,
            content: 'Local In-Progress Conflict Content',
            etag: 'etag_local_1',
            lastModified: Date.now(),
            lastSyncedAt: 0,
            isDirty: true,
            syncStatus: 'conflict',
            version: 1,
            title: 'Conflicted Document',
            parentFolderId: null,
            isFolder: false,
            conflictData: {
                serverVersion: {
                    content: 'Remote Divergent Content',
                    etag: 'etag_remote_2',
                    lastModified: Date.now(),
                    version: 2,
                },
                localVersion: {
                    content: 'Local In-Progress Conflict Content',
                    etag: 'etag_local_1',
                    lastModified: Date.now(),
                    version: 1,
                },
                detectedAt: Date.now(),
            },
        };
        await syncManager['idb'].saveFile(conflictedFile);

        // Attempt background pull of new server version
        const pullResult = await (syncManager as any).pullFile({
            id: fileId,
            content: 'Server Content That Must Not Overwrite',
            etag: 'etag_remote_2',
            version: 2,
            title: 'Server Title',
            parentFolderId: null,
            isFolder: false,
            updatedAt: new Date().toISOString(),
        });

        // Assert: pull was blocked by durable quarantine!
        expect(pullResult.success).toBe(false);
        expect(pullResult.action).toBe('conflict');
        expect(pullResult.error).toBe('DURABLE_CONFLICT_QUARANTINE');

        // Verify local file content in IDB remained untouched
        const preservedFile = await syncManager['idb'].getFile(fileId);
        expect(preservedFile?.content).toBe('Local In-Progress Conflict Content');
        expect(preservedFile?.syncStatus).toBe('conflict');
    });

    it('should strictly refuse to delete a conflicted file when receiving server tombstone', async () => {
        const fileId = 'file_protected_from_tombstone';

        const syncManager = new SyncManager({ userId: testUserId, idb });
        await syncManager.init({ userId: testUserId, idb });

        // Save file in conflict state (even if isDirty was false)
        const conflictedFile: IDBFile = {
            id: fileId,
            content: 'Valuable User Notes In Conflict',
            etag: 'etag_conflict_1',
            lastModified: Date.now(),
            lastSyncedAt: 0,
            isDirty: false,
            syncStatus: 'conflict',
            version: 2,
            title: 'Notes',
            parentFolderId: null,
            isFolder: false,
            conflictData: {
                serverVersion: { content: '', etag: 'etag_del', version: 3, lastModified: Date.now() },
                localVersion: { content: 'Valuable User Notes In Conflict', etag: 'etag_conflict_1', version: 2, lastModified: Date.now() },
                detectedAt: Date.now(),
            },
        };
        await syncManager['idb'].saveFile(conflictedFile);

        // Server sends tombstone (deletedAt set)
        const tombstoneResult = await (syncManager as any).pullFile({
            id: fileId,
            content: '',
            etag: 'etag_del',
            version: 3,
            title: 'Notes',
            parentFolderId: null,
            isFolder: false,
            deletedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        // Assert: deletion rejected to protect user's conflicted notes!
        expect(tombstoneResult.success).toBe(false);
        expect(tombstoneResult.action).toBe('conflict');

        // File remains in IDB
        const fileInIdb = await syncManager['idb'].getFile(fileId);
        expect(fileInIdb).toBeDefined();
        expect(fileInIdb?.content).toBe('Valuable User Notes In Conflict');
        expect(fileInIdb?.syncStatus).toBe('conflict');
    });

    it('should resolve conflict cleanly and transition state to synced or dirty', async () => {
        const fileId = 'file_resolve_test';

        await conflictStore.quarantineConflict({
            fileId,
            localVersion: { content: 'Local Version', etag: 'etag_local', version: 1, lastModified: Date.now() },
            serverVersion: { content: 'Server Version', etag: 'etag_server', version: 2, lastModified: Date.now() },
            baseVersion: { content: 'Base Version', etag: 'etag_base', version: 1, lastModified: Date.now() },
        });

        // 1. Resolve adopting server
        await conflictStore.resolveConflict(fileId, 'server');
        let file = await idb.getFile(fileId);
        expect(file?.syncStatus).toBe('synced');
        expect(file?.content).toBe('Server Version');
        expect(file?.conflictData).toBeUndefined();

        // 2. Quarantine again
        await conflictStore.quarantineConflict({
            fileId,
            localVersion: { content: 'Local Version 2', etag: 'etag_local_2', version: 2, lastModified: Date.now() },
            serverVersion: { content: 'Server Version 2', etag: 'etag_server_3', version: 3, lastModified: Date.now() },
        });

        // 3. Resolve retaining local (must stay dirty for subsequent push pass - LUGX-003)
        await conflictStore.resolveConflict(fileId, 'local');
        file = await idb.getFile(fileId);
        expect(file?.syncStatus).toBe('dirty');
        expect(file?.isDirty).toBe(true);
        expect(file?.content).toBe('Local Version 2');
        expect(file?.conflictData).toBeUndefined();
    });
});
