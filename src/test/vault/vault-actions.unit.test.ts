import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    getUserVaultProfile,
    createUserVaultProfile,
    updateVaultPassword,
    revokeAllTrustedDevices,
} from "@/server/actions/vault-actions";
import { db } from "@/lib/db";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
    db: {
        query: {
            userVaultProfiles: {
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
    },
}));

describe("Vault Server Actions (Unit Tests)", () => {
    const mockUser = { id: "test-user-uuid-1234", email: "vault-tester@example.com" };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("getUserVaultProfile", () => {
        it("should return unauthorized when user session is missing", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(null);

            const res = await getUserVaultProfile();
            expect(res.success).toBe(false);
            expect(res.status).toBe("unauthorized");
            expect(res.error).toBe("Authentication required");
        });

        it("should return null data when profile does not exist", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);

            const res = await getUserVaultProfile();
            expect(res.success).toBe(true);
            expect(res.data).toBeNull();
        });

        it("should return profile data when profile exists", async () => {
            const mockProfile = {
                userId: mockUser.id,
                encryptedMasterKey: "gcm:v1:mock-key",
                recoveryEncryptedMasterKey: "gcm:v1:mock-recovery",
                keySalt: "mockSalt1",
                recoverySalt: "mockSalt2",
                kdfIterations: 600000,
                keyVersion: 1,
                deviceTrustEpoch: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            };

            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(mockProfile as any);

            const res = await getUserVaultProfile();
            expect(res.success).toBe(true);
            expect(res.data).toEqual(mockProfile);
        });

        it("should handle unexpected database exceptions safely", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockRejectedValueOnce(new Error("DB connection failure"));

            const res = await getUserVaultProfile();
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toBe("Failed to retrieve vault profile");
        });
    });

    describe("createUserVaultProfile", () => {
        const validInput = {
            encryptedMasterKey: "gcm:v1:enc-master-key",
            recoveryEncryptedMasterKey: "gcm:v1:enc-recovery-key",
            keySalt: "salt-password-123",
            recoverySalt: "salt-recovery-456",
        };

        it("should return unauthorized when user session is missing", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(null);

            const res = await createUserVaultProfile(validInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("unauthorized");
        });

        it("should reject input when required cryptographic parameters are missing or blank", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);

            const res1 = await createUserVaultProfile({ ...validInput, encryptedMasterKey: "   " });
            expect(res1.success).toBe(false);
            expect(res1.status).toBe("error");
            expect(res1.error).toContain("Missing required cryptographic parameters");

            const res2 = await createUserVaultProfile({ ...validInput, recoveryEncryptedMasterKey: "" });
            expect(res2.success).toBe(false);

            const res3 = await createUserVaultProfile({ ...validInput, keySalt: "" });
            expect(res3.success).toBe(false);

            const res4 = await createUserVaultProfile({ ...validInput, recoverySalt: "  " });
            expect(res4.success).toBe(false);
        });

        it("should reject creation if vault profile already exists (conflict status)", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce({
                userId: mockUser.id,
            } as any);

            const res = await createUserVaultProfile(validInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("conflict");
            expect(res.error).toContain("already initialized");
        });

        it("should insert profile with default iterations (600000) and keyVersion (1)", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);

            const insertedRow = {
                userId: mockUser.id,
                ...validInput,
                kdfIterations: 600000,
                keyVersion: 1,
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([insertedRow]);
            const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
            vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

            const res = await createUserVaultProfile(validInput);
            expect(res.success).toBe(true);
            expect(res.data).toEqual(insertedRow);
            expect(mockValues).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: mockUser.id,
                    encryptedMasterKey: validInput.encryptedMasterKey,
                    kdfIterations: 600000,
                    keyVersion: 1,
                })
            );
        });

        it("should respect custom kdfIterations and keyVersion if provided", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);

            const customInput = {
                ...validInput,
                kdfIterations: 100000,
                keyVersion: 2,
            };

            const insertedRow = {
                userId: mockUser.id,
                ...customInput,
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([insertedRow]);
            const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
            vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

            const res = await createUserVaultProfile(customInput);
            expect(res.success).toBe(true);
            expect(mockValues).toHaveBeenCalledWith(
                expect.objectContaining({
                    kdfIterations: 100000,
                    keyVersion: 2,
                })
            );
        });

        it("should handle database insertion errors safely", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);
            vi.mocked(db.insert).mockImplementationOnce(() => {
                throw new Error("DB lock error");
            });

            const res = await createUserVaultProfile(validInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toBe("Failed to create vault profile");
        });
    });

    describe("updateVaultPassword", () => {
        const updateInput = {
            encryptedMasterKey: "gcm:v1:new-password-wrapped-key",
            keySalt: "new-password-salt-789",
        };

        it("should return unauthorized when user session is missing", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(null);

            const res = await updateVaultPassword(updateInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("unauthorized");
        });

        it("should reject input when required parameters are missing or whitespace", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);

            const res1 = await updateVaultPassword({ ...updateInput, encryptedMasterKey: " " });
            expect(res1.success).toBe(false);
            expect(res1.error).toContain("Missing required cryptographic parameters");

            const res2 = await updateVaultPassword({ ...updateInput, keySalt: "" });
            expect(res2.success).toBe(false);
        });

        it("should return not_found when profile does not exist", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);

            const res = await updateVaultPassword(updateInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("not_found");
            expect(res.error).toBe("Vault profile not found");
        });

        it("should update encryptedMasterKey and keySalt atomically", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce({
                userId: mockUser.id,
                kdfIterations: 600000,
            } as any);

            const updatedRow = {
                userId: mockUser.id,
                ...updateInput,
                kdfIterations: 600000,
            };

            const mockReturning = vi.fn().mockResolvedValueOnce([updatedRow]);
            const mockWhere = vi.fn().mockReturnValue({ returning: mockReturning });
            const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
            vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

            const res = await updateVaultPassword(updateInput);
            expect(res.success).toBe(true);
            expect(res.data).toEqual(updatedRow);
            expect(mockSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    encryptedMasterKey: updateInput.encryptedMasterKey,
                    keySalt: updateInput.keySalt,
                    kdfIterations: 600000,
                })
            );
        });

        it("should handle update errors gracefully", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockRejectedValueOnce(new Error("Network disconnect"));

            const res = await updateVaultPassword(updateInput);
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toBe("Failed to update vault password");
        });
    });

    describe("revokeAllTrustedDevices", () => {
        it("should return unauthorized when user session is missing", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(null);

            const res = await revokeAllTrustedDevices();
            expect(res.success).toBe(false);
            expect(res.status).toBe("unauthorized");
        });

        it("should return not_found when profile does not exist", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce(undefined);

            const res = await revokeAllTrustedDevices();
            expect(res.success).toBe(false);
            expect(res.status).toBe("not_found");
        });

        it("should increment deviceTrustEpoch and return the newEpoch", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce({
                userId: mockUser.id,
                deviceTrustEpoch: 3,
            } as any);

            const mockWhere = vi.fn().mockResolvedValueOnce(undefined);
            const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
            vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

            const res = await revokeAllTrustedDevices();
            expect(res.success).toBe(true);
            expect(res.data).toEqual({ newEpoch: 4 });
            expect(mockSet).toHaveBeenCalledWith(
                expect.objectContaining({
                    deviceTrustEpoch: 4,
                })
            );
        });

        it("should default initial epoch to 1 and increment to 2 if epoch was null", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce({
                userId: mockUser.id,
                deviceTrustEpoch: null as any,
            } as any);

            const mockWhere = vi.fn().mockResolvedValueOnce(undefined);
            const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
            vi.mocked(db.update).mockReturnValue({ set: mockSet } as any);

            const res = await revokeAllTrustedDevices();
            expect(res.success).toBe(true);
            expect(res.data).toEqual({ newEpoch: 2 });
        });

        it("should handle revocation database errors safely", async () => {
            vi.mocked(getUser).mockResolvedValueOnce(mockUser as any);
            vi.mocked(db.query.userVaultProfiles.findFirst).mockResolvedValueOnce({
                userId: mockUser.id,
                deviceTrustEpoch: 1,
            } as any);

            vi.mocked(db.update).mockImplementationOnce(() => {
                throw new Error("DB failure");
            });

            const res = await revokeAllTrustedDevices();
            expect(res.success).toBe(false);
            expect(res.status).toBe("error");
            expect(res.error).toBe("Failed to revoke trusted devices");
        });
    });
});
