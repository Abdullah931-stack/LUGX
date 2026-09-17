/**
 * Integration Test: Client-Side Vault Encrypted Import Pipeline
 *
 * Verifies:
 * 1. End-to-end cryptographic import:
 *    - Client generates local fileId (UUID v4)
 *    - Client binds AAD: vault:file:${userId}:${fileId}
 *    - Client encrypts text via cryptoWorkerBridge (AES-GCM-256)
 *    - Server action importFile stores ciphertext with isEncrypted: true
 * 2. Database state persistence (Zero Plaintext Invariant):
 *    - Content column stores exclusively AES-GCM ciphertext Base64
 *    - Raw plaintext is never passed to storage
 * 3. Round-trip decryption verification:
 *    - Ciphertext can be decrypted with the original key and authentic AAD
 *    - Decryption fails if AAD is tampered (e.g. mismatched fileId or userId)
 * 4. Contract edge cases:
 *    - Missing or non-UUID fileId rejection
 *    - Missing or invalid encryption metadata rejection
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { importFile } from "@/server/actions/import-file";
import { cryptoWorkerBridge } from "@/lib/sync/crypto-worker-bridge";
import type { FileEncryptionMetadata } from "@/lib/db/schema";

const TEST_USER_ID = "15151515-1515-1515-1515-151515151515";

let insertedRecord: any = null;

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => ({
        id: TEST_USER_ID,
        email: "vault-import-test@example.com",
    })),
}));

vi.mock("@/lib/db", () => {
    const mockDb = {
        query: {
            files: {
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
            },
        },
        insert: vi.fn(() => ({
            values: vi.fn((vals) => {
                insertedRecord = { ...vals };
                return {
                    returning: vi.fn().mockResolvedValue([
                        {
                            ...vals,
                            id: vals.id,
                            title: vals.title,
                            content: vals.content,
                            etag: vals.etag,
                            version: vals.version || 1,
                            isEncrypted: vals.isEncrypted || false,
                            encryptionMetadata: vals.encryptionMetadata || null,
                        },
                    ]),
                };
            }),
        })),
    };
    return { db: mockDb };
});

describe("Vault Encrypted Import Integration Pipeline", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertedRecord = null;
    });

    it("executes full client-side AES-GCM encryption and atomic persistence with Zero-Plaintext Invariant", async () => {
        const rawDocumentText = "# Highly Confidential Document\n\nThis text must never reach the server unencrypted.";
        const clientFileId = randomUUID();
        const masterKeyBytes = await cryptoWorkerBridge.generateRandomBytes(32);
        const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
        const aad = `vault:file:${TEST_USER_ID}:${clientFileId}`;

        // 1. Client-Side Encryption via Real WebCrypto AES-GCM engine
        const encResult = await cryptoWorkerBridge.encryptAESGCM(
            masterKeyBytes,
            rawDocumentText,
            ivBytes,
            aad
        );

        const encryptionMetadata: FileEncryptionMetadata = {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "master-v1",
            salt: "",
            iv: encResult.ivBase64,
            kdfIterations: 600000,
        };

        // 2. Server Action Import execution
        const importResult = await importFile(
            "financial-statement.pdf",
            encResult.ciphertextBase64,
            "pdf",
            null,
            {
                isEncrypted: true,
                fileId: clientFileId,
                encryptionMetadata,
            }
        );

        expect(importResult.success).toBe(true);
        expect(importResult.data?.id).toBe(clientFileId);
        expect(importResult.data?.title).toBe("financial-statement");
        expect(importResult.data?.content).toBe(encResult.ciphertextBase64);

        // 3. Inspect Captured Database Record to verify Zero Plaintext At-Rest Invariant
        expect(insertedRecord).toBeDefined();
        expect(insertedRecord.id).toBe(clientFileId);
        expect(insertedRecord.isEncrypted).toBe(true);
        expect(insertedRecord.content).toBe(encResult.ciphertextBase64);
        expect(insertedRecord.content).not.toContain("Highly Confidential");
        expect(insertedRecord.content).not.toContain("This text must never");
        expect(insertedRecord.encryptionMetadata).toEqual(encryptionMetadata);

        // 4. Verify Round-Trip Decryption with Authentic AAD
        const decrypted = await cryptoWorkerBridge.decryptAESGCM(
            masterKeyBytes,
            insertedRecord.content,
            ivBytes,
            aad
        );
        expect(decrypted).toBe(rawDocumentText);

        // 5. Verify Tamper Resistance: Decryption MUST fail if AAD is mismatched
        const tamperedAad = `vault:file:${randomUUID()}:${clientFileId}`;
        await expect(
            cryptoWorkerBridge.decryptAESGCM(
                masterKeyBytes,
                insertedRecord.content,
                ivBytes,
                tamperedAad
            )
        ).rejects.toThrow();
    });

    it("rejects encrypted import when fileId does not match valid UUID format", async () => {
        const importResult = await importFile(
            "bad.pdf",
            "fake-ciphertext",
            "pdf",
            null,
            {
                isEncrypted: true,
                fileId: "invalid-uuid-123",
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: "",
                    iv: "dummy-iv",
                },
            }
        );

        expect(importResult.success).toBe(false);
        expect(importResult.error).toBe("Valid UUID fileId is required for encrypted import");
        expect(insertedRecord).toBeNull();
    });

    it("rejects encrypted import when encryptionMetadata is missing or has no iv", async () => {
        const clientFileId = randomUUID();
        const importResult = await importFile(
            "bad-meta.pdf",
            "fake-ciphertext",
            "pdf",
            null,
            {
                isEncrypted: true,
                fileId: clientFileId,
                encryptionMetadata: null as any,
            }
        );

        expect(importResult.success).toBe(false);
        expect(importResult.error).toBe("Valid encryption metadata is required for encrypted import");
        expect(insertedRecord).toBeNull();
    });
});
