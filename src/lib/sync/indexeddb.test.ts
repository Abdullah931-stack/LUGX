/**
 * IndexedDB Manager Tests
 * Comprehensive tests with real IndexedDB operations, user database namespacing, and scoping isolation
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFile, IDBOperation, IDB_CONFIG, getDatabaseName } from './idb-types';
import { IndexedDBManager, createIndexedDBManager } from './indexeddb';

describe('IndexedDB Manager (Real IndexedDB & Multi-User Isolation)', () => {
    let manager1: IndexedDBManager;
    let manager2: IndexedDBManager;

    beforeEach(() => {
        manager1 = createIndexedDBManager('user-1');
        manager2 = createIndexedDBManager('user-2');
    });

    afterEach(async () => {
        manager1.close();
        manager2.close();
    });

    describe('Database Namespacing & Scoping', () => {
        it('should generate user-scoped database names with correct prefix', () => {
            expect(getDatabaseName('user-abc')).toBe('textai_db_user-abc');
            expect(getDatabaseName('12345')).toBe('textai_db_12345');
        });

        it('should throw when getDatabaseName is called with empty or undefined userId', () => {
            expect(() => getDatabaseName('')).toThrow('Valid userId is required');
            expect(() => getDatabaseName('   ')).toThrow('Valid userId is required');
            expect(() => getDatabaseName(undefined)).toThrow('Valid userId is required');
        });

        it('should reject init without valid userId', async () => {
            const manager = new IndexedDBManager();
            await expect(manager.init('')).rejects.toThrow('Valid userId is required');
        });
    });

    describe('Real IDB CRUD and Physical Isolation between Users', () => {
        it('should initialize and perform save, get, and delete operations', async () => {
            await manager1.init('user-1');

            const file: IDBFile = {
                id: 'file-101',
                content: '<p>User 1 Document</p>',
                title: 'User 1 File',
                etag: 'etag-101',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            };

            await manager1.saveFile(file);
            const loaded = await manager1.getFile('file-101');

            expect(loaded).toBeDefined();
            expect(loaded?.title).toBe('User 1 File');
            expect(loaded?.content).toBe('<p>User 1 Document</p>');
            expect(loaded?.isDirty).toBe(true);

            // Mark clean
            await manager1.markFileClean('file-101', 'etag-101-clean');
            const cleanLoaded = await manager1.getFile('file-101');
            expect(cleanLoaded?.isDirty).toBe(false);
            expect(cleanLoaded?.etag).toBe('etag-101-clean');

            // Mark dirty
            await manager1.markFileDirty('file-101');
            const dirtyLoaded = await manager1.getFile('file-101');
            expect(dirtyLoaded?.isDirty).toBe(true);

            // Delete
            await manager1.deleteFile('file-101');
            const afterDelete = await manager1.getFile('file-101');
            expect(afterDelete).toBeUndefined();
        });

        it('should physically isolate data between different users', async () => {
            await manager1.init('user-1');
            await manager2.init('user-2');

            // Save file in user-1's database
            await manager1.saveFile({
                id: 'file-common-id',
                content: 'User 1 Private Content',
                title: 'User 1 Document',
                etag: 'etag-u1',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            });

            // Save file in user-2's database with same file ID but different content
            await manager2.saveFile({
                id: 'file-common-id',
                content: 'User 2 Private Content',
                title: 'User 2 Document',
                etag: 'etag-u2',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            const u1File = await manager1.getFile('file-common-id');
            const u2File = await manager2.getFile('file-common-id');

            expect(u1File?.content).toBe('User 1 Private Content');
            expect(u2File?.content).toBe('User 2 Private Content');

            const u1Dirty = await manager1.getDirtyFiles();
            const u2Dirty = await manager2.getDirtyFiles();

            expect(u1Dirty.length).toBe(1);
            expect(u2Dirty.length).toBe(0);
        });

        it('should manage operations log and query unsynced operations', async () => {
            await manager1.init('user-1');

            const op1: IDBOperation = {
                id: 'op-1',
                fileId: 'file-ops-test',
                operationType: 'insert',
                position: 0,
                content: 'A',
                timestamp: Date.now() - 5000,
                synced: false,
            };

            const op2: IDBOperation = {
                id: 'op-2',
                fileId: 'file-ops-test',
                operationType: 'insert',
                position: 1,
                content: 'B',
                timestamp: Date.now() - 4000,
                synced: true,
            };

            await manager1.addOperation(op1);
            await manager1.addOperation(op2);

            const allOps = await manager1.getOperations('file-ops-test');
            expect(allOps.length).toBe(2);

            const unsynced = await manager1.getUnsyncedOperations('file-ops-test');
            expect(unsynced.length).toBe(1);
            expect(unsynced[0].id).toBe('op-1');

            await manager1.markOperationsSynced(['op-1']);
            const afterMark = await manager1.getUnsyncedOperations('file-ops-test');
            expect(afterMark.length).toBe(0);
        });

        it('should manage user sync metadata', async () => {
            await manager1.init('user-1');

            await manager1.updateLastSyncedAt('user-1');
            const meta = await manager1.getSyncMetadata('user-1');

            expect(meta).toBeDefined();
            expect(meta?.id).toBe('user-1');
            expect(meta?.lastSyncedAt).toBeGreaterThan(0);
        });

        it('should delete the user database completely on deleteDatabase()', async () => {
            await manager1.init('user-1');
            await manager1.saveFile({
                id: 'to-be-deleted',
                content: 'Temp',
                title: 'Temp',
                etag: 'etag',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            await manager1.deleteDatabase();

            // Re-open and verify empty
            const freshManager = createIndexedDBManager('user-1');
            await freshManager.init('user-1');
            const file = await freshManager.getFile('to-be-deleted');
            expect(file).toBeUndefined();
            freshManager.close();
        });
    });

    describe('IDB_CONFIG', () => {
        it('should have correct configuration', () => {
            expect(IDB_CONFIG.DB_NAME_PREFIX).toBe('textai_db');
            expect(IDB_CONFIG.DB_VERSION).toBeGreaterThan(0);
            expect(IDB_CONFIG.STORES.FILES).toBe('files');
            expect(IDB_CONFIG.STORES.OPERATIONS).toBe('operations');
            expect(IDB_CONFIG.STORES.SYNC_METADATA).toBe('sync_metadata');
        });
    });
});
