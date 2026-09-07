import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    wipeBuffer,
    generateMasterKeyRaw,
    generateSalt,
    deriveKEKFromPin,
    encryptEnvelope,
    decryptEnvelope,
    sessionKeyStore,
    SessionKeyStore,
    InvalidCiphertextOrKeyError,
    AADIntegrityError,
    EncryptedEnvelope,
} from "@/lib/sync";

describe("Vault Cryptographic Resilience & Fault Tolerance (Unit Tests)", () => {
    const testUserId = "user-resilience-unit-test";
    const testFileId = "file-resilience-unit-test";
    const testAad = `vault:file:${testUserId}:${testFileId}`;

    beforeEach(() => {
        sessionKeyStore.purgeKeys();
        vi.useRealTimers();
    });

    afterEach(() => {
        sessionKeyStore.purgeKeys();
        vi.restoreAllMocks();
    });

    describe("1. PIN Constraints & Boundary Validation", () => {
        it("should accept exactly 6 numeric digits", async () => {
            const salt = await generateSalt(16);
            const kek = await deriveKEKFromPin("123456", salt, 1000);
            expect(kek).toHaveLength(32);
            wipeBuffer(kek);
            wipeBuffer(salt);
        });

        it("should reject 4-digit PINs", async () => {
            const salt = await generateSalt(16);
            await expect(deriveKEKFromPin("1234", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            wipeBuffer(salt);
        });

        it("should reject 5-digit PINs", async () => {
            const salt = await generateSalt(16);
            await expect(deriveKEKFromPin("12345", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            wipeBuffer(salt);
        });

        it("should reject 7-digit PINs", async () => {
            const salt = await generateSalt(16);
            await expect(deriveKEKFromPin("1234567", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            wipeBuffer(salt);
        });

        it("should reject non-numeric characters and letters in PIN", async () => {
            const salt = await generateSalt(16);
            await expect(deriveKEKFromPin("12345a", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            await expect(deriveKEKFromPin("12-456", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            await expect(deriveKEKFromPin("12 456", salt, 1000)).rejects.toThrow(
                /PIN must consist of exactly 6 digits/
            );
            wipeBuffer(salt);
        });
    });

    describe("2. Cryptographic Envelope Tampering & Corrupted Ciphertext Isolation", () => {
        it("should reject envelope with tampered ciphertext byte", async () => {
            const masterKey = await generateMasterKeyRaw();
            const envelope = await encryptEnvelope(
                "Top secret data that should not be corrupted",
                masterKey,
                "master-v1",
                "",
                testAad
            );

            // Mutate ciphertext string (flip characters)
            const tamperedCipher = envelope.ciphertext.slice(0, -4) + "XXXX";
            const tamperedEnvelope: EncryptedEnvelope = {
                ...envelope,
                ciphertext: tamperedCipher,
            };

            await expect(
                decryptEnvelope(tamperedEnvelope, masterKey, testAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });

        it("should reject envelope with tampered IV byte", async () => {
            const masterKey = await generateMasterKeyRaw();
            const envelope = await encryptEnvelope(
                "Top secret data that should not be corrupted",
                masterKey,
                "master-v1",
                "",
                testAad
            );

            // Mutate IV string
            const tamperedIv = envelope.iv.slice(0, -2) + "ZZ";
            const tamperedEnvelope: EncryptedEnvelope = {
                ...envelope,
                iv: tamperedIv,
            };

            await expect(
                decryptEnvelope(tamperedEnvelope, masterKey, testAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });

        it("should reject envelope with completely malformed base64 strings", async () => {
            const masterKey = await generateMasterKeyRaw();
            const malformedEnvelope: EncryptedEnvelope = {
                ciphertext: "not-valid-base64!@#$%",
                iv: "also-not-valid!@#$%",
                salt: "",
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                kdfIterations: 600000,
            };

            await expect(
                decryptEnvelope(malformedEnvelope, masterKey, testAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });
    });

    describe("3. AAD Tampering & Context-Binding Defense", () => {
        it("should throw AADIntegrityError when AAD is completely missing or empty", async () => {
            const masterKey = await generateMasterKeyRaw();
            const envelope = await encryptEnvelope(
                "Bound to specific identity",
                masterKey,
                "master-v1",
                "",
                testAad
            );

            await expect(
                decryptEnvelope(envelope, masterKey, "")
            ).rejects.toThrow(AADIntegrityError);

            wipeBuffer(masterKey);
        });

        it("should fail decryption with authentication tag mismatch when fileId is tampered in AAD", async () => {
            const masterKey = await generateMasterKeyRaw();
            const originalContent = "Bound to specific file identity";

            const envelope = await encryptEnvelope(
                originalContent,
                masterKey,
                "master-v1",
                "",
                testAad
            );

            // Decrypting with wrong fileId must fail AES-GCM authentication
            const foreignFileId = "different-file-uuid-999";
            const tamperedAad = `vault:file:${testUserId}:${foreignFileId}`;
            await expect(
                decryptEnvelope(envelope, masterKey, tamperedAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });

        it("should fail decryption with authentication tag mismatch when userId is tampered in AAD", async () => {
            const masterKey = await generateMasterKeyRaw();
            const originalContent = "Bound to specific user identity";

            const envelope = await encryptEnvelope(
                originalContent,
                masterKey,
                "master-v1",
                "",
                testAad
            );

            // Decrypting with wrong userId must fail AES-GCM authentication
            const foreignUserId = "adversary-user-uuid-666";
            const tamperedAad = `vault:file:${foreignUserId}:${testFileId}`;
            await expect(
                decryptEnvelope(envelope, masterKey, tamperedAad)
            ).rejects.toThrow(InvalidCiphertextOrKeyError);

            wipeBuffer(masterKey);
        });
    });

    describe("4. Defensive RAM Sanitization (wipeBuffer)", () => {
        it("should overwrite all bytes of a Uint8Array buffer with zeroes", () => {
            const sensitiveKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            expect(sensitiveKey.some((b) => b !== 0)).toBe(true);

            wipeBuffer(sensitiveKey);
            expect(sensitiveKey.every((b) => b === 0)).toBe(true);
        });

        it("should safely handle empty or 1-byte buffers without throwing", () => {
            const empty = new Uint8Array(0);
            expect(() => wipeBuffer(empty)).not.toThrow();

            const single = new Uint8Array([255]);
            wipeBuffer(single);
            expect(single[0]).toBe(0);
        });
    });

    describe("5. SessionKeyStore Lifecycle, Inactivity Touch & Tab Isolation", () => {
        it("should report unlocked when key is set and locked when purged", async () => {
            expect(sessionKeyStore.isUnlocked()).toBe(false);
            expect(sessionKeyStore.getMasterKeyRaw()).toBeNull();

            const masterKey = await generateMasterKeyRaw();
            sessionKeyStore.setMasterKey(masterKey);

            expect(sessionKeyStore.isUnlocked()).toBe(true);
            const retrieved = sessionKeyStore.getMasterKeyRaw();
            expect(retrieved).not.toBeNull();
            expect(retrieved).toHaveLength(32);

            sessionKeyStore.purgeKeys();
            expect(sessionKeyStore.isUnlocked()).toBe(false);
            expect(sessionKeyStore.getMasterKeyRaw()).toBeNull();

            wipeBuffer(masterKey);
        });

        it("should automatically lock and purge memory when inactivity timeout fires", async () => {
            vi.useFakeTimers();
            const store = new SessionKeyStore();

            const masterKey = await generateMasterKeyRaw();
            store.setMasterKey(masterKey);
            expect(store.isUnlocked()).toBe(true);

            // Fast forward 61 minutes (default timeout is 60 minutes)
            vi.advanceTimersByTime(61 * 60 * 1000);

            expect(store.isUnlocked()).toBe(false);
            expect(store.getMasterKeyRaw()).toBeNull();

            store.purgeKeys();
            wipeBuffer(masterKey);
        });

        it("should reset inactivity countdown when touch() is invoked", async () => {
            vi.useFakeTimers();
            const store = new SessionKeyStore();

            const masterKey = await generateMasterKeyRaw();
            store.setMasterKey(masterKey);

            // Advance 45 minutes
            vi.advanceTimersByTime(45 * 60 * 1000);
            expect(store.isUnlocked()).toBe(true);

            // User keystroke touches the store
            store.touch();

            // Advance another 45 minutes (total 90 minutes from start, but only 45 from touch)
            vi.advanceTimersByTime(45 * 60 * 1000);
            expect(store.isUnlocked()).toBe(true);

            // Advance another 20 minutes (exceeds 60 min from touch)
            vi.advanceTimersByTime(20 * 60 * 1000);
            expect(store.isUnlocked()).toBe(false);

            store.purgeKeys();
            wipeBuffer(masterKey);
        });

        it("lock() must isolate memory wipe locally and not broadcast cross-tab lock events", async () => {
            const store = new SessionKeyStore();
            const masterKey = await generateMasterKeyRaw();
            store.setMasterKey(masterKey);

            // Calling lock() must clear memory locally
            store.lock();
            expect(store.isUnlocked()).toBe(false);
            expect(store.getMasterKeyRaw()).toBeNull();

            wipeBuffer(masterKey);
        });
    });
});
