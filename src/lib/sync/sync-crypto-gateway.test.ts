import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncCryptoGateway } from './sync-crypto-gateway';
import { sessionKeyStore } from './session-key-store';
import { cryptoWorkerBridge } from './crypto-worker-bridge';

describe('SyncCryptoGateway', () => {
    const testUserId = 'user-test-uuid-123';
    const testFileId = 'file-test-uuid-456';
    const rawMasterKey = new Uint8Array(32).fill(7);

    beforeEach(() => {
        sessionKeyStore.purgeKeys();
    });

    afterEach(() => {
        sessionKeyStore.purgeKeys();
    });

    it('should transparently pass-through unencrypted plaintext payloads', async () => {
        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: '# Plaintext Document\nHello world',
            isEncrypted: false,
            userId: testUserId,
        });

        expect(result.status).toBe('plaintext');
        expect(result.isEncrypted).toBe(false);
        expect(result.isVaultLocked).toBe(false);
        expect(result.content).toBe('# Plaintext Document\nHello world');
        expect(result.encryptionMetadata).toBeNull();
    });

    it('should return locked status when vault is locked for encrypted payload', async () => {
        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: 'encrypted-base64-payload',
            isEncrypted: true,
            encryptionMetadata: {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                salt: '',
                iv: 'test-iv-base64',
            },
            userId: testUserId,
        });

        expect(result.status).toBe('locked');
        expect(result.isEncrypted).toBe(true);
        expect(result.isVaultLocked).toBe(true);
        expect(result.content).toBe('encrypted-base64-payload');
        expect(result.encryptionMetadata?.iv).toBe('test-iv-base64');
    });

    it('should fail gracefully if encryptionMetadata or IV is missing for encrypted file', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const result = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: 'some-ciphertext',
            isEncrypted: true,
            encryptionMetadata: null,
            userId: testUserId,
        });

        expect(result.status).toBe('error');
        expect(result.error).toContain('Missing IV');
    });

    it('should correctly encrypt outbound and decrypt inbound symmetrically', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const originalText = '# Confidential Vault Document\nTop secret content.';
        const encrypted = await SyncCryptoGateway.encryptOutbound(
            testFileId,
            originalText,
            testUserId
        );

        expect(encrypted.ciphertextBase64).toBeDefined();
        expect(encrypted.ciphertextBase64.length).toBeGreaterThan(10);
        expect(encrypted.ciphertextBase64).not.toBe(originalText);
        expect(encrypted.encryptionMetadata.iv).toBeDefined();
        expect(encrypted.encryptionMetadata.algorithm).toBe('AES-GCM-256');

        // Now decrypt with Inbound Gateway
        const decrypted = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: encrypted.ciphertextBase64,
            isEncrypted: true,
            encryptionMetadata: encrypted.encryptionMetadata,
            userId: testUserId,
        });

        expect(decrypted.status).toBe('decrypted');
        expect(decrypted.isEncrypted).toBe(true);
        expect(decrypted.isVaultLocked).toBe(false);
        expect(decrypted.content).toBe(originalText);
        expect(decrypted.encryptionMetadata?.iv).toBe(encrypted.encryptionMetadata.iv);
    });

    it('should fail with error if ciphertext is tampered or AAD mismatch occurs', async () => {
        sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);

        const originalText = 'Secret data';
        const encrypted = await SyncCryptoGateway.encryptOutbound(
            testFileId,
            originalText,
            testUserId
        );

        // Tamper with userId (AAD mismatch)
        const tamperedDecryption = await SyncCryptoGateway.decryptInbound({
            fileId: testFileId,
            content: encrypted.ciphertextBase64,
            isEncrypted: true,
            encryptionMetadata: encrypted.encryptionMetadata,
            userId: 'foreign-user-id',
        });

        expect(tamperedDecryption.status).toBe('error');
        expect(tamperedDecryption.error).toBeDefined();
    });
});
