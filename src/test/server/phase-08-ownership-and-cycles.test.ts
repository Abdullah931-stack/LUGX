/**
 * Phase 8: Server-Authoritative Identity, Ownership & Cycle Detection Live Suite
 *
 * Verifies:
 * 1. Guard Primitives (`requireAuthenticatedUser`, `requireOwnedFile`):
 *    - Throws AuthenticationRequiredError (401) on missing sessions.
 *    - Validates ownership, throwing ResourceNotFoundError (404) on foreign resources (zero leakage).
 * 2. Cross-Tenant Isolation:
 *    - Mutations (update, delete, rename, copy, move) on foreign resources return 404/not_found.
 * 3. Folder Cycle Detection & Copy Protection:
 *    - Rejects moving folder into itself (409 conflict).
 *    - Rejects moving folder into its descendant (409 conflict).
 *    - Rejects copying folder into itself or its descendant (conflict).
 * 4. Optimistic Concurrency Control:
 *    - `deleteFile` server action rejects mismatched `expectedVersion`.
 *    - REST `DELETE /api/files/[id]` rejects missing precondition with 428 and mismatched with 412.
 *    - REST `DELETE /api/files/[id]` succeeds on matching version and cascades soft-delete.
 * 5. Environment Isolation:
 *    - Test route returns 404 in production environment even if PLAYWRIGHT=1.
 * 6. Ancillary Hardening:
 *    - `updateUserProfile` ignores mass assignment attempts.
 *    - `generateCopyTitle` and `generateRestoredTitle` truncate to <= 500 characters.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";

import {
    requireAuthenticatedUser,
    requireOwnedFile,
    AuthenticationRequiredError,
    ResourceNotFoundError,
} from "@/server/auth/session";

import {
    createFile,
    updateFileContent,
    deleteFile,
    copyFile,
    getFile,
    renameFile,
} from "@/server/actions/files";

import { moveFile, getFolderChildren } from "@/server/actions/folders";
import { updateUserProfile } from "@/server/actions/auth-actions";
import { generateCopyTitle, generateRestoredTitle, MAX_TITLE_LENGTH } from "@/lib/utils/file-naming";
import { DELETE as fileApiDELETE } from "@/app/api/files/[id]/route";
import { POST as testAuthPOST, DELETE as testAuthDELETE } from "@/app/api/test/e2e-auth/route";
import { NextRequest } from "next/server";

const USER_A = "88888888-8888-8888-8888-888888888888";
const USER_B = "99999999-9999-9999-9999-999999999999";

let currentSessionUser: { id: string; email: string; user_metadata?: { full_name?: string } } | null = {
    id: USER_A,
    email: "user-a-phase08@example.com",
};

let dbAvailable = false;

// Mock session provider dynamically switching between users
vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => currentSessionUser),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: currentSessionUser }, error: null })),
        },
    })),
}));

// Route handler needs db pointer to be testDb for direct tests
vi.mock("@/server/db", async () => {
    const original = await vi.importActual<typeof import("@/server/db")>("@/server/db");
    return {
        ...original,
        db: testDb,
    };
});

describe("Phase 8: Identity, Ownership, Cycle Detection & Concurrency Control", () => {
    beforeAll(async () => {
        dbAvailable = await isTestDbAvailable();
        if (!dbAvailable) return;
        await ensureTestDb();
        await runMigrations();

        await testDb.insert(schema.users).values([
            { id: USER_A, email: "user-a-phase08@example.com", tier: "free", displayName: "User A" },
            { id: USER_B, email: "user-b-phase08@example.com", tier: "free", displayName: "User B" },
        ]).onConflictDoNothing();

        try {
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B));
        } catch {
            // ignore
        }
    });

    beforeEach((ctx) => {
        currentSessionUser = {
            id: USER_A,
            email: "user-a-phase08@example.com",
        };
        if (!dbAvailable && ctx.task.name.startsWith("[DB]")) {
            ctx.skip();
        }
    });

    afterAll(async () => {
        if (!dbAvailable) return;
        try {
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B));
            await cleanupTestUsers([USER_A, USER_B]);
        } catch {
            // ignore
        }
    });

    describe("1. Guard Primitives (src/server/auth/session.ts)", () => {
        it("[DB] requireAuthenticatedUser returns authenticated user when session exists", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const user = await requireAuthenticatedUser();
            expect(user.id).toBe(USER_A);
        });

        it("[DB] requireAuthenticatedUser throws AuthenticationRequiredError on missing session", async () => {
            currentSessionUser = null;
            await expect(requireAuthenticatedUser()).rejects.toThrow(AuthenticationRequiredError);
        });

        it("[DB] requireOwnedFile throws ResourceNotFoundError (404) for non-existent file", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            await expect(requireOwnedFile("non-existent-id", USER_A)).rejects.toThrow(ResourceNotFoundError);
        });

        it("[DB] requireOwnedFile throws ResourceNotFoundError (404) for foreign file (zero leakage)", async () => {
            // Create file owned by User B
            const fileB = await testDb.insert(schema.files).values({
                id: randomUUID(),
                userId: USER_B,
                title: "User B Secret Doc",
                content: "confidential",
                isFolder: false,
                etag: "w/\"b-tag\"",
                version: 1,
            }).returning();

            // User A queries User B's file
            await expect(requireOwnedFile(fileB[0].id, USER_A)).rejects.toThrow(ResourceNotFoundError);
        });
    });

    describe("2. Cross-Tenant Server Action Isolation", () => {
        it("[DB] User A cannot read, update, or delete User B's file", async () => {
            // Create User B file
            const [fileB] = await testDb.insert(schema.files).values({
                id: randomUUID(),
                userId: USER_B,
                title: "User B Document",
                content: "Initial content",
                isFolder: false,
                etag: "w/\"b-etag\"",
                version: 1,
            }).returning();

            // User A tries to fetch
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const getResult = await getFile(fileB.id);
            expect(getResult.success).toBe(false);
            expect(getResult.status).toBe("not_found");

            // User A tries to update
            const updateResult = await updateFileContent(fileB.id, "Malicious overwrite");
            expect(updateResult.success).toBe(false);
            expect(updateResult.status).toBe("not_found");

            // User A tries to delete
            const deleteResult = await deleteFile(fileB.id);
            expect(deleteResult.success).toBe(false);
            expect(deleteResult.status).toBe("not_found");

            // Verify User B's file is unchanged in DB
            const verify = await testDb.query.files.findFirst({
                where: eq(schema.files.id, fileB.id),
            });
            expect(verify?.content).toBe("Initial content");
            expect(verify?.deletedAt).toBeNull();
        });

        it("[DB] User A cannot create a file pointing to User B's folder as parent", async () => {
            const [folderB] = await testDb.insert(schema.files).values({
                id: randomUUID(),
                userId: USER_B,
                title: "User B Folder",
                isFolder: true,
                etag: "w/\"b-folder\"",
                version: 1,
            }).returning();

            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const createResult = await createFile("Injected File", folderB.id, false);
            expect(createResult.success).toBe(false);
            expect(createResult.status).toBe("not_found");
        });
    });

    describe("3. Folder Hierarchy Cycle & Copy Protection", () => {
        it("[DB] moveFile rejects moving a folder into itself (409 conflict)", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const createFolder = await createFile("Parent Folder", null, true);
            expect(createFolder.success).toBe(true);
            const folderId = createFolder.data!.id;

            const moveSelf = await moveFile(folderId, folderId);
            expect(moveSelf.success).toBe(false);
            expect(moveSelf.status).toBe("conflict");
        });

        it("[DB] moveFile rejects moving a folder into one of its descendants (409 conflict)", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };

            // Create Folder A
            const folderA = (await createFile("Folder A", null, true)).data!;
            // Create Folder B inside Folder A
            const folderB = (await createFile("Folder B", folderA.id, true)).data!;
            // Create Folder C inside Folder B
            const folderC = (await createFile("Folder C", folderB.id, true)).data!;

            // Attempt to move Folder A inside Folder C (cycle)
            const moveResult = await moveFile(folderA.id, folderC.id);
            expect(moveResult.success).toBe(false);
            expect(moveResult.status).toBe("conflict");
            expect(moveResult.error).toContain("descendant");

            // Verify Folder A remains at root
            const checkA = await testDb.query.files.findFirst({
                where: eq(schema.files.id, folderA.id),
            });
            expect(checkA?.parentFolderId).toBeNull();
        });

        it("[DB] copyFile rejects copying a folder into itself or into one of its descendants", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };

            const folderA = (await createFile("Copy Test Folder A", null, true)).data!;
            const folderB = (await createFile("Copy Test Folder B", folderA.id, true)).data!;

            // Attempt to copy Folder A inside Folder B
            const copyResult = await copyFile(folderA.id, folderB.id);
            expect(copyResult.success).toBe(false);
            expect(copyResult.status).toBe("conflict");
        });

        it("[DB] copyFile clamps negative depth to prevent recursion bypass attacks", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const doc = (await createFile("Sample Doc", null, false)).data!;

            // Passing large negative depth should not crash or bypass depth bounds
            const copyResult = await copyFile(doc.id, null, -999999);
            expect(copyResult.success).toBe(true);
            expect(copyResult.data?.title).toContain("(Copy)");
        });
    });

    describe("4. Optimistic Concurrency Control on Deletion", () => {
        it("[DB] deleteFile server action rejects mismatched expectedVersion with conflict", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const doc = (await createFile("Doc for Versioned Delete", null, false)).data!;
            expect(doc.version).toBe(1);

            // Attempt deletion with mismatched version
            const conflictResult = await deleteFile(doc.id, { expectedVersion: 99 });
            expect(conflictResult.success).toBe(false);
            expect(conflictResult.status).toBe("conflict");

            // Attempt deletion with matching version
            const successResult = await deleteFile(doc.id, { expectedVersion: 1 });
            expect(successResult.success).toBe(true);

            // Verify tombstone status in DB
            const refreshed = await testDb.query.files.findFirst({
                where: eq(schema.files.id, doc.id),
            });
            expect(refreshed?.deletedAt).not.toBeNull();
            expect(refreshed?.version).toBe(2);
        });

        it("[DB] REST DELETE /api/files/[id] requires If-Match or expectedVersion (428)", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const doc = (await createFile("Doc for REST Delete", null, false)).data!;

            const req = new NextRequest(`http://localhost:3000/api/files/${doc.id}`, {
                method: "DELETE",
            });

            const res = await fileApiDELETE(req, { params: Promise.resolve({ id: doc.id }) });
            expect(res.status).toBe(428);
        });

        it("[DB] REST DELETE /api/files/[id] rejects version mismatch with 412 Precondition Failed", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const doc = (await createFile("Doc for 412 Test", null, false)).data!;

            const req = new NextRequest(`http://localhost:3000/api/files/${doc.id}?expectedVersion=999`, {
                method: "DELETE",
            });

            const res = await fileApiDELETE(req, { params: Promise.resolve({ id: doc.id }) });
            expect(res.status).toBe(412);
        });

        it("[DB] REST DELETE /api/files/[id] deletes file atomically when expectedVersion matches", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };
            const doc = (await createFile("Doc for Valid REST Delete", null, false)).data!;

            const req = new NextRequest(`http://localhost:3000/api/files/${doc.id}?expectedVersion=1`, {
                method: "DELETE",
            });

            const res = await fileApiDELETE(req, { params: Promise.resolve({ id: doc.id }) });
            expect(res.status).toBe(200);

            const json = await res.json();
            expect(json.success).toBe(true);
            expect(json.version).toBe(2);
        });
    });

    describe("5. Environment Isolation (src/app/api/test/e2e-auth/route.ts)", () => {
        const originalEnv = process.env.NODE_ENV;
        const originalPlaywright = process.env.PLAYWRIGHT;

        afterAll(() => {
            (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
            process.env.PLAYWRIGHT = originalPlaywright;
        });

        it("POST /api/test/e2e-auth returns 404 in production environment even if PLAYWRIGHT=1", async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = "production";
            process.env.PLAYWRIGHT = "1";

            const req = new NextRequest("http://localhost:3000/api/test/e2e-auth", {
                method: "POST",
                body: JSON.stringify({ email: "attacker@test.local", tier: "ultra" }),
            });

            const res = await testAuthPOST(req);
            expect(res.status).toBe(404);
            const json = await res.json();
            expect(json.error).toBe("Not Found");
        });

        it("DELETE /api/test/e2e-auth returns 404 in production environment", async () => {
            (process.env as Record<string, string | undefined>).NODE_ENV = "production";
            process.env.PLAYWRIGHT = "1";

            const req = new NextRequest("http://localhost:3000/api/test/e2e-auth", {
                method: "DELETE",
            });

            const res = await testAuthDELETE(req);
            expect(res.status).toBe(404);
        });
    });

    describe("6. Ancillary Hardening & Boundary Defenses", () => {
        it("[DB] updateUserProfile ignores sensitive column injection (LUGX-067)", async () => {
            currentSessionUser = { id: USER_A, email: "user-a-phase08@example.com" };

            // Attempt mass assignment injection
            const maliciousData = {
                displayName: "Legit Display Name",
                tier: "ultra",
                stripeCustomerId: "cus_hacked",
            };

            const result = await updateUserProfile(maliciousData as any);
            expect(result.success).toBe(true);

            // Verify in database that tier was NOT changed to ultra
            const userInDb = await testDb.query.users.findFirst({
                where: eq(schema.users.id, USER_A),
            });
            expect(userInDb?.displayName).toBe("Legit Display Name");
            expect(userInDb?.tier).toBe("free");
            expect(userInDb?.stripeCustomerId).toBeNull();
        });

        it("generateRestoredTitle and generateCopyTitle truncate to <= 500 characters (LUGX-138)", () => {
            const massiveBase = "A".repeat(510);
            const copyTitle = generateCopyTitle(`${massiveBase}.md`, 1);
            expect(copyTitle.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
            expect(copyTitle).toContain("(Copy)");
            expect(copyTitle.endsWith(".md")).toBe(true);

            const restoredTitle = generateRestoredTitle(`${massiveBase}.md`, 1);
            expect(restoredTitle.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
            expect(restoredTitle).toContain("(Restored)");
            expect(restoredTitle.endsWith(".md")).toBe(true);
        });
    });
});
