/**
 * Phase 5 Closure: Vault Recovery (Matrix #3 Vault Activation, #4 Seed Flow).
 * Real WebCrypto, reduced PBKDF2 iterations for fast deterministic execution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    generateMasterKeyRaw, generateSalt,
    wrapMasterKeyWithPassword, unwrapMasterKeyWithPassword,
    wrapMasterKeyWithRecoverySeed, unwrapMasterKeyWithRecoverySeed,
    encryptEnvelope, decryptEnvelope,
    generateMnemonic, validateMnemonic,
    sessionKeyStore, wipeBuffer, arrayBufferToBase64,
    type EncryptedEnvelope,
} from '../lib/sync';
const TEST_ITERATIONS = 5000;
const TEST_USER = 'user-recovery-closure-5';
describe('Phase 5 Closure: Vault Recovery & Rotation (Matrix #3/#4)', () => {
    beforeEach(() => { sessionKeyStore.purgeKeys(); });
    afterEach(() => { sessionKeyStore.purgeKeys(); });
    it('#3 locked vault requires password; wrong password rejected', async () => {
        const masterKey = await generateMasterKeyRaw();
        const password = 'VaultPass#2026-Closure';
        const keySalt = await generateSalt(16);
        const wrapped = await wrapMasterKeyWithPassword(masterKey, password, keySalt, TEST_USER, TEST_ITERATIONS);
        expect(sessionKeyStore.hasMasterKey()).toBe(false);
        expect(sessionKeyStore.isUnlocked()).toBe(false);
        const unwrapped = await unwrapMasterKeyWithPassword(wrapped.wrappedKeyBase64, wrapped.ivBase64, password, keySalt, TEST_USER, TEST_ITERATIONS);
        expect(Array.from(unwrapped)).toEqual(Array.from(masterKey));
        sessionKeyStore.setMasterKey(unwrapped);
        expect(sessionKeyStore.isUnlocked()).toBe(true);
        await expect(unwrapMasterKeyWithPassword(wrapped.wrappedKeyBase64, wrapped.ivBase64, 'WrongPassword!', keySalt, TEST_USER, TEST_ITERATIONS)).rejects.toThrow();
        wipeBuffer(masterKey); wipeBuffer(unwrapped); wipeBuffer(keySalt);
    });
    it('#4 seed recovery unwraps key, rotates password, files open without re-encryption', async () => {
        const mnemonic = await generateMnemonic(16);
        expect((await validateMnemonic(mnemonic)).isValid).toBe(true);
        const masterKey = await generateMasterKeyRaw();
        const oldPassword = 'OldVaultPassword!1';
        const newPassword = 'NewVaultPassword!2';
        const keySalt = await generateSalt(16);
        const recoverySalt = await generateSalt(16);
        const passWrapped = await wrapMasterKeyWithPassword(masterKey, oldPassword, keySalt, TEST_USER, TEST_ITERATIONS);
        void passWrapped;
        const seedWrapped = await wrapMasterKeyWithRecoverySeed(masterKey, mnemonic, recoverySalt, TEST_USER, TEST_ITERATIONS);
        const fileId = 'file-recovery-doc-1';
        const aad = `vault:file:${TEST_USER}:${fileId}`;
        const plaintext = '# Recovery Doc\n\nSecret content survives password rotation.';
        const envelopeSaltB64 = arrayBufferToBase64(await generateSalt(16));
        const envelope: EncryptedEnvelope = await encryptEnvelope(plaintext, masterKey, 'master-v1', envelopeSaltB64, aad, TEST_ITERATIONS);
        sessionKeyStore.purgeKeys();
        expect(sessionKeyStore.isUnlocked()).toBe(false);
        const recovered = await unwrapMasterKeyWithRecoverySeed(seedWrapped.wrappedKeyBase64, seedWrapped.ivBase64, mnemonic, recoverySalt, TEST_USER, TEST_ITERATIONS);
        expect(Array.from(recovered)).toEqual(Array.from(masterKey));
        const newKeySalt = await generateSalt(16);
        const rotated = await wrapMasterKeyWithPassword(recovered, newPassword, newKeySalt, TEST_USER, TEST_ITERATIONS);
        const unlockedAfterRotation = await unwrapMasterKeyWithPassword(rotated.wrappedKeyBase64, rotated.ivBase64, newPassword, newKeySalt, TEST_USER, TEST_ITERATIONS);
        expect(Array.from(unlockedAfterRotation)).toEqual(Array.from(masterKey));
        await expect(unwrapMasterKeyWithPassword(rotated.wrappedKeyBase64, rotated.ivBase64, oldPassword, newKeySalt, TEST_USER, TEST_ITERATIONS)).rejects.toThrow();
        expect(await decryptEnvelope(envelope, recovered, aad)).toBe(plaintext);
        sessionKeyStore.setMasterKey(recovered);
        expect(sessionKeyStore.isUnlocked()).toBe(true);
        wipeBuffer(masterKey); wipeBuffer(recovered); wipeBuffer(unlockedAfterRotation);
        wipeBuffer(keySalt); wipeBuffer(recoverySalt); wipeBuffer(newKeySalt);
    });
    it('#4 tampered mnemonic is rejected', async () => {
        const mnemonic = await generateMnemonic(16);
        const words = mnemonic.trim().split(/\s+/);
        expect(words).toHaveLength(12);
        const masterKey = await generateMasterKeyRaw();
        const recoverySalt = await generateSalt(16);
        const seedWrapped = await wrapMasterKeyWithRecoverySeed(masterKey, mnemonic, recoverySalt, TEST_USER, TEST_ITERATIONS);
        const tampered = [...words];
        tampered[0] = tampered[0] === 'abandon' ? 'ability' : 'abandon';
        await expect(unwrapMasterKeyWithRecoverySeed(seedWrapped.wrappedKeyBase64, seedWrapped.ivBase64, tampered.join(' '), recoverySalt, TEST_USER, TEST_ITERATIONS)).rejects.toThrow();
        wipeBuffer(masterKey); wipeBuffer(recoverySalt);
    });
});
