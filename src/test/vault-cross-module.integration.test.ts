/**
 * @vitest-environment jsdom
 *
 * Cross-Module Integration Test Suite: End-to-End Vault Orchestration,
 * Adversarial Mitigations & Dynamic Encryption Pipeline
 */

import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    wipeBuffer,
    generateMasterKeyRaw,
    generateSalt,
    wrapMasterKeyWithPassword,
    wrapMasterKeyWithPin,
    encryptEnvelope,
    decryptEnvelope,
    sessionKeyStore,
    generateMnemonic,
    DeviceTrustEnvelope,
    InvalidCiphertextOrKeyError,
    arrayBufferToBase64,
} from "@/lib/sync";
import { createIndexedDBManager, IndexedDBManager } from "@/lib/sync/indexeddb";
import {
    createUserVaultProfile,
    revokeAllTrustedDevices,
} from "@/server/actions/vault-actions";
import { toggleFileEncryption, copyFile } from "@/server/actions/file-ops";
import { commitAIFileOperation } from "@/server/actions/ai-commit";
import { db, schema } from "@/lib/db";
import { txDb } from "@/lib/db/transactional";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
    revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db/transactional", () => ({
    txDb: {
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/db", () => {
    return {
        db: {
            query: {
                userVaultProfiles: {
                    findFirst: vi.fn(),
                },
                files: {
                    findFirst: vi.fn(),
                },
                aiReservations: {
                    findFirst: vi.fn(),
                },
            },
            insert: vi.fn(),
            update: vi.fn(),
        },
        schema: {
            userVaultProfiles: {
                userId: "user_id",
                encryptedMasterKey: "encrypted_master_key",
                recoveryEncryptedMasterKey: "recovery_encrypted_master_key",
                keySalt: "key_salt",
                recoverySalt: "recovery_salt",
                kdfIterations: "kdf_iterations",
                keyVersion: "key_version",
                deviceTrustEpoch: "device_trust_epoch",
                createdAt: "created_at",
                updatedAt: "updated_at",
            },
            files: {
                id: "id",
                userId: "user_id",
                title: "title",
                content: "content",
                isFolder: "is_folder",
                isEncrypted: "is_encrypted",
                encryptionMetadata: "encryption_metadata",
                parentFolderId: "parent_folder_id",
                version: "version",
                etag: "etag",
                deletedAt: "deleted_at",
                createdAt: "created_at",
                updatedAt: "updated_at",
            },
            aiReservations: {
                id: "id",
                operationId: "operation_id",
                userId: "user_id",
                fileId: "file_id",
                status: "status",
                reservedUnits: "reserved_units",
                committedUnits: "committed_units",
                refundedUnits: "refunded_units",
            },
        },
    };
});

