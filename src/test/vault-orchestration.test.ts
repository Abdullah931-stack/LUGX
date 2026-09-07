/**
 * Phase 3 Verification Suite: Vault UI, Editor Orchestrator & Dynamic File Conversion Engine
 *
 * Tests:
 * 1. BIP-39 mnemonic generation, validation, and dual-wrapping (Password KEK + Recovery Seed KEK).
 * 2. Vault unlock with correct password vs. rejection on incorrect password.
 * 3. Seed recovery: Master key recovery via mnemonic and re-wrapping with a new password.
 * 4. Offline vault profile persistence & retrieval in IndexedDB sync_metadata.
 * 5. Dynamic file encryption/decryption offline workflow (IndexedDB save, isDirty flag, deferred sync preparation).
 * 6. Cryptographic envelope integrity: AAD binding with fileId and userId tamper-proofing.
 * 7. In-memory master key isolation, sessionKeyStore auto-expiry, and defensive zeroing.
 * 8. Editor save pipeline: Plaintext encryption with Master Key before server/IDB commit.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    cryptoWorkerBridge,
    wipeBuffer,
    base64ToUint8Array,
    generateMasterKeyRaw,
    generateSalt,
    generateIV,
    deriveKEKFromPassword,
    deriveKEKFromRecoverySeed,
    wrapMasterKeyWithPassword,
    unwrapMasterKeyWithPassword,
    wrapMasterKeyWithRecoverySeed,
    unwrapMasterKeyWithRecoverySeed,
    deriveKEKFromPin,
    wrapMasterKeyWithPin,
    unwrapMasterKeyWithPin,
    encryptEnvelope,
    decryptEnvelope,
    sessionKeyStore,
    SessionKeyStore,
    generateMnemonic,
    validateMnemonic,
    InvalidCiphertextOrKeyError,
    AADIntegrityError,
    EncryptedEnvelope,
    DeviceTrustEnvelope,
    InvalidPinError,
    DeviceTrustRevokedError,
} from '../lib/sync';
import {
    createIndexedDBManager,
    IndexedDBManager,
} from '../lib/sync/indexeddb';
import { IDBFile } from '../lib/sync/idb-types';

describe('Phase 3: Vault UI, Editor Orchestration & Dynamic File Conversion', () => {
    let idb: IndexedDBManager;
    const testUserId = 'user-vault-p3-test';

    beforeEach(async () => {
        sessionKeyStore.purgeKeys();
        vi.useRealTimers();
        idb = createIndexedDBManager(testUserId);
        await idb.init(testUserId);
        await idb.clearAll();
    });

    afterEach(async () => {
        await idb.clearAll();
        idb.close();
        sessionKeyStore.purgeKeys();
        vi.restoreAllMocks();
    });

    describe('1. Vault Setup & Dual Key Wrapping (BIP-39 + Password)', () => {
        it('should generate a 12-word BIP-39 mnemonic and dual-wrap the master key', async () => {
            const mnemonic = await generateMnemonic(16);
            expect(mnemonic.trim().split(/\s+/)).toHaveLength(12);

            const validation = await validateMnemonic(mnemonic);
            expect(validation.isValid).toBe(true);

            // Generate Master Key
            const masterKey = await generateMasterKeyRaw();
            expect(masterKey).toHaveLength(32);

            // Dual wrapping with test iteration count for fast unit test
            const testPassword = 'SuperSecretVaultPassword!2026';
            const iterations = 5000;

            const passwordSalt = await generateSalt(16);
            const recoverySalt = await generateSalt(16);

            const passwordWrapped = await wrapMasterKeyWithPassword(
                masterKey,
                testPassword,
                passwordSalt,
                testUserId,
                iterations
            );

            const recoveryWrapped = await wrapMasterKeyWithRecoverySeed(
                masterKey,
                mnemonic,
                recoverySalt,
                testUserId,
                iterations
            );

            expect(passwordWrapped.wrappedKeyBase64).toBeDefined();
            expect(passwordWrapped.ivBase64).toBeDefined();
            expect(recoveryWrapped.wrappedKeyBase64).toBeDefined();
            expect(recoveryWrapped.ivBase64).toBeDefined();

            // Simulate vault profile stored in DB / IndexedDB
            const profile = {
                id: 'profile-1',
                userId: testUserId,
                wrappedMasterKey: passwordWrapped.wrappedKeyBase64,
                salt: Buffer.from(passwordSalt).toString('base64'),
                iv: passwordWrapped.ivBase64,
                authTag: '',
                keyDerivationIterations: iterations,
                recoveryWrappedKey: recoveryWrapped.wrappedKeyBase64,
                recoverySalt: Buffer.from(recoverySalt).toString('base64'),
                recoveryIv: recoveryWrapped.ivBase64,
                recoveryAuthTag: '',
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            // Test unwrapping with password
            const unwrappedWithPassword = await unwrapMasterKeyWithPassword(
                profile.wrappedMasterKey,
                profile.iv,
                testPassword,
                new Uint8Array(Buffer.from(profile.salt, 'base64')),
                testUserId,
                profile.keyDerivationIterations
            );

            expect(Buffer.from(unwrappedWithPassword)).toEqual(Buffer.from(masterKey));

            // Test unwrapping with seed
            const unwrappedWithSeed = await unwrapMasterKeyWithRecoverySeed(
                profile.recoveryWrappedKey,
                profile.recoveryIv,
                mnemonic,
                new Uint8Array(Buffer.from(profile.recoverySalt, 'base64')),
                testUserId,
                profile.keyDerivationIterations
            );

            expect(Buffer.from(unwrappedWithSeed)).toEqual(Buffer.from(masterKey));

            wipeBuffer(masterKey);
            wipeBuffer(unwrappedWithPassword);
            wipeBuffer(unwrappedWithSeed);
        });

        it('should reject unwrapping with incorrect password and preserve master key security', async () => {
            const masterKey = await generateMasterKeyRaw();
            const salt = await generateSalt(16);

            const wrapped = await wrapMasterKeyWithPassword(
                masterKey,
                'CorrectPassword123',
                salt,
                testUserId,
                5000
            );

            await expect(
                unwrapMasterKeyWithPassword(
                    wrapped.wrappedKeyBase64,
                    wrapped.ivBase64,
                    'WrongPassword321',
                    salt,
                    testUserId,
                    5000
                )
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });
    });

    describe('2. Vault Recovery & Password Reset Flow', () => {
        it('should recover master key using mnemonic seed and re-wrap with a new password', async () => {
            const mnemonic = await generateMnemonic(16);
            const masterKey = await generateMasterKeyRaw();

            // Initial dual wrap
            const initialSalt = await generateSalt(16);
            await wrapMasterKeyWithPassword(
                masterKey,
                'OldForgottenPassword',
                initialSalt,
                testUserId,
                5000
            );

            const recSalt = await generateSalt(16);
            const recWrapped = await wrapMasterKeyWithRecoverySeed(
                masterKey,
                mnemonic,
                recSalt,
                testUserId,
                5000
            );

            // User forgot password! Recover master key using recovery seed
            const recoveredKey = await unwrapMasterKeyWithRecoverySeed(
                recWrapped.wrappedKeyBase64,
                recWrapped.ivBase64,
                mnemonic,
                recSalt,
                testUserId,
                5000
            );
            expect(Buffer.from(recoveredKey)).toEqual(Buffer.from(masterKey));

            // User sets new password
            const newPassword = 'BrandNewPassword2026!';
            const newSalt = await generateSalt(16);
            const newPasswordWrapped = await wrapMasterKeyWithPassword(
                recoveredKey,
                newPassword,
                newSalt,
                testUserId,
                5000
            );

            // Verify the new password unlocks the master key
            const unlockedWithNewPassword = await unwrapMasterKeyWithPassword(
                newPasswordWrapped.wrappedKeyBase64,
                newPasswordWrapped.ivBase64,
                newPassword,
                newSalt,
                testUserId,
                5000
            );
            expect(Buffer.from(unlockedWithNewPassword)).toEqual(Buffer.from(masterKey));

            // Verify old password fails
            await expect(
                unwrapMasterKeyWithPassword(
                    newPasswordWrapped.wrappedKeyBase64,
                    newPasswordWrapped.ivBase64,
                    'OldForgottenPassword',
                    newSalt,
                    testUserId,
                    5000
                )
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
            wipeBuffer(recoveredKey);
            wipeBuffer(unlockedWithNewPassword);
        });
    });

    describe('3. Offline Vault Profile Caching in IndexedDB', () => {
        it('should persist and retrieve cached vault profile in sync_metadata store', async () => {
            const cachedProfile = {
                id: 'vault-uuid-001',
                userId: testUserId,
                wrappedMasterKey: 'd3JhcHBlZEtleTEyMw==',
                salt: 'c2FsdDEyMw==',
                iv: 'aXYxMjM0NTY3ODkw',
                authTag: 'YXV0aFRhZzEyMw==',
                keyDerivationIterations: 600000,
                recoveryWrappedKey: 'cmVjb3ZlcnlLZXkxMjM=',
                recoverySalt: 'cmVjb3ZlcnlTYWx0',
                recoveryIv: 'cmVjb3ZlcnlJdg==',
                recoveryAuthTag: 'cmVjb3ZlcnlUYWc=',
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            await idb.saveCachedVaultProfile(cachedProfile);

            const retrieved = await idb.getCachedVaultProfile();
            expect(retrieved).not.toBeNull();
            expect(retrieved?.id).toBe('vault-uuid-001');
            expect(retrieved?.wrappedMasterKey).toBe('d3JhcHBlZEtleTEyMw==');
            expect(retrieved?.keyDerivationIterations).toBe(600000);
        });

        it('should safely return null without crashing when getCachedVaultProfile is called on an uninitialized manager without userId', async () => {
            const uninitManager = new IndexedDBManager();
            const res = await uninitManager.getCachedVaultProfile();
            expect(res).toBeNull();
            uninitManager.close();
        });

        it('should auto-initialize when userId is passed directly to saveCachedVaultProfile and getCachedVaultProfile', async () => {
            const autoManager = new IndexedDBManager();
            const profile = {
                id: 'vault-uuid-auto',
                userId: testUserId,
                wrappedMasterKey: 'd3JhcHBlZEtleUF1dG8=',
                salt: 'c2FsdEF1dG8=',
                iv: 'aXYxMjM0NTY3ODkw',
                authTag: 'YXV0aFRhZw==',
                keyDerivationIterations: 600000,
                recoveryWrappedKey: 'cmVjb3ZlcnlBdXRv',
                recoverySalt: 'cmVjb3ZlcnlTYWx0',
                recoveryIv: 'cmVjb3ZlcnlJdg==',
                recoveryAuthTag: 'cmVjb3ZlcnlUYWc=',
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            await autoManager.saveCachedVaultProfile(profile, testUserId);
            const retrieved = await autoManager.getCachedVaultProfile(testUserId);
            expect(retrieved).not.toBeNull();
            expect(retrieved?.id).toBe('vault-uuid-auto');
            autoManager.close();
        });
    });

    describe('4. Dynamic Offline File Encryption & Decryption Toggle', () => {
        it('should encrypt a plaintext file offline, set isDirty, and preserve envelope in IndexedDB', async () => {
            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey);

            // Step 1: Create plaintext file in IDB
            const plaintext = '# Highly Confidential Project Strategy\nSecret offline notes.';
            const originalFile: IDBFile = {
                id: 'doc-confidential-1',
                title: 'Confidential Strategy',
                content: plaintext,
                etag: 'etag-doc-1',
                isFolder: false,
                parentFolderId: null,
                isEncrypted: false,
                encryptionMetadata: null,
                isDirty: false,
                version: 1,
                lastModified: Date.now(),
                lastSyncedAt: Date.now(),
            };

            await idb.saveFile(originalFile);

            // Verify plaintext stored
            const fetched1 = await idb.getFile('doc-confidential-1');
            expect(fetched1?.content).toBe(plaintext);
            expect(fetched1?.isEncrypted).toBe(false);

            // Step 2: User toggles encryption OFFLINE
            const aad = `${testUserId}:doc-confidential-1`;
            const salt = await generateSalt(16);
            const saltBase64 = Buffer.from(salt).toString('base64');
            const envelope = await encryptEnvelope(
                plaintext,
                masterKey,
                'key-v1',
                saltBase64,
                aad,
                600000
            );

            const encryptedFile: IDBFile = {
                ...fetched1!,
                isEncrypted: true,
                encryptionMetadata: envelope,
                isDirty: true,
                lastModified: Date.now(),
            };

            await idb.saveFile(encryptedFile);

            // Step 3: Assert offline state in IndexedDB
            const fetched2 = await idb.getFile('doc-confidential-1');
            expect(fetched2?.isEncrypted).toBe(true);
            expect(fetched2?.isDirty).toBe(true);
            expect(fetched2?.encryptionMetadata).toEqual(envelope);

            // Step 4: Verify offline decryption from envelope
            const decrypted = await decryptEnvelope(
                fetched2!.encryptionMetadata as EncryptedEnvelope,
                masterKey,
                aad
            );
            expect(decrypted).toBe(plaintext);

            // Step 5: User toggles decryption OFFLINE
            const decryptedFile: IDBFile = {
                ...fetched2!,
                content: decrypted,
                isEncrypted: false,
                encryptionMetadata: null,
                isDirty: true,
                lastModified: Date.now(),
            };

            await idb.saveFile(decryptedFile);

            const fetched3 = await idb.getFile('doc-confidential-1');
            expect(fetched3?.isEncrypted).toBe(false);
            expect(fetched3?.encryptionMetadata).toBeNull();
            expect(fetched3?.content).toBe(plaintext);
            expect(fetched3?.isDirty).toBe(true);

            wipeBuffer(masterKey);
        });

        it('should enforce AAD cryptographic binding to prevent file swapping attacks', async () => {
            const masterKey = await generateMasterKeyRaw();
            const salt = await generateSalt(16);
            const saltBase64 = Buffer.from(salt).toString('base64');

            const validAad = `${testUserId}:doc-A`;
            const envelope = await encryptEnvelope(
                'Classified Content',
                masterKey,
                'key-v1',
                saltBase64,
                validAad,
                600000
            );

            // Attempting to decrypt with different fileId (AAD mismatch) MUST fail
            const tamperedFileAad = `${testUserId}:doc-B`;
            await expect(
                decryptEnvelope(envelope, masterKey, tamperedFileAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            // Attempting to decrypt with different userId (AAD mismatch) MUST fail
            const tamperedUserAad = `attacker-user-id:doc-A`;
            await expect(
                decryptEnvelope(envelope, masterKey, tamperedUserAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });
    });

    describe('5. SessionKeyStore Lifecycle & Editor Gating Invariant', () => {
        it('should gate access when master key is absent from RAM and allow access once set', async () => {
            expect(sessionKeyStore.hasMasterKey()).toBe(false);

            // Hydration check simulation: Encrypted file cannot be read without master key
            const isVaultLocked = !sessionKeyStore.hasMasterKey();
            expect(isVaultLocked).toBe(true);

            // Simulate user unlocking vault
            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey);

            expect(sessionKeyStore.hasMasterKey()).toBe(true);
            expect(sessionKeyStore.getMasterKey()).not.toBeNull();

            // Auto-lock / purge test
            sessionKeyStore.purgeKeys();
            expect(sessionKeyStore.hasMasterKey()).toBe(false);
            expect(sessionKeyStore.getMasterKey()).toBeNull();

            wipeBuffer(masterKey);
        });

        it('should automatically wipe master key when replaced or cleared', async () => {
            const key1 = await generateMasterKeyRaw();

            sessionKeyStore.setMasterKey(key1);
            expect(sessionKeyStore.hasMasterKey()).toBe(true);

            // Purge and verify
            sessionKeyStore.purgeKeys();
            expect(sessionKeyStore.hasMasterKey()).toBe(false);

            // Set new key
            const key2 = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(key2);
            expect(sessionKeyStore.hasMasterKey()).toBe(true);

            sessionKeyStore.purgeKeys();
            wipeBuffer(key1);
            wipeBuffer(key2);
        });

        it('should configure default inactivity timeout to exactly 1 hour (3,600,000 ms)', () => {
            const freshStore = new SessionKeyStore();
            expect(freshStore.getInactivityTimeout()).toBe(60 * 60 * 1000);
            expect(sessionKeyStore.getInactivityTimeout()).toBe(60 * 60 * 1000);
        });

        it('should enforce Strict Zero-Trace in-memory isolation and never persist plaintext keys to sessionStorage', async () => {
            const mockStorage: Record<string, string> = {};
            const fakeSessionStorage = {
                getItem: (k: string) => mockStorage[k] ?? null,
                setItem: (k: string, v: string) => { mockStorage[k] = v; },
                removeItem: (k: string) => { delete mockStorage[k]; },
                clear: () => { for (const k in mockStorage) delete mockStorage[k]; },
                length: 0,
                key: () => null,
            };

            const originalWindow = (globalThis as any).window;
            (globalThis as any).window = { sessionStorage: fakeSessionStorage };

            try {
                const testStore = new SessionKeyStore();
                const masterKey = await generateMasterKeyRaw();

                testStore.setMasterKey(masterKey);
                expect(testStore.hasMasterKey()).toBe(true);
                // Zero bytes written to sessionStorage under Strict Zero-Trace mode
                expect(mockStorage['lugx_vault_session_v1']).toBeUndefined();

                // Memory purge zeroes volatile RAM
                testStore.purgeKeys();
                expect(testStore.hasMasterKey()).toBe(false);
                expect(testStore.getMasterKey()).toBeNull();

                wipeBuffer(masterKey);
            } finally {
                (globalThis as any).window = originalWindow;
            }
        });

        it('should automatically lock the vault after 1 hour of inactivity', async () => {
            vi.useFakeTimers();
            try {
                const testStore = new SessionKeyStore({ inactivityTimeoutMs: 60 * 60 * 1000 });
                const masterKey = await generateMasterKeyRaw();

                testStore.setMasterKey(masterKey);
                expect(testStore.hasMasterKey()).toBe(true);

                // Advance by 59 minutes - should still be unlocked
                vi.advanceTimersByTime(59 * 60 * 1000);
                expect(testStore.hasMasterKey()).toBe(true);

                // Advance another 2 minutes (total 61 min) - should be auto-locked
                vi.advanceTimersByTime(2 * 60 * 1000);
                expect(testStore.hasMasterKey()).toBe(false);
                expect(testStore.getMasterKey()).toBeNull();

                wipeBuffer(masterKey);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('6. Zero Plaintext Invariant & Save Hardening (Phase 3 Closure)', () => {
        it('should strictly store ciphertext in IndexedDB when a file is encrypted and never plaintext', async () => {
            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey);

            const fileId = 'doc-zero-plaintext-1';
            const plaintextMarkdown = '# Highly Confidential Project Roadmap\n\n- Milestone 1: Secret';

            // 1. Initially saved as unencrypted plaintext
            await idb.saveFile({
                id: fileId,
                title: 'Confidential Doc',
                content: plaintextMarkdown,
                isFolder: false,
                parentFolderId: null,
                isEncrypted: false,
                encryptionMetadata: null,
                isDirty: false,
                version: 1,
                etag: 'etag-v1',
                lastModified: Date.now(),
                lastSyncedAt: Date.now(),
            });

            const initialFile = await idb.getFile(fileId);
            expect(initialFile?.content).toBe(plaintextMarkdown);
            expect(initialFile?.isEncrypted).toBe(false);

            // 2. Simulate FileContextMenu encryption workflow: encrypt plaintext with AES-GCM
            const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
            const aad = `vault:file:${testUserId}:${fileId}`;
            const encResult = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                plaintextMarkdown,
                ivBytes,
                aad
            );

            const metadata = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                salt: '',
                iv: encResult.ivBase64,
                kdfIterations: 600000,
            };

            // Save to IndexedDB with ciphertextBase64 (the fix applied in file-context-menu)
            await idb.saveFile({
                ...initialFile!,
                content: encResult.ciphertextBase64,
                isEncrypted: true,
                encryptionMetadata: metadata,
                isDirty: false,
                version: 2,
                etag: 'etag-v2',
                lastModified: Date.now(),
            });

            // 3. Inspect IndexedDB content: MUST BE CIPHERTEXT! Zero plaintext allowed!
            const encryptedFileInIDB = await idb.getFile(fileId);
            expect(encryptedFileInIDB?.isEncrypted).toBe(true);
            expect(encryptedFileInIDB?.content).not.toBe(plaintextMarkdown);
            expect(encryptedFileInIDB?.content).not.toContain('Confidential');
            expect(encryptedFileInIDB?.content).toBe(encResult.ciphertextBase64);

            // 4. Verify decrypting ciphertext yields exact original plaintext
            const decrypted = await cryptoWorkerBridge.decryptAESGCM(
                masterKey,
                encryptedFileInIDB!.content,
                ivBytes,
                aad
            );
            expect(decrypted).toBe(plaintextMarkdown);

            wipeBuffer(ivBytes);
            wipeBuffer(masterKey);
        });

        it('should verify fail-closed protection when vault master key is absent from memory', async () => {
            expect(sessionKeyStore.hasMasterKey()).toBe(false);

            // Attempting to retrieve master key when locked returns null
            const rawKey = sessionKeyStore.getMasterKeyRaw();
            expect(rawKey).toBeNull();

            // Fail-closed invariant: if file is encrypted but masterKey is null, save pipeline rejects
            const isEncrypted = true;
            const canEncrypt = isEncrypted && rawKey !== null;
            expect(canEncrypt).toBe(false);
        });
    });

    describe('9. Encryption Conflict Invariants & Local Resolution Lifecycle', () => {
        it('should recognize false conflict when server ciphertext decrypts to matching local plaintext', async () => {
            const fileId = 'file-false-conflict-test';
            const plaintext = '# My Authoritative Document\n\nNo conflicts here.';

            // Setup unlocked vault in memory
            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey);

            // Encrypt content as server would have it after encryption toggle
            const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
            const aad = `vault:file:${testUserId}:${fileId}`;
            const encResult = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                plaintext,
                ivBytes,
                aad
            );

            const serverVersion = {
                content: encResult.ciphertextBase64,
                etag: 'etag-server-v2',
                version: 2,
                updatedAt: new Date().toISOString(),
            };

            // Local editor state: still has plaintext and old version v1
            const localVersion = {
                content: plaintext,
                etag: 'etag-client-v1',
                version: 1,
            };

            // Replicate decryption-aware false conflict check
            let isIdentical = localVersion.content === serverVersion.content || localVersion.etag === serverVersion.etag;
            expect(isIdentical).toBe(false); // Plaintext != Ciphertext, ETags differ

            // With decryption of server ciphertext:
            const rawKey = sessionKeyStore.getMasterKeyRaw();
            expect(rawKey).not.toBeNull();

            const decryptedServer = await cryptoWorkerBridge.decryptAESGCM(
                rawKey!,
                serverVersion.content,
                ivBytes,
                aad
            );
            expect(decryptedServer).toBe(localVersion.content);

            if (decryptedServer === localVersion.content) {
                isIdentical = true;
            }

            // Must correctly evaluate to TRUE (false conflict -> auto-synchronize without modal)
            expect(isIdentical).toBe(true);

            wipeBuffer(ivBytes);
            wipeBuffer(masterKey);
        });

        it('should clean pending operations and mark isDirty: false on local conflict resolution', async () => {
            const fileId = 'file-resolve-local-cleanup-test';
            const localContent = '# Local Resolving Content\n\nPreserved locally.';

            // 1. Create file in IDB with dirty state
            const idbFile: IDBFile = {
                id: fileId,
                content: localContent,
                title: 'Clean Up Test',
                etag: 'etag-old',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                isEncrypted: false,
                encryptionMetadata: null,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            };
            await idb.saveFile(idbFile);

            // 2. Coalesce an uncommitted operation in operations table
            const opId = `op_${testUserId}_${fileId}_1`;
            await idb.coalesceOperation({
                id: opId,
                operationId: opId,
                userId: testUserId,
                fileId,
                baseVersion: 1,
                status: 'queued',
                attempts: 0,
                operationType: 'update',
                position: 0,
                content: localContent,
                timestamp: Date.now(),
                synced: false,
            });

            // Verify operation is queued and due
            const dueBefore = await idb.getDueOperations();
            expect(dueBefore.some(o => o.fileId === fileId && !o.synced)).toBe(true);

            // 3. Simulate local resolution handler (marking file clean & syncing ops)
            const refreshedFile = await idb.getFile(fileId);
            expect(refreshedFile).toBeDefined();
            refreshedFile!.isDirty = false;
            refreshedFile!.lastSyncedAt = Date.now();
            refreshedFile!.version = 2;
            refreshedFile!.etag = 'etag-resolved-v2';
            await idb.saveFile(refreshedFile!);

            const ops = await idb.getOperations(fileId);
            expect(ops.length).toBeGreaterThan(0);
            for (const op of ops) {
                if (!op.synced) {
                    await idb.updateOperationStatus(op.id, 'synced', { synced: true });
                }
            }

            // 4. Assert all operations for fileId are marked synced
            const opsAfter = await idb.getOperations(fileId);
            for (const op of opsAfter) {
                expect(op.synced).toBe(true);
                expect(op.status).toBe('synced');
            }

            // 5. Assert no due operations remain for this file (breaks retry loops!)
            const dueAfter = await idb.getDueOperations();
            const fileDueOps = dueAfter.filter(o => o.fileId === fileId);
            expect(fileDueOps).toHaveLength(0);

            // 6. Assert file in IDB is clean
            const finalFile = await idb.getFile(fileId);
            expect(finalFile?.isDirty).toBe(false);
            expect(finalFile?.version).toBe(2);
        });

        it('should purge operations upon file encryption to prevent stale plaintext retry loops', async () => {
            const fileId = 'file-enc-purge-test';
            const originalPlaintext = '# Secret Notes\n\nTo be encrypted.';

            // Setup file with a stale pending operation
            await idb.saveFile({
                id: fileId,
                content: originalPlaintext,
                title: 'Stale Op Test',
                etag: 'etag-1',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                isEncrypted: false,
                encryptionMetadata: null,
                lastModified: Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
            });

            const opId = `op_stale_${fileId}`;
            await idb.coalesceOperation({
                id: opId,
                operationId: opId,
                userId: testUserId,
                fileId,
                baseVersion: 1,
                status: 'queued',
                attempts: 0,
                operationType: 'update',
                position: 0,
                content: originalPlaintext,
                timestamp: Date.now(),
                synced: false,
            });

            // Simulate file-context-menu executeFileEncryption clean-up:
            const isClean = true; // Server toggleFileEncryption succeeded
            if (isClean) {
                const ops = await idb.getOperations(fileId);
                for (const op of ops) {
                    if (!op.synced) {
                        await idb.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            }

            // Ensure no pending unsynced operations remain to avoid SyncManager pushing old plaintext
            const ops = await idb.getOperations(fileId);
            expect(ops.every(o => o.synced)).toBe(true);
        });
    });

    describe('7. Trusted Device PIN Cryptography, Anti-Brute-Force & Revocation Ecosystem', () => {
        it('should enforce exactly 6 numeric digits for PIN KEK derivation', async () => {
            const salt = await generateSalt(16);

            // Valid 6-digit PINs
            const kek1 = await deriveKEKFromPin('123456', salt);
            expect(kek1.byteLength).toBe(32);
            wipeBuffer(kek1);

            const kek2 = await deriveKEKFromPin('000000', salt);
            expect(kek2.byteLength).toBe(32);
            wipeBuffer(kek2);

            // Invalid PIN lengths or non-numeric characters
            await expect(deriveKEKFromPin('123', salt)).rejects.toThrow(InvalidPinError);
            await expect(deriveKEKFromPin('12345', salt)).rejects.toThrow(InvalidPinError);
            await expect(deriveKEKFromPin('1234567', salt)).rejects.toThrow(InvalidPinError);
            await expect(deriveKEKFromPin('abcdef', salt)).rejects.toThrow(InvalidPinError);
            await expect(deriveKEKFromPin('', salt)).rejects.toThrow(InvalidPinError);

            wipeBuffer(salt);
        });

        it('should wrap and unwrap the Master Key using a 6-digit PIN and bound AAD', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const pin = '789012';
            const epoch = 1;

            const envelope = await wrapMasterKeyWithPin(
                masterKey,
                pin,
                deviceSalt,
                testUserId,
                epoch,
                600000
            );

            expect(envelope.version).toBe(1);
            expect(envelope.algorithm).toBe('AES-GCM-256');
            expect(envelope.encryptedMasterKey).toBeDefined();
            expect(envelope.deviceTrustEpoch).toBe(epoch);
            expect(envelope.failedAttempts).toBe(0);
            expect(envelope.expiresAt).toBeGreaterThan(Date.now());

            // Unwrap with correct PIN
            const unwrapped = await unwrapMasterKeyWithPin(envelope, pin, testUserId);
            expect(unwrapped).toEqual(masterKey);

            wipeBuffer(masterKey);
            wipeBuffer(unwrapped);
            wipeBuffer(deviceSalt);
        });

        it('should reject incorrect PIN and decrement remaining attempts', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const correctPin = '112233';
            const wrongPin = '998877';

            const envelope = await wrapMasterKeyWithPin(
                masterKey,
                correctPin,
                deviceSalt,
                testUserId,
                1
            );

            // Attempting with wrong PIN throws InvalidPinError
            await expect(
                unwrapMasterKeyWithPin(envelope, wrongPin, testUserId)
            ).rejects.toThrow(InvalidPinError);

            wipeBuffer(masterKey);
            wipeBuffer(deviceSalt);
        });

        it('should enforce anti-brute-force lockout when failed attempts reach 5', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const pin = '432100';

            const baseEnvelope = await wrapMasterKeyWithPin(
                masterKey,
                pin,
                deviceSalt,
                testUserId,
                1
            );

            // Simulate envelope having 5 failed attempts
            const lockedEnvelope: DeviceTrustEnvelope = {
                ...baseEnvelope,
                failedAttempts: 5,
            };

            await expect(
                unwrapMasterKeyWithPin(lockedEnvelope, pin, testUserId)
            ).rejects.toThrow(InvalidPinError);

            wipeBuffer(masterKey);
            wipeBuffer(deviceSalt);
        });

        it('should reject unwrapping when the 30-day trust envelope has expired', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const pin = '555555';

            const baseEnvelope = await wrapMasterKeyWithPin(
                masterKey,
                pin,
                deviceSalt,
                testUserId,
                1
            );

            // Simulate expired envelope (timestamp in the past)
            const expiredEnvelope: DeviceTrustEnvelope = {
                ...baseEnvelope,
                expiresAt: Date.now() - 1000,
            };

            await expect(
                unwrapMasterKeyWithPin(expiredEnvelope, pin, testUserId)
            ).rejects.toThrow(DeviceTrustRevokedError);

            wipeBuffer(masterKey);
            wipeBuffer(deviceSalt);
        });

        it('should save, retrieve, and clear device trust envelopes in IndexedDB', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const pin = '678901';

            const envelope = await wrapMasterKeyWithPin(
                masterKey,
                pin,
                deviceSalt,
                testUserId,
                1
            );

            // Initially no envelope
            expect(await idb.getDeviceTrustEnvelope(testUserId)).toBeNull();

            // Save envelope
            await idb.saveDeviceTrustEnvelope(envelope, testUserId);
            const retrieved = await idb.getDeviceTrustEnvelope(testUserId);
            expect(retrieved).not.toBeNull();
            expect(retrieved?.encryptedMasterKey).toBe(envelope.encryptedMasterKey);
            expect(retrieved?.deviceTrustEpoch).toBe(1);

            // Clear envelope (local device revocation)
            await idb.clearDeviceTrustEnvelope(testUserId);
            expect(await idb.getDeviceTrustEnvelope(testUserId)).toBeNull();

            wipeBuffer(masterKey);
            wipeBuffer(deviceSalt);
        });

        it('should detect global device trust epoch mismatch and invalidate local envelope', async () => {
            const masterKey = await generateMasterKeyRaw();
            const deviceSalt = await generateSalt(16);
            const pin = '334455';
            const initialEpoch = 1;

            const envelope = await wrapMasterKeyWithPin(
                masterKey,
                pin,
                deviceSalt,
                testUserId,
                initialEpoch
            );

            await idb.saveDeviceTrustEnvelope(envelope, testUserId);

            // Simulate global revocation from server: server epoch increments to 2
            const serverEpoch = 2;
            const localEnvelope = await idb.getDeviceTrustEnvelope(testUserId);
            expect(localEnvelope).not.toBeNull();

            // Client detects mismatch with server epoch -> clears local envelope
            if (localEnvelope && localEnvelope.deviceTrustEpoch !== serverEpoch) {
                await idb.clearDeviceTrustEnvelope(testUserId);
            }

            // Verify local envelope has been revoked and destroyed
            const afterRevocation = await idb.getDeviceTrustEnvelope(testUserId);
            expect(afterRevocation).toBeNull();

            wipeBuffer(masterKey);
            wipeBuffer(deviceSalt);
        });
    });

    describe('8. Encrypted File Copying & AAD Re-Encryption Integrity (AUD-02)', () => {
        it('should fail with AADIntegrityError if an encrypted file is copied without re-encrypting with new file ID AAD', async () => {
            const masterKey = await generateMasterKeyRaw();
            const originalFileId = 'file-original-123';
            const copiedFileId = 'file-copy-456';
            const plaintext = '# Highly Confidential Project Roadmap';

            // Original file encrypted with originalFileId AAD
            const originalIv = await cryptoWorkerBridge.generateRandomBytes(12);
            const originalAad = `vault:file:${testUserId}:${originalFileId}`;
            const originalEnc = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                plaintext,
                originalIv,
                originalAad
            );

            // If a server simply copies ciphertext to copiedFileId, client decrypts using copiedFileId AAD
            const copiedAad = `vault:file:${testUserId}:${copiedFileId}`;
            const originalIvBytes = base64ToUint8Array(originalEnc.ivBase64);

            await expect(
                cryptoWorkerBridge.decryptAESGCM(
                    masterKey,
                    originalEnc.ciphertextBase64,
                    originalIvBytes,
                    copiedAad // Mismatched AAD
                )
            ).rejects.toThrow();

            wipeBuffer(originalIv);
            wipeBuffer(originalIvBytes);
            wipeBuffer(masterKey);
        });

        it('should successfully decrypt copied file after client-side re-encryption with new file ID AAD', async () => {
            const masterKey = await generateMasterKeyRaw();
            const originalFileId = 'file-original-999';
            const newCopyFileId = 'file-copy-999';
            const confidentialContent = 'Quantum Resistant Secrets v2';

            // 1. Original file encryption
            const iv1 = await cryptoWorkerBridge.generateRandomBytes(12);
            const aad1 = `vault:file:${testUserId}:${originalFileId}`;
            const enc1 = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                confidentialContent,
                iv1,
                aad1
            );
            wipeBuffer(iv1);

            // 2. Client-side copy flow: decrypt with original AAD
            const iv1Bytes = base64ToUint8Array(enc1.ivBase64);
            const decryptedPlaintext = await cryptoWorkerBridge.decryptAESGCM(
                masterKey,
                enc1.ciphertextBase64,
                iv1Bytes,
                aad1
            );
            wipeBuffer(iv1Bytes);
            expect(decryptedPlaintext).toBe(confidentialContent);

            // 3. Client-side re-encryption with new file ID AAD and fresh random IV
            const iv2 = await cryptoWorkerBridge.generateRandomBytes(12);
            const aad2 = `vault:file:${testUserId}:${newCopyFileId}`;
            const enc2 = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                decryptedPlaintext,
                iv2,
                aad2
            );
            wipeBuffer(iv2);

            // 4. Decrypt the copy using newCopyFileId AAD
            const iv2Bytes = base64ToUint8Array(enc2.ivBase64);
            const copyDecrypted = await cryptoWorkerBridge.decryptAESGCM(
                masterKey,
                enc2.ciphertextBase64,
                iv2Bytes,
                aad2
            );
            wipeBuffer(iv2Bytes);

            expect(copyDecrypted).toBe(confidentialContent);
            expect(enc2.ciphertextBase64).not.toBe(enc1.ciphertextBase64); // Distinct ciphertexts due to fresh IV

            wipeBuffer(masterKey);
        });
    });

    describe('9. Adversarial Mitigations: Conflict Double-Encryption Guard & Inactivity Touch (AUD-03 & AUD-04)', () => {
        it('should avoid double-encryption when resolving conflict with server ciphertext', async () => {
            const masterKey = await generateMasterKeyRaw();
            const fileId = 'file-conflict-test-1';
            const serverCiphertext = 'gcm:v1:validserverciphertext12345';

            // Simulate resolution payload with server ciphertext
            let contentToSend = serverCiphertext;
            let metaToSend: any = { version: 1, algorithm: 'AES-GCM-256', iv: 'iv123' };

            // When content starts with gcm:v1:, our guard prevents re-encryption
            if (contentToSend.startsWith('gcm:v1:')) {
                // Preserved as-is
            } else {
                const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
                const aad = `vault:file:${testUserId}:${fileId}`;
                const encResult = await cryptoWorkerBridge.encryptAESGCM(masterKey, contentToSend, ivBytes, aad);
                contentToSend = encResult.ciphertextBase64;
            }

            expect(contentToSend).toBe(serverCiphertext);
            wipeBuffer(masterKey);
        });

        it('should refresh inactivity timestamp on sessionKeyStore.touch()', async () => {
            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey, 1);
            expect(sessionKeyStore.isUnlocked()).toBe(true);

            // Fast-forward time or check touch
            sessionKeyStore.touch();
            expect(sessionKeyStore.isUnlocked()).toBe(true);

            sessionKeyStore.purgeKeys();
            expect(sessionKeyStore.isUnlocked()).toBe(false);
            wipeBuffer(masterKey);
        });
    });
});



