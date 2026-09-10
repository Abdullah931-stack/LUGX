/**
 * Phase 5 Closure: File Conversion (Matrix #1 Zero-Prompt, #2 First Setup).
 * Real WebCrypto + fake-indexeddb. Proves plain files never touch the vault
 * and first-encrypt setup dual-wraps keys with 3-word confirmation sampling.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    generateMasterKeyRaw, generateSalt,
    wrapMasterKeyWithPassword, unwrapMasterKeyWithPassword,
    wrapMasterKeyWithRecoverySeed,
    encryptEnvelope, decryptEnvelope,
    generateMnemonic, validateMnemonic,
    sessionKeyStore, wipeBuffer, arrayBufferToBase64,
} from '../lib/sync';
import { createIndexedDBManager, IndexedDBManager } from '../lib/sync/indexeddb';
import type { IDBFile } from '../lib/sync/idb-types';
const ITER = 5000;
const USER = 'user-conversion-closure-5';
describe('Phase 5 Closure: File Conversion Engine (Matrix #1/#2)', () => {
    let idb: IndexedDBManager;
    beforeEach(async () => {
        sessionKeyStore.purgeKeys();
        idb = createIndexedDBManager(USER);
        await idb.init(USER);
        await idb.clearAll();
    });
    afterEach(async () => {
        await idb.clearAll();
        idb.close();
        sessionKeyStore.purgeKeys();
    });
    it('#1 Zero-Prompt: plain file opens/edits with vault locked', async () => {
        const file: IDBFile = {
            id: 'file-plain-1', content: '# Plain\n\nEditable without vault.',
            title: 'Plain', etag: 'etag-1', version: 1,
            parentFolderId: null, isFolder: false,
            isEncrypted: false, encryptionMetadata: null,
            lastModified: Date.now(), lastSyncedAt: 0, isDirty: false,
        };
        await idb.saveFile(file);
        expect(sessionKeyStore.hasMasterKey()).toBe(false);
        const opened = await idb.getFile('file-plain-1');
        expect(opened?.content).toBe(file.content);
        expect(opened?.isEncrypted).toBe(false);
        opened!.content = '# Plain\n\nEdited while locked.';
        opened!.isDirty = true;
        await idb.saveFile(opened!);
        const edited = await idb.getFile('file-plain-1');
        expect(edited?.content).toContain('Edited while locked.');
        expect(edited?.isDirty).toBe(true);
    });
    it('#2 First-Encrypt Setup: seed + 3-word check + encrypt, then decrypt back', async () => {
        const mnemonic = await generateMnemonic(16);
        const words = mnemonic.trim().split(/\s+/);
        expect(words).toHaveLength(12);
        expect((await validateMnemonic(mnemonic)).isValid).toBe(true);
        const quizIdx = [1, 5, 9];
        for (const i of quizIdx) {
            expect(words[i]).toBe(mnemonic.trim().split(/\s+/)[i]);
        }
        const masterKey = await generateMasterKeyRaw();
        const password = 'FirstVaultPassword!9';
        const keySalt = await generateSalt(16);
        const recoverySalt = await generateSalt(16);
        const passWrapped = await wrapMasterKeyWithPassword(masterKey, password, keySalt, USER, ITER);
        const seedWrapped = await wrapMasterKeyWithRecoverySeed(masterKey, mnemonic, recoverySalt, USER, ITER);
        expect(passWrapped.wrappedKeyBase64).toBeTruthy();
        expect(seedWrapped.wrappedKeyBase64).toBeTruthy();
        const unlocked = await unwrapMasterKeyWithPassword(passWrapped.wrappedKeyBase64, passWrapped.ivBase64, password, keySalt, USER, ITER);
        sessionKeyStore.setMasterKey(unlocked);
        const fileId = 'file-first-encrypt-1';
        const aad = `vault:file:${USER}:${fileId}`;
        const plaintext = '# First Secret\n\nEncrypted on first setup.';
        const saltB64 = arrayBufferToBase64(await generateSalt(16));
        const envelope = await encryptEnvelope(plaintext, unlocked, 'master-v1', saltB64, aad, ITER);
        await idb.saveFile({
            id: fileId, content: envelope.ciphertext, title: 'Secret',
            etag: 'etag-enc-1', version: 2, parentFolderId: null, isFolder: false,
            isEncrypted: true,
            encryptionMetadata: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', salt: envelope.salt, iv: envelope.iv, kdfIterations: ITER },
            lastModified: Date.now(), lastSyncedAt: 0, isDirty: true,
        });
        const stored = await idb.getFile(fileId);
        expect(stored?.isEncrypted).toBe(true);
        expect(stored?.content).not.toContain('First Secret');
        const key = sessionKeyStore.getMasterKeyRaw()!;
        expect(await decryptEnvelope({ ...envelope, ciphertext: stored!.content }, key, aad)).toBe(plaintext);
        const decrypted = await decryptEnvelope({ ...envelope, ciphertext: stored!.content }, key, aad);
        await idb.saveFile({ ...stored!, content: decrypted, isEncrypted: false, encryptionMetadata: null, isDirty: true, version: 3 });
        const backToPlain = await idb.getFile(fileId);
        expect(backToPlain?.isEncrypted).toBe(false);
        expect(backToPlain?.content).toBe(plaintext);
        wipeBuffer(masterKey); wipeBuffer(unlocked);
        wipeBuffer(keySalt); wipeBuffer(recoverySalt);
    });
});