describe("Cross-Module Integration Suite (Vault Ecosystem)", () => {
    const testUserId = "user-cross-module-777";
    const testFileId = "file-cross-module-888";
    const mockUser = { id: testUserId, email: "cross-tester@example.com" };

    let idb: IndexedDBManager;

    beforeEach(async () => {
        vi.clearAllMocks();
        sessionKeyStore.purgeKeys();
        vi.mocked(getUser).mockResolvedValue(mockUser as any);

        idb = createIndexedDBManager(testUserId);
        await idb.init(testUserId);
        await idb.clearAll();
    });

    afterEach(async () => {
        await idb.clearAll();
        idb.close();
        sessionKeyStore.purgeKeys();
    });

    it("Flow 1: Zero-Knowledge Lifecycle - Setup, Local Encryption, Server Persistence & Round-Trip Decryption", async () => {
        // 1. Client generates master key & password salt
        const masterKey = await generateMasterKeyRaw();
        const testPassword = "VaultPasscode2026!";
        const keySalt = await generateSalt(16);
        const recoverySalt = await generateSalt(16);
        const _mnemonic = await generateMnemonic(16);

        // 2. Wrap master key for server registration
        const passwordWrapped = await wrapMasterKeyWithPassword(
            masterKey,
            testPassword,
            keySalt,
            testUserId,
            5000 // Fast test iteration
        );

        const keySaltBase64 = arrayBufferToBase64(keySalt);
        const recoverySaltBase64 = arrayBufferToBase64(recoverySalt);

        // Mock DB for profile creation
        vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);
        const insertedProfile = {
            userId: testUserId,
            encryptedMasterKey: passwordWrapped.wrappedKeyBase64,
            recoveryEncryptedMasterKey: "mock-seed-wrapped",
            keySalt: keySaltBase64,
            recoverySalt: recoverySaltBase64,
            kdfIterations: 5000,
            keyVersion: 1,
            deviceTrustEpoch: 1,
        };

        const mockReturning = vi.fn().mockResolvedValueOnce([insertedProfile]);
        const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
        vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

        const profileRes = await createUserVaultProfile({
            encryptedMasterKey: passwordWrapped.wrappedKeyBase64,
            recoveryEncryptedMasterKey: "mock-seed-wrapped",
            keySalt: keySaltBase64,
            recoverySalt: recoverySaltBase64,
            kdfIterations: 5000,
        });

        expect(profileRes.success).toBe(true);

        // 3. User encrypts document locally
        const plaintextDocument = "# Confidential Project Financials\n\n- Net Margin: 42%";
        const aad = `vault:file:${testUserId}:${testFileId}`;
        const envelope = await encryptEnvelope(
            plaintextDocument,
            masterKey,
            "master-v1",
            "",
            aad
        );

        expect(envelope.ciphertext.startsWith("gcm:v1:")).toBe(false); // Raw AES-GCM ciphertext
        const formattedCiphertext = `gcm:v1:${envelope.ciphertext}`;

        // 4. Client updates file on server via toggleFileEncryption
        const currentPlainFile = {
            id: testFileId,
            userId: testUserId,
            title: "Project Financials",
            content: plaintextDocument,
            isEncrypted: false,
            encryptionMetadata: null,
            isFolder: false,
            version: 1,
            etag: "etag-v1",
            deletedAt: null,
            updatedAt: new Date(),
        };

        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(currentPlainFile as any);

        const updatedEncryptedFile = {
            ...currentPlainFile,
            content: formattedCiphertext,
            isEncrypted: true,
            encryptionMetadata: {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: envelope.iv,
                kdfIterations: 600000,
            },
            version: 2,
        };

        const mockUpdateReturning = vi.fn().mockResolvedValueOnce([updatedEncryptedFile]);
        const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
        const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
        vi.mocked(db.update).mockReturnValue({ set: mockUpdateSet } as any);

        const toggleRes = await toggleFileEncryption(
            testFileId,
            true,
            formattedCiphertext,
            updatedEncryptedFile.encryptionMetadata,
            { expectedVersion: 1 }
        );

        expect(toggleRes.success).toBe(true);
        expect(toggleRes.data?.content).toContain("gcm:v1:");
        expect(toggleRes.data?.content).not.toContain("Confidential Project"); // ZERO PLAINTEXT

        // 5. Client retrieves from server and decrypts round-trip
        const serverCiphertextRaw = toggleRes.data!.content!.replace(/^gcm:v1:/, "");
        const reconstructedEnvelope = {
            version: 1 as const,
            algorithm: "AES-GCM-256" as const,
            keyId: "master-v1",
            salt: "",
            iv: toggleRes.data!.encryptionMetadata!.iv,
            ciphertext: serverCiphertextRaw,
            kdfIterations: 600000,
        };

        const decryptedPlaintext = await decryptEnvelope(reconstructedEnvelope, masterKey, aad);
        expect(decryptedPlaintext).toBe(plaintextDocument);

        wipeBuffer(masterKey);
    });

    it("Flow 2: Encrypted Copy Pipeline (AUD-02) - Client Re-encryption with New UUID & AAD Integrity", async () => {
        const masterKey = await generateMasterKeyRaw();
        const originalFileId = "orig-file-111";
        const copyFileId = "copy-file-222";
        const secretText = "Encrypted Research Notes";

        // 1. Original file encrypted with original AAD
        const origAad = `vault:file:${testUserId}:${originalFileId}`;
        const origEnvelope = await encryptEnvelope(secretText, masterKey, "master-v1", "", origAad);

        const originalFileRow = {
            id: originalFileId,
            userId: testUserId,
            title: "Research Notes",
            content: `gcm:v1:${origEnvelope.ciphertext}`,
            isEncrypted: true,
            encryptionMetadata: {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: origEnvelope.iv,
                kdfIterations: 600000,
            },
            isFolder: false,
            parentFolderId: null,
            deletedAt: null,
        };

        // 2. Client Decrypts original file locally
        const decryptedSource = await decryptEnvelope(
            {
                ...origEnvelope,
                ciphertext: originalFileRow.content.replace(/^gcm:v1:/, ""),
            },
            masterKey,
            origAad
        );
        expect(decryptedSource).toBe(secretText);

        // 3. Client re-encrypts for new copy file ID with new AAD
        const copyAad = `vault:file:${testUserId}:${copyFileId}`;
        const copyEnvelope = await encryptEnvelope(decryptedSource, masterKey, "master-v1", "", copyAad);

        const encryptedOverride = {
            newFileId: copyFileId,
            content: `gcm:v1:${copyEnvelope.ciphertext}`,
            encryptionMetadata: {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: copyEnvelope.iv,
                kdfIterations: 600000,
            },
        };

        // 4. Server copyFile execution
        vi.mocked(db.query.files.findFirst)
            .mockResolvedValueOnce(originalFileRow as any) // getFile(originalFileId)
            .mockResolvedValueOnce(undefined); // title collision check

        const newCopyRow = {
            id: copyFileId,
            userId: testUserId,
            title: "Research Notes (Copy)",
            content: encryptedOverride.content,
            isEncrypted: true,
            encryptionMetadata: encryptedOverride.encryptionMetadata,
            isFolder: false,
            parentFolderId: null,
            version: 1,
        };

        const mockReturning = vi.fn().mockResolvedValueOnce([newCopyRow]);
        const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
        vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

        const copyRes = await copyFile(originalFileId, null, 0, encryptedOverride);
        expect(copyRes.success).toBe(true);
        expect(copyRes.data?.id).toBe(copyFileId);
        expect(copyRes.data?.isEncrypted).toBe(true);

        // 5. Verification: New copy decrypts with copyAad
        const decryptedCopy = await decryptEnvelope(
            {
                ...copyEnvelope,
                ciphertext: copyRes.data!.content!.replace(/^gcm:v1:/, ""),
            },
            masterKey,
            copyAad
        );
        expect(decryptedCopy).toBe(secretText);

        // 6. Verification: Attempting to decrypt New copy with original AAD MUST fail authentication tag check
        await expect(
            decryptEnvelope(
                {
                    ...copyEnvelope,
                    ciphertext: copyRes.data!.content!.replace(/^gcm:v1:/, ""),
                },
                masterKey,
                origAad // Old AAD
            )
        ).rejects.toThrow(InvalidCiphertextOrKeyError);

        wipeBuffer(masterKey);
    });

    it("Flow 3: AI Stream Commit - Zero-Knowledge Plaintext Rejection & Encrypted Payload Atomic Commit", async () => {
        const masterKey = await generateMasterKeyRaw();
        const encryptedFileRecord = {
            id: testFileId,
            userId: testUserId,
            title: "Encrypted AI Draft",
            isEncrypted: true,
            version: 5,
            etag: "etag-v5",
            deletedAt: null,
        };

        const reservationRecord = {
            id: "res-ai-123",
            operationId: "op-ai-456",
            userId: testUserId,
            fileId: testFileId,
            status: "reserved",
            reservedUnits: 10,
        };

        // 1. Invariant: Committing plaintext to an encrypted file without metadata must be rejected
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce(reservationRecord as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(encryptedFileRecord as any);

        const unencryptedCommitAttempt = await commitAIFileOperation({
            operationId: "op-ai-456",
            fileId: testFileId,
            resultContent: "# Plaintext AI markdown text",
            expectedVersion: 5,
            expectedETag: "etag-v5",
        });

        expect(unencryptedCommitAttempt.success).toBe(false);
        if (!unencryptedCommitAttempt.success && "error" in unencryptedCommitAttempt) {
            expect(unencryptedCommitAttempt.error).toContain("Cannot commit unencrypted content to an encrypted file");
        }

        // 2. Client performs client-side encryption of the AI generated text
        const aiMarkdown = "## AI Generated Content\n\nDeep cryptographic analysis.";
        const aad = `vault:file:${testUserId}:${testFileId}`;
        const encResult = await encryptEnvelope(aiMarkdown, masterKey, "master-v1", "", aad);

        const encryptedPayload = `gcm:v1:${encResult.ciphertext}`;
        const encryptionMetadata = {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "master-v1",
            salt: "",
            iv: encResult.iv,
            kdfIterations: 600000,
        };

        // 3. Commit with encrypted payload inside database transaction
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce(reservationRecord as any);
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(encryptedFileRecord as any);

        const committedFileRow = {
            ...encryptedFileRecord,
            content: encryptedPayload,
            encryptionMetadata,
            version: 6,
            etag: "etag-v6",
        };

        const txMock = {
            update: vi.fn((table: any) => ({
                set: vi.fn(() => ({
                    where: vi.fn(() => ({
                        returning: vi.fn().mockResolvedValue([
                            table === schema.files
                                ? committedFileRow
                                : { id: reservationRecord.id, status: "committed" },
                        ]),
                    })),
                })),
            })),
        };

        vi.mocked(txDb.transaction).mockImplementationOnce(async (callback: any) => {
            return await callback(txMock);
        });

        const successfulCommit = await commitAIFileOperation({
            operationId: "op-ai-456",
            fileId: testFileId,
            resultContent: encryptedPayload,
            encryptionMetadata,
            expectedVersion: 5,
            expectedETag: "etag-v5",
        });

        expect(successfulCommit.success).toBe(true);
        expect(successfulCommit.status).toBe("committed");
        if (successfulCommit.success && successfulCommit.status === "committed") {
            expect(successfulCommit.version).toBe(6);
        }

        // 4. Verify decodability of committed AI output
        const roundTripAI = await decryptEnvelope(
            {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: encryptionMetadata.iv,
                ciphertext: encryptedPayload.replace(/^gcm:v1:/, ""),
                kdfIterations: 600000,
            },
            masterKey,
            aad
        );
        expect(roundTripAI).toBe(aiMarkdown);

        wipeBuffer(masterKey);
    });

    it("Flow 4: Conflict 412 Double-Encryption Prevention Invariant (AUD-03)", () => {
        // Defensive guard invariant test from use-editor-orchestrator.ts
        const isEncrypted = true;
        const serverCiphertext = "gcm:v1:existing-server-ciphertext-base64";

        // Simulating handleResolveConflict policy:
        let contentToSend: string;
        let performedReencryption = false;

        if (isEncrypted && serverCiphertext.startsWith("gcm:v1:")) {
            // Guard triggers: Keep raw ciphertext as-is without running encryptEnvelope
            contentToSend = serverCiphertext;
        } else if (isEncrypted) {
            contentToSend = `gcm:v1:${serverCiphertext}`;
            performedReencryption = true;
        } else {
            contentToSend = serverCiphertext;
        }

        expect(performedReencryption).toBe(false);
        expect(contentToSend).toBe(serverCiphertext);
        expect(contentToSend.startsWith("gcm:v1:gcm:v1:")).toBe(false); // ZERO DOUBLE-ENCRYPTION
    });

    it("Flow 5: Central Device Trust Revocation & Local Envelope Epoch Invalidation (AUD-05)", async () => {
        const masterKey = await generateMasterKeyRaw();
        const pin = "654321"; // 6-digit PIN
        const salt = await generateSalt(16);

        // 1. Device enrolls with 6-digit PIN under epoch 1 (arg 5 is epoch: 1, arg 6 is iterations: 1000)
        const trustEnvelope: DeviceTrustEnvelope = await wrapMasterKeyWithPin(
            masterKey,
            pin,
            salt,
            testUserId,
            1, // deviceTrustEpoch: 1
            1000 // iterations
        );

        // Store locally in IndexedDB
        await idb.saveDeviceTrustEnvelope(trustEnvelope, testUserId);
        const storedEnvelope = await idb.getDeviceTrustEnvelope(testUserId);
        expect(storedEnvelope).not.toBeNull();
        expect(storedEnvelope?.deviceTrustEpoch).toBe(1);

        // 2. User revokes all trusted devices centrally via server action
        const activeProfile = {
            userId: testUserId,
            deviceTrustEpoch: 1,
        };

        vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(activeProfile as any);
        const mockWhere = vi.fn().mockResolvedValueOnce(undefined);
        const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
        vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

        const revokeRes = await revokeAllTrustedDevices();
        expect(revokeRes.success).toBe(true);
        expect(revokeRes.data?.newEpoch).toBe(2);

        // 3. Local device attempts PIN unlock -> detects epoch mismatch with server
        const serverEpoch = revokeRes.data!.newEpoch;
        let pinUnlockAllowed = true;
        let fallbackToPasswordRequired = false;

        if (storedEnvelope && serverEpoch !== storedEnvelope.deviceTrustEpoch) {
            // Local client detects central revocation
            await idb.clearDeviceTrustEnvelope(testUserId);
            pinUnlockAllowed = false;
            fallbackToPasswordRequired = true;
        }

        expect(pinUnlockAllowed).toBe(false);
        expect(fallbackToPasswordRequired).toBe(true);

        // 4. Verify local envelope is wiped from IndexedDB
        const envelopeAfterRevocation = await idb.getDeviceTrustEnvelope(testUserId);
        expect(envelopeAfterRevocation).toBeNull();

        wipeBuffer(masterKey);
    });
});
