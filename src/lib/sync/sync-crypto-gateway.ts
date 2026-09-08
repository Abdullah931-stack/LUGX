/**
 * Inbound & Outbound Cryptographic Gateway (Zero-Knowledge Vault Sync)
 *
 * Provides deterministic transparent decryption for incoming remote payloads
 * (pull updates, background broadcasts, and HTTP 412 conflict envelopes)
 * and secure authenticated encryption for outbound payloads.
 */

import { sessionKeyStore } from './session-key-store';
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from './crypto-worker-bridge';
import { EncryptedEnvelopeMetadata } from './idb-types';

export interface InboundPayloadInput {
    fileId: string;
    content: string;
    isEncrypted?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | Partial<EncryptedEnvelopeMetadata> | null;
    userId?: string;
}

export interface InboundPayloadResult {
    fileId: string;
    content: string;
    isEncrypted: boolean;
    isVaultLocked: boolean;
    status: 'plaintext' | 'decrypted' | 'locked' | 'error';
    encryptionMetadata: EncryptedEnvelopeMetadata | null;
    error?: string;
}

export interface OutboundPayloadResult {
    ciphertextBase64: string;
    encryptionMetadata: EncryptedEnvelopeMetadata;
}

export class SyncCryptoGateway {
    /**
     * Constructs standard authenticated additional data (AAD) binding
     */
    public static computeAad(userId: string | undefined, fileId: string): string {
        return `vault:file:${userId || ''}:${fileId}`;
    }

    /**
     * Inbound Gateway: Transparently decrypts incoming payloads from server if encrypted.
     * If vault is locked, flags as 'locked' so callers can route to quarantine / avoid corrupting UI.
     */
    public static async decryptInbound(payload: InboundPayloadInput): Promise<InboundPayloadResult> {
        const { fileId, content, isEncrypted, encryptionMetadata, userId } = payload;

        // If not marked encrypted or empty content, return raw content as plaintext
        if (!isEncrypted || !content) {
            return {
                fileId,
                content: content || '',
                isEncrypted: false,
                isVaultLocked: false,
                status: 'plaintext',
                encryptionMetadata: null,
            };
        }

        // Vault Lock Guard
        const masterKey = sessionKeyStore.getMasterKeyRaw();
        if (!masterKey) {
            return {
                fileId,
                content,
                isEncrypted: true,
                isVaultLocked: true,
                status: 'locked',
                encryptionMetadata: (encryptionMetadata as EncryptedEnvelopeMetadata) || null,
            };
        }

        const ivString = encryptionMetadata?.iv;
        if (!ivString) {
            // Missing IV is a cryptographic defect
            return {
                fileId,
                content,
                isEncrypted: true,
                isVaultLocked: false,
                status: 'error',
                error: 'Missing IV in encryptionMetadata for encrypted payload',
                encryptionMetadata: (encryptionMetadata as EncryptedEnvelopeMetadata) || null,
            };
        }

        let ivBytes: Uint8Array | null = null;
        try {
            ivBytes = base64ToUint8Array(ivString);
            const aad = this.computeAad(userId, fileId);

            const decryptedPlaintext = await cryptoWorkerBridge.decryptAESGCM(
                masterKey,
                content,
                ivBytes,
                aad
            );

            return {
                fileId,
                content: decryptedPlaintext,
                isEncrypted: true,
                isVaultLocked: false,
                status: 'decrypted',
                encryptionMetadata: {
                    version: encryptionMetadata?.version || 1,
                    algorithm: encryptionMetadata?.algorithm || 'AES-GCM-256',
                    keyId: encryptionMetadata?.keyId || 'master-v1',
                    salt: encryptionMetadata?.salt || '',
                    iv: ivString,
                    kdfIterations: encryptionMetadata?.kdfIterations || 600000,
                },
            };
        } catch (err) {
            return {
                fileId,
                content,
                isEncrypted: true,
                isVaultLocked: false,
                status: 'error',
                error: err instanceof Error ? err.message : 'Decryption failed (authentication tag mismatch or corrupted payload)',
                encryptionMetadata: (encryptionMetadata as EncryptedEnvelopeMetadata) || null,
            };
        } finally {
            if (ivBytes) {
                wipeBuffer(ivBytes);
            }
        }
    }

    /**
     * Outbound Gateway: Encrypts plaintext with volatile MasterKey and a fresh 12-byte CSPRNG IV
     */
    public static async encryptOutbound(
        fileId: string,
        plaintext: string,
        userId?: string,
        keyId = 'master-v1'
    ): Promise<OutboundPayloadResult> {
        const masterKey = sessionKeyStore.getMasterKeyRaw();
        if (!masterKey) {
            throw new Error('Vault is locked: Master key unavailable in volatile memory');
        }

        const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
        try {
            const aad = this.computeAad(userId, fileId);
            const encResult = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                plaintext,
                ivBytes,
                aad
            );

            const metadata: EncryptedEnvelopeMetadata = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId,
                salt: '',
                iv: encResult.ivBase64,
                kdfIterations: 600000,
            };

            return {
                ciphertextBase64: encResult.ciphertextBase64,
                encryptionMetadata: metadata,
            };
        } finally {
            wipeBuffer(ivBytes);
        }
    }
}
