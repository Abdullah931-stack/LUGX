/**
 * LIVE integration tests — Encrypted Vault & Zero-Knowledge Security (Phase 16 / Phase 18 Suite 5)
 * against the isolated Neon test branch.
 *
 * Real boundaries:
 * 1. REAL database tables (`user_vault_profiles`, `files`, `ai_reservations`, `users`).
 * 2. REAL deterministic AAD binding `vault:file:${userId}:${fileId}` persistence.
 * 3. REAL Zero-Knowledge AI gatekeeper in `/api/ai/stream` returning HTTP 403.
 * 4. REAL optimistic concurrency on ciphertext mutations.
 * 5. REAL cross-tenant isolation and 404 anti-enumeration.
 *
 * Mocked boundary ONLY: Supabase session (`getUser`).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import {
    createUserVaultProfile,
    updateVaultAISetting,
} from "@/server/actions/vault-actions";
import {
    createFile,
    getFile,
    toggleFileEncryption,
} from "@/server/actions/file-ops";
import { POST as aiStreamPOST } from "@/app/api/ai/stream/route";

const USER_A_ID = "32323232-3232-3232-3232-323232323232";
const USER_B_ID = "33333333-3333-3333-3333-333333333333";

let currentSessionUser: { id: string; email: string } | null = {
    id: USER_A_ID,
    email: "user-a-vault@live.test",
};

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => currentSessionUser),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: currentSessionUser }, error: null })),
        },
    })),
}));

describe("LIVE: Encrypted Vault & Zero-Knowledge Security on isolated branch", () => {
    beforeAll(async () => {
        // Seed users A and B
        await testDb
            .insert(schema.users)
            .values([
                { id: USER_A_ID, email: `${USER_A_ID}@live.test`, tier: "pro" },
                { id: USER_B_ID, email: `${USER_B_ID}@live.test`, tier: "pro" },
            ])
            .onConflictDoNothing();
    });

    afterAll(async () => {
        try {
            await testDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, USER_A_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_A_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_A_ID, USER_B_ID]);
    });

    beforeEach(async () => {
        currentSessionUser = { id: USER_A_ID, email: `${USER_A_ID}@vault.live.test` };
        await testDb
            .insert(schema.users)
            .values([
                { id: USER_A_ID, email: `${USER_A_ID}@vault.live.test`, tier: "pro" },
                { id: USER_B_ID, email: `${USER_B_ID}@vault.live.test`, tier: "pro" },
            ])
            .onConflictDoNothing();
        await testDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
        await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_A_ID));
    });

    it("creates vault profile and enforces Zero-Knowledge AI Gatekeeper (HTTP 403) on encrypted files", async () => {
        // 1. Create real vault profile with allowAIOnEncryptedFiles = false (default)
        const profileRes = await createUserVaultProfile({
            encryptedMasterKey: "vault-enc-key-base64",
            recoveryEncryptedMasterKey: "vault-rec-key-base64",
            keySalt: "salt-abc",
            recoverySalt: "rec-salt-xyz",
            kdfIterations: 600000,
        });
        expect(profileRes.success).toBe(true);

        // 2. Create file and convert to encrypted file with deterministic AAD binding
        const createRes = await createFile("Zero Knowledge Note");
        expect(createRes.success).toBe(true);
        const fileId = createRes.data!.id;

        const expectedAAD = `vault:file:${USER_A_ID}:${fileId}`;
        const ciphertextPayload = "aes-gcm-256:ciphertext:sample";
        const encMetadata = {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "key-1",
            salt: "salt-abc",
            iv: "iv-123456789012",
            aad: expectedAAD,
            kdfIterations: 600000,
        };

        const toggleRes = await toggleFileEncryption(fileId, true, ciphertextPayload, encMetadata);
        expect(toggleRes.success).toBe(true);
        expect(toggleRes.data!.isEncrypted).toBe(true);

        // Verify in DB directly
        const [dbFile] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(dbFile.isEncrypted).toBe(true);
        expect(dbFile.content).toBe(ciphertextPayload);

        // 3. Invoke /api/ai/stream on this encrypted file -> must be blocked with 403
        const streamReq = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fileId,
                text: "Suggest improvements for this text",
                operation: "improve",
            }),
        });

        const streamRes = await aiStreamPOST(streamReq);
        expect(streamRes.status).toBe(403);
        const errorText = await streamRes.text();
        expect(errorText).toContain("AI_PROHIBITED_ON_ENCRYPTED_FILES");

        // 4. Assert ZERO reservations created in DB and ZERO quota consumed
        const reservations = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.fileId, fileId));
        expect(reservations.length).toBe(0);
    });

    it("allows AI stream bypass when user explicitly opts in via updateVaultAISetting", async () => {
        // 1. Initialize vault profile
        await createUserVaultProfile({
            encryptedMasterKey: "vault-enc-key-base64",
            recoveryEncryptedMasterKey: "vault-rec-key-base64",
            keySalt: "salt-abc",
            recoverySalt: "rec-salt-xyz",
        });

        // 2. Opt in to allow AI on encrypted files
        const updatePrefRes = await updateVaultAISetting(true);
        expect(updatePrefRes.success).toBe(true);
        expect(updatePrefRes.data!.allowAIOnEncryptedFiles).toBe(true);

        // 3. Create encrypted file
        const createRes = await createFile("Opted-In Encrypted Note");
        const fileId = createRes.data!.id;
        await toggleFileEncryption(fileId, true, "ciphertext-data", {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "k-1",
            salt: "s-1",
            iv: "iv-1",
        });

        // 4. Invoke /api/ai/stream -> does NOT return 403 AI_PROHIBITED_ON_ENCRYPTED_FILES
        const streamReq = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fileId,
                text: "Sample short text to improve",
                operation: "improve",
            }),
        });

        const streamRes = await aiStreamPOST(streamReq);
        // It bypassed the 403 gate! (May proceed to quota check / stream, status != 403)
        expect(streamRes.status).not.toBe(403);
    });

    it("enforces optimistic concurrency control on encrypted file updates", async () => {
        const createRes = await createFile("Encrypted Concurrency Test");
        const fileId = createRes.data!.id;
        const initialVersion = createRes.data!.version ?? 1;

        const toggleRes = await toggleFileEncryption(fileId, true, "cipher-v1", {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "k-1",
            salt: "s-1",
            iv: "iv-1",
        });
        expect(toggleRes.success).toBe(true);
        const encryptedVersion = toggleRes.data!.version ?? 1;

        // Concurrent/stale update using older expectedVersion
        const staleRes = await toggleFileEncryption(fileId, true, "cipher-stale", null, {
            expectedVersion: initialVersion, // Stale!
        });
        expect(staleRes.success).toBe(false);
        expect(staleRes.status).toBe("conflict");

        // Legitimate update advancing ciphertext version
        const validRes = await toggleFileEncryption(fileId, true, "cipher-v2", null, {
            expectedVersion: encryptedVersion,
        });
        expect(validRes.success).toBe(true);
        expect(validRes.data!.version).toBe(encryptedVersion + 1);

        const [persisted] = await testDb.select().from(schema.files).where(eq(schema.files.id, fileId));
        expect(persisted.content).toBe("cipher-v2");
        expect(persisted.version).toBe(encryptedVersion + 1);
    });

    it("strictly isolates encrypted files across tenants with 404 anti-enumeration", async () => {
        // User A creates encrypted file
        const createRes = await createFile("User A Secret File");
        const fileId = createRes.data!.id;
        await toggleFileEncryption(fileId, true, "top-secret-ciphertext", {
            version: 1,
            algorithm: "AES-GCM-256",
            keyId: "k-1",
            salt: "s-1",
            iv: "iv-1",
        });

        // Switch to User B
        currentSessionUser = { id: USER_B_ID, email: "user-b-intruder@live.test" };

        // 1. User B getFile -> 404 not_found
        const getRes = await getFile(fileId);
        expect(getRes.success).toBe(false);
        expect(getRes.status).toBe("not_found");

        // 2. User B toggleFileEncryption -> 404 not_found
        const toggleRes = await toggleFileEncryption(fileId, false, "tampered-content", null);
        expect(toggleRes.success).toBe(false);
        expect(toggleRes.status).toBe("not_found");

        // 3. User B POST /api/ai/stream targeting User A's file -> 404 Not Found
        const streamReq = new NextRequest("http://localhost:3000/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                fileId,
                text: "Attacker payload",
                operation: "correct",
            }),
        });

        const streamRes = await aiStreamPOST(streamReq);
        expect(streamRes.status).toBe(404);
    });
});
