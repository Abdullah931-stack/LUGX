/**
 * Phase 12: Comprehensive Cross-User Resource Ownership & Isolation Test Suite
 *
 * Verifies:
 * 1. Strict Server Session Derivation: All mutations and reads are scoped to the session user.
 * 2. Unified 404 Not Found: Foreign resources (files, folders, reservations) are indistinguishable
 *    from non-existent resources (zero 403 information leakage).
 * 3. Cross-User Mutation Immunity: User A cannot mutate, move, copy, restore, or commit into User B's resources.
 * 4. AI Stream and Reservation Protection: Foreign fileId in stream route yields 404, foreign operationId yields not_found.
 * 5. High-Concurrency OAuth Sync: Parallel syncUserToDatabase calls execute atomically via UPSERT without race conditions.
 * 6. Storage Path Tenant Isolation: assertSafeStoragePath enforces userId prefix and prevents path traversal attacks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";

import {
    createFile,
    updateFileContent,
    deleteFile,
    copyFile,
    moveFile,
    getFile,
    getUserFiles,
} from "@/server/actions/file-ops";
import { importFile } from "@/server/actions/import-file";
import { commitAIFileOperation } from "@/server/actions/ai-commit";
import { getAIReservationStatus } from "@/server/actions/ai-ops";
import { syncUserToDatabase } from "@/server/actions/auth-actions";
import { assertSafeStoragePath } from "@/lib/supabase/storage";
import { POST as aiStreamPOST } from "@/app/api/ai/stream/route";
import { NextRequest } from "next/server";

const USER_A_ID = "11111111-1111-1111-1111-111111111111";
const USER_B_ID = "22222222-2222-2222-2222-222222222222";

let currentSessionUser: { id: string; email: string; user_metadata?: { full_name?: string; avatar_url?: string } } | null = {
    id: USER_A_ID,
    email: "user-a-phase12@example.com",
};
let dbAvailable = false;

// Mock session provider to dynamically switch between User A and User B
vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(async () => currentSessionUser),
    createClient: vi.fn(async () => ({
        auth: {
            getUser: vi.fn(async () => ({ data: { user: currentSessionUser }, error: null })),
        },
    })),
}));

// Route handler needs db pointer to be testDb for direct tests
vi.mock("@/lib/db", async () => {
    const original = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
    return {
        ...original,
        db: testDb,
    };
});

describe("Phase 12: Cross-User Resource Isolation & Ownership Enforcement", () => {
    beforeAll(async () => {
        dbAvailable = await isTestDbAvailable();
        if (!dbAvailable) return;
        await ensureTestDb();
        await runMigrations();

        await testDb.insert(schema.users).values([
            { id: USER_A_ID, email: "user-a-phase12@example.com", tier: "free" },
            { id: USER_B_ID, email: "user-b-phase12@example.com", tier: "free" },
        ]).onConflictDoNothing();

        try {
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_A_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_B_ID));
        } catch {
            /* ignore */
        }
    });

    beforeEach((ctx) => {
        if (!dbAvailable && ctx.task.name.startsWith("[DB]")) {
            ctx.skip();
        }
        currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
    });

    afterAll(async () => {
        if (!dbAvailable) return;
        try {
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
            await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_A_ID));
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_B_ID));
            await cleanupTestUsers([USER_A_ID, USER_B_ID]);
        } catch {
            /* ignore */
        }
    });

    describe("File Operations & Hierarchy Isolation", () => {
        it("[DB] createFile: returns not_found (404) when User A targets User B's folder as parent", async () => {
            const userBFolderId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBFolderId,
                userId: USER_B_ID,
                title: "User B Secret Folder",
                isFolder: true,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const result = await createFile("Sneaky Document", userBFolderId, false);

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
            expect(result.error).toBe("Parent folder not found");
        });

        it("[DB] copyFile: returns not_found (404) when User A attempts to copy into User B's folder", async () => {
            const userADocId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userADocId,
                userId: USER_A_ID,
                title: "User A Document",
                isFolder: false,
                content: "Secret content",
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const userBFolderId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBFolderId,
                userId: USER_B_ID,
                title: "User B Folder",
                isFolder: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const result = await copyFile(userADocId, userBFolderId);

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
            expect(result.error).toBe("Destination folder not found");
        });

        it("[DB] moveFile: returns not_found (404) when User A attempts to move a file into User B's folder", async () => {
            const userADocId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userADocId,
                userId: USER_A_ID,
                title: "Doc to Move",
                isFolder: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const userBFolderId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBFolderId,
                userId: USER_B_ID,
                title: "User B Dropzone",
                isFolder: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const result = await moveFile(userADocId, userBFolderId);

            expect(result.success).toBe(false);
            expect(result.status).toBe("not_found");
            expect(result.error).toBe("Target parent folder not found");
        });

        it("[DB] getFile / updateFileContent / deleteFile: User A cannot read or mutate User B's file", async () => {
            const userBDocId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBDocId,
                userId: USER_B_ID,
                title: "User B Private Notes",
                isFolder: false,
                content: "Confidential",
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const getResult = await getFile(userBDocId);
            expect(getResult.success).toBe(false);
            expect(getResult.status).toBe("not_found");

            const updateResult = await updateFileContent(userBDocId, "Overwritten", { expectedVersion: 1 });
            expect(updateResult.success).toBe(false);
            expect(updateResult.status).toBe("not_found");

            const deleteResult = await deleteFile(userBDocId);
            expect(deleteResult.success).toBe(false);
            expect(deleteResult.status).toBe("not_found");

            const untouched = await testDb.query.files.findFirst({
                where: eq(schema.files.id, userBDocId),
            });
            expect(untouched?.content).toBe("Confidential");
            expect(untouched?.deletedAt).toBeNull();
        });

        it("[DB] importFile: returns not_found when User A specifies User B's folder as target parent", async () => {
            const userBFolderId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBFolderId,
                userId: USER_B_ID,
                title: "User B Inbox",
                isFolder: true,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const base64Content = Buffer.from("# Imported Title\nBody text").toString("base64");
            const result = await importFile("imported.md", base64Content, "md", userBFolderId);

            expect(result.success).toBe(false);
            expect(result.error).toBe("Parent folder not found");
        });
    });

    describe("AI Operations, Reservations & Stream Isolation", () => {
        it("[DB] getAIReservationStatus: returns found: false (not_found) for foreign reservation", async () => {
            const opId = `op_b_${randomUUID()}`;
            await testDb.insert(schema.aiReservations).values({
                operationId: opId,
                userId: USER_B_ID,
                operation: "improve",
                reservedUnits: 50,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: new Date().toISOString().split("T")[0],
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const statusResult = await getAIReservationStatus(opId);

            expect(statusResult.found).toBe(false);
            if (!statusResult.found) {
                expect(statusResult.reason).toBe("not_found");
            }
        });

        it("[DB] commitAIFileOperation: returns reservation_not_found when committing foreign reservation", async () => {
            const opId = `op_b_${randomUUID()}`;
            const fileId = randomUUID();

            await testDb.insert(schema.files).values({
                id: fileId,
                userId: USER_B_ID,
                title: "User B AI Target File",
                isFolder: false,
                content: "Base content",
                version: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            await testDb.insert(schema.aiReservations).values({
                operationId: opId,
                userId: USER_B_ID,
                fileId,
                operation: "improve",
                reservedUnits: 20,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: new Date().toISOString().split("T")[0],
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };
            const commitResult = await commitAIFileOperation({
                operationId: opId,
                fileId,
                expectedVersion: 1,
                resultContent: "Attacker payload",
            });

            expect(commitResult.success).toBe(false);
            expect(commitResult.status).toBe("reservation_not_found");
        });

        it("[DB] POST /api/ai/stream: rejects stream initiation with 404 if fileId belongs to another user", async () => {
            const userBFileId = randomUUID();
            await testDb.insert(schema.files).values({
                id: userBFileId,
                userId: USER_B_ID,
                title: "User B Private File",
                isFolder: false,
                content: "Secret content",
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };

            const request = new NextRequest("http://localhost/api/ai/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "Please summarize this document",
                    operation: "summarize",
                    fileId: userBFileId,
                }),
            });

            const response = await aiStreamPOST(request);
            expect(response.status).toBe(404);
            const textResponse = await response.text();
            expect(textResponse).toContain("File not found");
        });

        it("POST /api/ai/stream: rejects stream initiation with 400 if fileId is malformed or not a string", async () => {
            currentSessionUser = { id: USER_A_ID, email: "user-a-phase12@example.com" };

            const request = new NextRequest("http://localhost/api/ai/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: "Please summarize this document",
                    operation: "summarize",
                    fileId: 12345, // invalid type
                }),
            });

            const response = await aiStreamPOST(request);
            expect(response.status).toBe(400);
            const textResponse = await response.text();
            expect(textResponse).toContain("Invalid request: fileId must be a non-empty string");
        });
    });

    describe("High-Concurrency Atomic User Sync (UPSERT Race Resistance)", () => {
        it("[DB] syncUserToDatabase: parallel concurrent sync calls execute atomically without unique constraint errors", async () => {
            const newUserId = randomUUID();
            const newUserEmail = `concurrent-user-${randomUUID()}@example.com`;

            currentSessionUser = {
                id: newUserId,
                email: newUserEmail,
                user_metadata: { full_name: "Concurrent User", avatar_url: "https://avatar.com/1" },
            };

            // Fire 10 simultaneous sync calls mimicking rapid double-clicks, pre-fetch, and parallel tabs
            const parallelSyncs = Array.from({ length: 10 }, () => syncUserToDatabase());
            const results = await Promise.all(parallelSyncs);

            // Every single call MUST succeed without Postgres unique violation
            for (const res of results) {
                expect(res.success).toBe(true);
                expect(res.error).toBeUndefined();
            }

            // Verify exactly one user record and one usage record exist
            const userRows = await testDb.query.users.findMany({
                where: eq(schema.users.id, newUserId),
            });
            expect(userRows).toHaveLength(1);
            expect(userRows[0].email).toBe(newUserEmail);
            expect(userRows[0].displayName).toBe("Concurrent User");

            const usageRows = await testDb.query.usage.findMany({
                where: eq(schema.usage.userId, newUserId),
            });
            expect(usageRows).toHaveLength(1);

            // Cleanup
            await testDb.delete(schema.users).where(eq(schema.users.id, newUserId));
        });
    });

    describe("Storage Path Tenant Isolation & Path Traversal Guards", () => {
        it("allows safe paths beginning with userId prefix", () => {
            const safePath = assertSafeStoragePath("user-123", "user-123/document.pdf");
            expect(safePath).toBe("user-123/document.pdf");

            const nestedSafe = assertSafeStoragePath("user-123", "user-123/nested/file_name.md");
            expect(nestedSafe).toBe("user-123/nested/file_name.md");
        });

        it("throws isolation error when path targets another user's prefix", () => {
            expect(() => assertSafeStoragePath("user-123", "other-user-456/document.pdf")).toThrow(
                "Storage path isolation violation"
            );
        });

        it("throws error when directory traversal (..) or leading slash is attempted", () => {
            expect(() => assertSafeStoragePath("user-123", "user-123/../other-user/file.pdf")).toThrow(
                "directory traversal"
            );
            expect(() => assertSafeStoragePath("user-123", "/user-123/file.pdf")).toThrow(
                "leading slash"
            );
            expect(() => assertSafeStoragePath("user-123", "user-123/..\\secret.key")).toThrow(
                "directory traversal"
            );
        });
    });

    describe("Unauthenticated Session Invariants", () => {
        it("rejects operations with unauthorized when session is missing", async () => {
            currentSessionUser = null;

            const createRes = await createFile("Unauthenticated Doc");
            expect(createRes.success).toBe(false);
            expect(createRes.status).toBe("unauthorized");

            const getFilesRes = await getUserFiles();
            expect(getFilesRes.success).toBe(false);
            expect(getFilesRes.status).toBe("unauthorized");

            const statusRes = await getAIReservationStatus("any_op");
            expect(statusRes.found).toBe(false);
            if (!statusRes.found) {
                expect(statusRes.reason).toBe("unauthorized");
            }
        });
    });
});
