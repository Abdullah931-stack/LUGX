/**
 * Phase 2 Verification Suite: Database Schema Migrations & Transparent Encrypted IndexedDB
 *
 * Validates:
 * 1. Drizzle ORM schema definitions (userVaultProfiles, files encryption fields).
 * 2. SQL Migration 0008 integrity and syntax.
 * 3. Transparent At-Rest Encryption & Decryption in IndexedDBManager.
 * 4. Zero Plaintext At-Rest Invariant (direct raw IDB inspection).
 * 5. Operations log, previousContent, and snapshots encryption.
 * 6. Atomic multi-store sync commit encryption.
 * 7. Legacy unencrypted record compatibility & auto-upgrade.
 * 8. Corrupted record isolation (CorruptedLocalRecordError).
 * 9. Multi-user cryptographic isolation with independent device keys.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    userVaultProfiles,
    files,
    UserVaultProfile,
    NewUserVaultProfile
} from '../lib/db/schema';
import {
    IDBFile,
    IDBOperation,
    IDB_CONFIG,
    getDatabaseName,
    CorruptedLocalRecordError,
} from '../lib/sync/idb-types';
import {
    IndexedDBManager,
    createIndexedDBManager,
} from '../lib/sync/indexeddb';
import { sessionKeyStore } from '../lib/sync/session-key-store';
import { cryptoWorkerBridge } from '../lib/sync/crypto-worker-bridge';

describe('Phase 2: Database Schema & Transparent Encrypted IndexedDB Storage', () => {
    let manager1: IndexedDBManager;
    let manager2: IndexedDBManager;

    beforeEach(async () => {
        sessionKeyStore.purgeKeys();
        manager1 = createIndexedDBManager('user-vault-1');
        manager2 = createIndexedDBManager('user-vault-2');
        await manager1.init('user-vault-1');
        await manager2.init('user-vault-2');
        await manager1.clearAll();
        await manager2.clearAll();
    });

    afterEach(async () => {
        await manager1.clearAll();
        await manager2.clearAll();
        manager1.close();
        manager2.close();
        sessionKeyStore.purgeKeys();
    });

    describe('1. Drizzle Schema & SQL Migration 0008 Verification', () => {
        it('should have userVaultProfiles table defined with all required security fields', () => {
            expect(userVaultProfiles).toBeDefined();
            expect(userVaultProfiles.userId).toBeDefined();
            expect(userVaultProfiles.encryptedMasterKey).toBeDefined();
            expect(userVaultProfiles.recoveryEncryptedMasterKey).toBeDefined();
            expect(userVaultProfiles.keySalt).toBeDefined();
            expect(userVaultProfiles.recoverySalt).toBeDefined();
            expect(userVaultProfiles.kdfIterations).toBeDefined();
            expect(userVaultProfiles.keyVersion).toBeDefined();
            expect(userVaultProfiles.createdAt).toBeDefined();
            expect(userVaultProfiles.updatedAt).toBeDefined();
        });

        it('should have encryption fields added to files table', () => {
            expect(files.isEncrypted).toBeDefined();
            expect(files.encryptionMetadata).toBeDefined();
        });

        it('should verify migration file 0008_hybrid_vault_schema.sql exists and contains valid SQL', () => {
            const migrationPath = path.resolve(process.cwd(), 'src/lib/db/migrations/0008_hybrid_vault_schema.sql');
            expect(fs.existsSync(migrationPath)).toBe(true);

            const sql = fs.readFileSync(migrationPath, 'utf8');
            expect(sql).toContain('CREATE TABLE IF NOT EXISTS "user_vault_profiles"');
            expect(sql).toContain('"encrypted_master_key" text NOT NULL');
            expect(sql).toContain('"recovery_encrypted_master_key" text NOT NULL');
            expect(sql).toContain('"key_salt" text NOT NULL');
            expect(sql).toContain('"recovery_salt" text NOT NULL');
            expect(sql).toContain('ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "is_encrypted"');
            expect(sql).toContain('ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "encryption_metadata" jsonb');
        });
    });

    describe('2. Transparent At-Rest Encryption & Decryption', () => {
        it('should transparently encrypt on saveFile and decrypt on getFile', async () => {
            const file: IDBFile = {
                id: 'file-enc-1',
                title: 'Secret Notes',
                content: '# Highly Confidential\n\nTop secret business plan.',
                etag: 'etag-123',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256',
                    keyId: 'k-1',
                    salt: 'salt-b64',
                    iv: 'iv-b64',
                },
                baseSnapshot: {
                    content: '# Highly Confidential Base',
                    etag: 'etag-base-123',
                    version: 1,
                    title: 'Secret Notes',
                    parentFolderId: null,
                },
            };

            await manager1.saveFile(file);

            // Read through manager: returns decrypted content
            const loaded = await manager1.getFile('file-enc-1');
            expect(loaded).toBeDefined();
            expect(loaded?.id).toBe('file-enc-1');
            expect(loaded?.title).toBe('Secret Notes');
            expect(loaded?.content).toBe('# Highly Confidential\n\nTop secret business plan.');
            expect(loaded?.baseSnapshot?.content).toBe('# Highly Confidential Base');
            expect(loaded?.isEncrypted).toBe(true);
            expect(loaded?.encryptionMetadata?.algorithm).toBe('AES-GCM-256');
        });

        it('should return all decrypted files via getAllFiles and getDirtyFiles', async () => {
            await manager1.saveFile({
                id: 'file-dirty-1',
                title: 'Doc 1',
                content: 'Content 1',
                etag: 'etag-1',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            });

            await manager1.saveFile({
                id: 'file-clean-2',
                title: 'Doc 2',
                content: 'Content 2',
                etag: 'etag-2',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            const allFiles = await manager1.getAllFiles();
            expect(allFiles.length).toBe(2);
            const doc1 = allFiles.find(f => f.id === 'file-dirty-1');
            const doc2 = allFiles.find(f => f.id === 'file-clean-2');
            expect(doc1?.content).toBe('Content 1');
            expect(doc2?.content).toBe('Content 2');

            const dirtyFiles = await manager1.getDirtyFiles();
            expect(dirtyFiles.length).toBe(1);
            expect(dirtyFiles[0].id).toBe('file-dirty-1');
            expect(dirtyFiles[0].content).toBe('Content 1');
        });
    });

    describe('3. Zero Plaintext At-Rest Invariant (Raw IndexedDB Inspection)', () => {
        it('should confirm that raw records in IndexedDB stores contain zero plaintext strings', async () => {
            const rawSecret = 'SUPER_SECRET_PAYLOAD_UNREADABLE_ON_DISK_2026';
            const rawSnapshot = 'SUPER_SECRET_SNAPSHOT_DATA_2026';

            await manager1.saveFile({
                id: 'file-zero-leak',
                title: 'Zero Leak Document',
                content: rawSecret,
                etag: 'etag-zl',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
                baseSnapshot: {
                    content: rawSnapshot,
                    etag: 'etag-zl',
                    version: 1,
                },
            });

            // Inspect underlying IndexedDB directly via low-level IDB API
            const dbName = getDatabaseName('user-vault-1');
            const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            const rawStoredRecord = await new Promise<any>((resolve, reject) => {
                const tx = rawDb.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
                const req = tx.objectStore(IDB_CONFIG.STORES.FILES).get('file-zero-leak');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            rawDb.close();

            expect(rawStoredRecord).toBeDefined();
            // Raw content must NOT contain plaintext anywhere
            expect(rawStoredRecord.content).not.toContain(rawSecret);
            expect(rawStoredRecord.baseSnapshot.content).not.toContain(rawSnapshot);

            // Raw content must be an encrypted JSON payload with _enc: 1, iv, and ct
            const parsedContent = JSON.parse(rawStoredRecord.content);
            expect(parsedContent._enc).toBe(1);
            expect(parsedContent.iv).toBeDefined();
            expect(parsedContent.ct).toBeDefined();

            const parsedSnap = JSON.parse(rawStoredRecord.baseSnapshot.content);
            expect(parsedSnap._enc).toBe(1);
            expect(parsedSnap.iv).toBeDefined();
            expect(parsedSnap.ct).toBeDefined();
        });
    });

    describe('4. Operations Log Encryption & Queue Integrity', () => {
        it('should encrypt operation content, previousContent, and snapshots at rest', async () => {
            const opSecret = 'NEW_TYPED_TEXT_CHUNK';
            const prevSecret = 'OLD_DELETED_TEXT_CHUNK';

            const op: IDBOperation = {
                id: 'op-enc-1',
                fileId: 'file-123',
                operationType: 'update',
                position: 10,
                content: opSecret,
                previousContent: prevSecret,
                timestamp: Date.now(),
                synced: false,
                snapshot: {
                    content: 'SNAPSHOT_INSIDE_OP',
                    etag: 'etag-snap',
                    version: 1,
                },
            };

            await manager1.addOperation(op);

            // Read through manager
            const loadedOp = await manager1.getOperation('op-enc-1');
            expect(loadedOp).toBeDefined();
            expect(loadedOp?.content).toBe(opSecret);
            expect(loadedOp?.previousContent).toBe(prevSecret);
            expect(loadedOp?.snapshot?.content).toBe('SNAPSHOT_INSIDE_OP');

            // Verify raw record is ciphertext
            const dbName = getDatabaseName('user-vault-1');
            const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            const rawOp = await new Promise<any>((resolve, reject) => {
                const tx = rawDb.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
                const req = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).get('op-enc-1');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            rawDb.close();

            expect(rawOp.content).not.toContain(opSecret);
            expect(rawOp.previousContent).not.toContain(prevSecret);
            expect(rawOp.snapshot.content).not.toContain('SNAPSHOT_INSIDE_OP');
        });

        it('should atomically commit clean file and synced operation with encrypted storage', async () => {
            await manager1.saveFile({
                id: 'file-sync-atomic',
                title: 'Atomic Doc',
                content: 'Unsynced Local Text',
                etag: 'etag-old',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            });

            await manager1.addOperation({
                id: 'op-sync-atomic',
                fileId: 'file-sync-atomic',
                operationType: 'update',
                position: 0,
                content: 'Unsynced Local Text',
                timestamp: Date.now(),
                synced: false,
                status: 'queued',
            });

            // Commit atomic sync
            await manager1.commitFileAndOperationSync('file-sync-atomic', 'etag-new-999', 'op-sync-atomic', 1, 2);

            const file = await manager1.getFile('file-sync-atomic');
            const op = await manager1.getOperation('op-sync-atomic');

            expect(file?.isDirty).toBe(false);
            expect(file?.etag).toBe('etag-new-999');
            expect(file?.version).toBe(2);
            expect(file?.content).toBe('Unsynced Local Text');

            expect(op?.synced).toBe(true);
            expect(op?.status).toBe('synced');
            expect(op?.content).toBe('Unsynced Local Text');
        });
    });

    describe('5. Backward Compatibility & Legacy In-Place Migration', () => {
        it('should transparently read unencrypted legacy records and encrypt on next save', async () => {
            const dbName = getDatabaseName('user-vault-1');
            const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            // Inject plain unencrypted record into files store directly
            const legacyPlaintext = '# Old Legacy Document\n\nCreated before encryption was enabled.';
            await new Promise<void>((resolve, reject) => {
                const tx = rawDb.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
                const req = tx.objectStore(IDB_CONFIG.STORES.FILES).put({
                    id: 'file-legacy-1',
                    title: 'Legacy Doc',
                    content: legacyPlaintext,
                    etag: 'etag-leg-1',
                    version: 1,
                    parentFolderId: null,
                    isFolder: false,
                    lastModified: Date.now(),
                    lastSyncedAt: 0,
                    isDirty: false,
                });
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            rawDb.close();

            // 1. Read through manager: reads smoothly without throwing
            const loaded = await manager1.getFile('file-legacy-1');
            expect(loaded).toBeDefined();
            expect(loaded?.content).toBe(legacyPlaintext);

            // 2. Modify and save through manager
            loaded!.content = '# Updated Legacy Document';
            await manager1.saveFile(loaded!);

            // 3. Inspect raw record: must now be encrypted at rest!
            const verifyDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            const updatedRaw = await new Promise<any>((resolve, reject) => {
                const tx = verifyDb.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
                const req = tx.objectStore(IDB_CONFIG.STORES.FILES).get('file-legacy-1');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            verifyDb.close();

            expect(updatedRaw.content).not.toContain('# Updated Legacy Document');
            const parsed = JSON.parse(updatedRaw.content);
            expect(parsed._enc).toBe(1);
            expect(parsed.iv).toBeDefined();
        });
    });

    describe('6. Corrupted Record Isolation & Fault Resilience', () => {
        it('should throw CorruptedLocalRecordError on getFile when ciphertext is corrupted', async () => {
            const dbName = getDatabaseName('user-vault-1');
            const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            // Inject malformed ciphertext envelope with bad auth tag
            await new Promise<void>((resolve, reject) => {
                const tx = rawDb.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
                const req = tx.objectStore(IDB_CONFIG.STORES.FILES).put({
                    id: 'file-corrupted',
                    title: 'Corrupted Doc',
                    content: JSON.stringify({
                        _enc: 1,
                        iv: 'AQIDBAUGBwgJCgsM',
                        ct: 'INVALID_CORRUPTED_CIPHERTEXT_BASE64==',
                    }),
                    etag: 'etag-bad',
                    version: 1,
                    parentFolderId: null,
                    isFolder: false,
                    lastModified: Date.now(),
                    lastSyncedAt: 0,
                    isDirty: false,
                });
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            rawDb.close();

            await expect(manager1.getFile('file-corrupted')).rejects.toThrow(CorruptedLocalRecordError);
        });

        it('should isolate corrupted files during getAllFiles without crashing valid files retrieval', async () => {
            // Save valid file
            await manager1.saveFile({
                id: 'file-valid-ok',
                title: 'Valid Doc',
                content: 'I am safe and valid',
                etag: 'etag-ok',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            // Inject corrupted file
            const dbName = getDatabaseName('user-vault-1');
            const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            await new Promise<void>((resolve, reject) => {
                const tx = rawDb.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
                const req = tx.objectStore(IDB_CONFIG.STORES.FILES).put({
                    id: 'file-corrupted-isolate',
                    title: 'Corrupted Doc',
                    content: JSON.stringify({
                        _enc: 1,
                        iv: 'AQIDBAUGBwgJCgsM',
                        ct: 'CORRUPTED_TAMPERED_CIPHERTEXT==',
                    }),
                    etag: 'etag-bad',
                    version: 1,
                    parentFolderId: null,
                    isFolder: false,
                    lastModified: Date.now(),
                    lastSyncedAt: 0,
                    isDirty: false,
                });
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
            rawDb.close();

            // getAllFiles should safely isolate the corrupted record and return the valid one
            const files = await manager1.getAllFiles();
            expect(files.length).toBe(1);
            expect(files[0].id).toBe('file-valid-ok');
            expect(files[0].content).toBe('I am safe and valid');
        });
    });

    describe('7. Multi-User Cryptographic & Storage Isolation', () => {
        it('should enforce distinct device keys and physical databases between different users', async () => {
            await manager1.saveFile({
                id: 'shared-doc-id',
                title: 'User 1 Confidential',
                content: 'Secret from User 1',
                etag: 'etag-u1',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            });

            await manager2.saveFile({
                id: 'shared-doc-id',
                title: 'User 2 Confidential',
                content: 'Secret from User 2',
                etag: 'etag-u2',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            const u1File = await manager1.getFile('shared-doc-id');
            const u2File = await manager2.getFile('shared-doc-id');

            expect(u1File?.content).toBe('Secret from User 1');
            expect(u2File?.content).toBe('Secret from User 2');
        });
    });

    describe('8. Adversarial Concurrency & Uninitialized Lazy-Load Resilience', () => {
        it('should guarantee key persistence and decryption recovery even when saveFile is called before init()', async () => {
            const lazyMgr = createIndexedDBManager('lazy-user-id');
            // Deliberately DO NOT call lazyMgr.init() to verify transparent getDB() self-initialization

            await lazyMgr.saveFile({
                id: 'lazy-1',
                title: 'Lazy Note',
                content: 'Secret content created without explicit init()',
                etag: 'etag-lazy',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            // Close connection and wipe in-memory RAM
            lazyMgr.close();
            sessionKeyStore.purgeKeys();

            // Reopen database with a completely fresh manager instance
            const reopenedMgr = createIndexedDBManager('lazy-user-id');
            const retrieved = await reopenedMgr.getFile('lazy-1');

            expect(retrieved).toBeDefined();
            expect(retrieved?.content).toBe('Secret content created without explicit init()');

            await reopenedMgr.deleteDatabase();
        });

        it('should eliminate cold-start race conditions when parallel save operations execute on a brand new database', async () => {
            const concurrentMgr = createIndexedDBManager('concurrent-cold-user');
            // Deliberately run 20 parallel saves on cold database
            const operations = Array.from({ length: 20 }, (_, i) =>
                concurrentMgr.saveFile({
                    id: `cold-file-${i}`,
                    title: `Cold Note ${i}`,
                    content: `Deterministic content payload #${i}`,
                    etag: `etag-${i}`,
                    version: 1,
                    parentFolderId: null,
                    isFolder: false,
                    lastModified: Date.now(),
                    lastSyncedAt: 0,
                    isDirty: false,
                })
            );

            await Promise.all(operations);

            // Wipe RAM and close manager to simulate page refresh
            concurrentMgr.close();
            sessionKeyStore.purgeKeys();

            // Reopen and verify every single file decodes without authentication tag mismatch
            const verifyMgr = createIndexedDBManager('concurrent-cold-user');
            const results = await Promise.all(
                Array.from({ length: 20 }, (_, i) => verifyMgr.getFile(`cold-file-${i}`))
            );

            expect(results.length).toBe(20);
            results.forEach((f, i) => {
                expect(f).toBeDefined();
                expect(f?.content).toBe(`Deterministic content payload #${i}`);
            });

            await verifyMgr.deleteDatabase();
        });

        it('should enforce strict user isolation in memory even without manual purgeKeys() between distinct managers', async () => {
            const mgrA = createIndexedDBManager('iso-user-A');
            const mgrB = createIndexedDBManager('iso-user-B');

            // Save in mgrA
            await mgrA.saveFile({
                id: 'iso-doc',
                title: 'User A Secret',
                content: 'Confidential User A data',
                etag: 'etag-a',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            // Immediately save in mgrB WITHOUT manually purging sessionKeyStore
            await mgrB.saveFile({
                id: 'iso-doc',
                title: 'User B Secret',
                content: 'Confidential User B data',
                etag: 'etag-b',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: false,
            });

            // Verify both decrypt their own records cleanly
            const fileA = await mgrA.getFile('iso-doc');
            const fileB = await mgrB.getFile('iso-doc');

            expect(fileA?.content).toBe('Confidential User A data');
            expect(fileB?.content).toBe('Confidential User B data');

            await mgrA.deleteDatabase();
            await mgrB.deleteDatabase();
        });
    });
});
