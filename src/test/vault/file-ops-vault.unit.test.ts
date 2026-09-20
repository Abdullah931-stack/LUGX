import { describe, it, expect, vi, beforeEach } from "vitest";
import { toggleFileEncryption, copyFile } from "@/server/actions/file-ops";
import { db } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
    revalidatePath: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
    db: {
        query: {
            files: {
                findFirst: vi.fn(),
            },
        },
        insert: vi.fn(),
        update: vi.fn(),
    },
    schema: {
        files: {
            id: "id",
            userId: "user_id",
            title: "title",
            content: "content",
            parentFolderId: "parent_folder_id",
            isFolder: "is_folder",
            isEncrypted: "is_encrypted",
            encryptionMetadata: "encryption_metadata",
            version: "version",
            etag: "etag",
            deletedAt: "deleted_at",
            createdAt: "created_at",
            updatedAt: "updated_at",
        },
    },
}));

describe("File Operations Vault & Encryption Engine (Unit Tests)", () => {
    const mockUser = { id: "user-uuid-vault-test", email: "user@test.org" };
    const mockFileId = "file-uuid-abc-123";

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("toggleFileEncryption", () => {
        const mockCurrentFile = {
            id: mockFileId,
            userId: mockUser.id,
            title: "Secret Notes",
            content: "# Plain Content",
            isFolder: false,
            isEncrypted: false,
            encryptionMetadata: null,
            version: 3,
            etag: "etag-v3-hash",
            deletedAt: null,
            updatedAt: new Date(),
        };

        const mockEncMetadata = {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "master-v1",
            salt: "",
            iv: "iv-base64-random-12b",
            kdfIterations: 600000,
        };

        it("should return unauthorized when user is not authenticated", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(null);

            const res = await toggleFileEncryption(mockFileId, true, "gcm:v1:cipher", mockEncMetadata);
            expect(res.success).toBe(false);
            expect(res.status).toBe("unauthorized");
            expect(res.error).toBe("Authentication required");
        });

        it("should return not_found if target file does not exist or is deleted", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(undefined);

            const res = await toggleFileEncryption(mockFileId, true, "gcm:v1:cipher", mockEncMetadata);
            expect(res.success).toBe(false);
            expect(res.status).toBe("not_found");
            expect(res.error).toContain("File not found");
        });

        it("should reject encryption toggle if target file is a folder", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
                ...mockCurrentFile,
                isFolder: true,
            } as any);

            const res = await toggleFileEncryption(mockFileId, true, "gcm:v1:cipher", mockEncMetadata);
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toContain("Cannot toggle encryption on a folder");
        });

        it("should return 412 conflict with serverVersion when expectedVersion mismatches", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockCurrentFile as any);

            const res = await toggleFileEncryption(
                mockFileId,
                true,
                "gcm:v1:cipher",
                mockEncMetadata,
                { expectedVersion: 1 } // actual version is 3
            );

            expect(res.success).toBe(false);
            expect(res.status).toBe("conflict");
            expect(res.error).toContain("modified by another session");
            expect(res.serverVersion).toBeDefined();
            expect(res.serverVersion?.version).toBe(3);
            expect(res.serverVersion?.isEncrypted).toBe(false);
            expect(res.serverVersion?.encryptionMetadata).toBeNull();
        });

        it("should return 412 conflict when expectedETag mismatches", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockCurrentFile as any);

            const res = await toggleFileEncryption(
                mockFileId,
                true,
                "gcm:v1:cipher",
                mockEncMetadata,
                { expectedETag: "stale-etag-hash" } // actual is etag-v3-hash
            );

            expect(res.success).toBe(false);
            expect(res.status).toBe("conflict");
            expect(res.error).toContain("ETag mismatch detected");
        });

        it("should successfully encrypt file, store metadata, and increment version atomically", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockCurrentFile as any);

            const updatedRow = {
                ...mockCurrentFile,
                content: "gcm:v1:cipher-text-base64",
                isEncrypted: true,
                encryptionMetadata: mockEncMetadata,
                version: 4,
                etag: "new-etag-v4",
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([updatedRow]);
            const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
            const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
            vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

            const res = await toggleFileEncryption(
                mockFileId,
                true,
                "gcm:v1:cipher-text-base64",
                mockEncMetadata,
                { expectedVersion: 3 }
            );

            expect(res.success).toBe(true);
            expect(res.data).toEqual(updatedRow);
            expect(mockSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    isEncrypted: true,
                    encryptionMetadata: mockEncMetadata,
                    version: 4,
                })
            );
        });

        it("should successfully decrypt file, clear metadata to null, and increment version", async () => {
            const encryptedFile = {
                ...mockCurrentFile,
                content: "gcm:v1:encrypted-blob",
                isEncrypted: true,
                encryptionMetadata: mockEncMetadata,
                version: 4,
            };

            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(encryptedFile as any);

            const decryptedRow = {
                ...encryptedFile,
                content: "# Decrypted Plaintext Markdown",
                isEncrypted: false,
                encryptionMetadata: null,
                version: 5,
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([decryptedRow]);
            const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
            const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
            vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

            const res = await toggleFileEncryption(
                mockFileId,
                false,
                "# Decrypted Plaintext Markdown",
                null,
                { expectedVersion: 4 }
            );

            expect(res.success).toBe(true);
            expect(res.data?.isEncrypted).toBe(false);
            expect(res.data?.encryptionMetadata).toBeNull();
            expect(mockSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    isEncrypted: false,
                    encryptionMetadata: null,
                    version: 5,
                })
            );
        });
    });

    describe("copyFile with Encrypted Invariants (AUD-02)", () => {
        const mockEncryptedOriginal = {
            id: "file-orig-111",
            userId: mockUser.id,
            title: "Private Ledger",
            content: "gcm:v1:orig-ciphertext",
            isFolder: false,
            isEncrypted: true,
            encryptionMetadata: {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: "iv-original-12b",
                kdfIterations: 600000,
            },
            parentFolderId: null,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        it("should strictly reject server copy of encrypted file if encryptedOverride is missing", async () => {
            vi.mocked(getUser).mockResolvedValue(mockUser as any);
            vi.mocked(db.query.files.findFirst).mockResolvedValueOnce(mockEncryptedOriginal as any);

            const res = await copyFile(mockEncryptedOriginal.id);
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toContain("Encrypted files require client-side re-encryption");
        });

        it("should copy encrypted file when valid encryptedOverride with newFileId and new AAD payload is provided", async () => {
            const newReencryptedFileId = "file-copy-222";
            const newReencryptedMetadata = {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: "iv-new-random-12b",
                kdfIterations: 600000,
            };

            const encryptedOverride = {
                newFileId: newReencryptedFileId,
                content: "gcm:v1:re-encrypted-for-copy-222",
                encryptionMetadata: newReencryptedMetadata,
            };

            // getUser resolved for copyFile and inner getFile
            vi.mocked(getUser).mockResolvedValue(mockUser as any);
            // First findFirst: inside getFile (find original)
            // Second findFirst: inside copyFile while loop (title collision check)
            vi.mocked(db.query.files.findFirst)
                .mockResolvedValueOnce(mockEncryptedOriginal as any)
                .mockResolvedValueOnce(undefined);

            const copiedFileRow = {
                id: newReencryptedFileId,
                userId: mockUser.id,
                title: "Private Ledger (Copy)",
                content: encryptedOverride.content,
                isEncrypted: true,
                encryptionMetadata: newReencryptedMetadata,
                isFolder: false,
                parentFolderId: null,
                version: 1,
                etag: "new-copy-etag",
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([copiedFileRow]);
            const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
            vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

            const res = await copyFile(mockEncryptedOriginal.id, null, 0, encryptedOverride);
            expect(res.success).toBe(true);
            expect(res.data).toEqual(copiedFileRow);
            expect(mockValues).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: newReencryptedFileId,
                    content: encryptedOverride.content,
                    isEncrypted: true,
                    encryptionMetadata: newReencryptedMetadata,
                    title: "Private Ledger (Copy)",
                })
            );
        });

        it("should copy standard unencrypted file normally without requiring encryptedOverride", async () => {
            const unencryptedFile = {
                ...mockEncryptedOriginal,
                isEncrypted: false,
                encryptionMetadata: null,
                content: "# Public Article",
            };

            vi.mocked(getUser).mockResolvedValue(mockUser as any);
            vi.mocked(db.query.files.findFirst)
                .mockResolvedValueOnce(unencryptedFile as any)
                .mockResolvedValueOnce(undefined); // no title collision

            const copiedRow = {
                id: "new-unenc-copy-id",
                userId: mockUser.id,
                title: "Private Ledger (Copy)",
                content: "# Public Article",
                isEncrypted: false,
                encryptionMetadata: null,
                isFolder: false,
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([copiedRow]);
            const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
            vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

            const res = await copyFile(unencryptedFile.id);
            expect(res.success).toBe(true);
            expect(res.data?.isEncrypted).toBe(false);
            expect(mockValues).toHaveBeenCalledWith(
                expect.objectContaining({
                    isEncrypted: false,
                    encryptionMetadata: null,
                    content: "# Public Article",
                })
            );
        });
    });
});
