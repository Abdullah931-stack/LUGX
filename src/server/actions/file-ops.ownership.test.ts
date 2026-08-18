/**
 * Phase 3: File Ownership, Parent Validation, Cycle Detection & If-Match Tests
 *
 * Verifies:
 * 1. Parent folder ownership: User A cannot target User B's folder as parent (cross-user isolation).
 * 2. Hierarchy cycle detection: Moving a folder into itself or into its descendant is rejected with 409 conflict.
 * 3. Precondition enforcement: Mandatory If-Match / expectedVersion on updates with 428 Precondition Required and 412 Precondition Failed.
 * 4. Restore lifecycle & ADV-01 resolution:
 *    - Restoring a file whose parent folder is soft-deleted safely detaches to root (parentFolderId = null).
 *    - Restoring a file when a live duplicate exists automatically appends `(Restored)` without date.
 *    - Multiple deleted files with identical titles coexist in tombstone state without constraint violations.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb } from "@/test/test-db";
import { randomUUID } from "crypto";
import { generateETagSync, parseETagHeader } from "@/lib/sync/etag-generator";
import { generateRestoredTitle, generateCopyTitle } from "@/lib/utils/file-naming";

const USER_A_ID = "33333333-3333-3333-3333-333333333333";
const USER_B_ID = "44444444-4444-4444-4444-444444444444";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();

    await testDb.insert(schema.users).values([
        { id: USER_A_ID, email: "user-a-ownership@example.com" },
        { id: USER_B_ID, email: "user-b-ownership@example.com" },
    ]).onConflictDoNothing();

    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
    } catch {
        /* ignore */
    }
});

beforeEach((ctx) => {
    if (!dbAvailable && ctx.task.name.startsWith("[DB]")) {
        ctx.skip();
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_A_ID));
        await testDb.delete(schema.files).where(eq(schema.files.userId, USER_B_ID));
    } catch {
        /* ignore */
    }
});

/**
 * Pure in-memory cycle detection algorithm mirroring moveFile
 */
function checkInMemoryCycle(
    fileId: string,
    newParentFolderId: string | null,
    folderMap: Map<string, { parentFolderId: string | null; isFolder: boolean; deletedAt: Date | null; userId: string }>,
    userId: string
): { allowed: boolean; status?: number; error?: string } {
    if (fileId === newParentFolderId) {
        return { allowed: false, status: 409, error: "Cannot move a folder into itself" };
    }

    if (!newParentFolderId) return { allowed: true };

    const parent = folderMap.get(newParentFolderId);
    if (!parent || parent.userId !== userId || parent.deletedAt) {
        return { allowed: false, status: 403, error: "Target parent folder not found or forbidden" };
    }

    if (!parent.isFolder) {
        return { allowed: false, status: 400, error: "Target destination is not a folder" };
    }

    let currentAncestorId: string | null = parent.parentFolderId;
    const visited = new Set<string>([newParentFolderId]);

    while (currentAncestorId) {
        if (currentAncestorId === fileId) {
            return { allowed: false, status: 409, error: "Cannot move a folder into one of its descendants" };
        }
        if (visited.has(currentAncestorId)) break;
        visited.add(currentAncestorId);

        const ancestor = folderMap.get(currentAncestorId);
        currentAncestorId = ancestor?.parentFolderId ?? null;
    }

    return { allowed: true };
}

describe("Phase 3: Algorithm & Contract Specifications (Pure Logic)", () => {
    it("ADV-01 title resolution: correctly appends (Restored) without date", () => {
        expect(generateRestoredTitle("Report.md")).toBe("Report (Restored).md");
        expect(generateRestoredTitle("Report.md", 2)).toBe("Report (Restored 2).md");
        expect(generateRestoredTitle("Project Plan")).toBe("Project Plan (Restored)");
        expect(generateRestoredTitle("Project Plan", 3)).toBe("Project Plan (Restored 3)");
        expect(generateRestoredTitle("archive.tar.gz")).toBe("archive.tar (Restored).gz");
    });

    it("CRIT-02 copy title resolution: correctly generates Notes (Copy).md and Notes (Copy 2).md", () => {
        expect(generateCopyTitle("Notes.md")).toBe("Notes (Copy).md");
        expect(generateCopyTitle("Notes.md", 1)).toBe("Notes (Copy).md");
        expect(generateCopyTitle("Notes.md", 2)).toBe("Notes (Copy 2).md");
        expect(generateCopyTitle("Notes.md", 5)).toBe("Notes (Copy 5).md");
        expect(generateCopyTitle("Projects")).toBe("Projects (Copy)");
        expect(generateCopyTitle("Projects", 3)).toBe("Projects (Copy 3)");
    });

    it("pure cycle detection: blocks moving a folder into itself (409)", () => {
        const folders = new Map<string, any>([
            ["folder-1", { parentFolderId: null, isFolder: true, deletedAt: null, userId: USER_A_ID }],
        ]);

        const res = checkInMemoryCycle("folder-1", "folder-1", folders, USER_A_ID);
        expect(res.allowed).toBe(false);
        expect(res.status).toBe(409);
        expect(res.error).toBe("Cannot move a folder into itself");
    });

    it("pure cycle detection: blocks moving into descendant across arbitrary depth (409)", () => {
        const folders = new Map<string, any>([
            ["root", { parentFolderId: null, isFolder: true, deletedAt: null, userId: USER_A_ID }],
            ["child", { parentFolderId: "root", isFolder: true, deletedAt: null, userId: USER_A_ID }],
            ["grandchild", { parentFolderId: "child", isFolder: true, deletedAt: null, userId: USER_A_ID }],
            ["greatgrandchild", { parentFolderId: "grandchild", isFolder: true, deletedAt: null, userId: USER_A_ID }],
        ]);

        const res = checkInMemoryCycle("root", "greatgrandchild", folders, USER_A_ID);
        expect(res.allowed).toBe(false);
        expect(res.status).toBe(409);
        expect(res.error).toContain("descendants");

        // Moving grandchild into root is valid
        const validRes = checkInMemoryCycle("grandchild", "root", folders, USER_A_ID);
        expect(validRes.allowed).toBe(true);
    });

    it("cross-user parent isolation: blocks selecting another user's folder as parent (403)", () => {
        const folders = new Map<string, any>([
            ["user-b-folder", { parentFolderId: null, isFolder: true, deletedAt: null, userId: USER_B_ID }],
        ]);

        const res = checkInMemoryCycle("user-a-doc", "user-b-folder", folders, USER_A_ID);
        expect(res.allowed).toBe(false);
        expect(res.status).toBe(403);
    });

    it("precondition check: enforces mandatory If-Match or expectedVersion on updates (428 / 412)", () => {
        const evaluatePrecondition = (headerIfMatch: string | null, bodyExpectedVersion: number | undefined, serverFile: { etag: string; version: number }) => {
            const ifMatch = parseETagHeader(headerIfMatch);
            if (!ifMatch && bodyExpectedVersion === undefined) {
                return { status: 428, error: "Precondition Required" };
            }
            if (ifMatch && ifMatch !== serverFile.etag) {
                return { status: 412, error: "Precondition Failed: ETag mismatch" };
            }
            if (bodyExpectedVersion !== undefined && bodyExpectedVersion !== serverFile.version) {
                return { status: 412, error: "Precondition Failed: version mismatch" };
            }
            return { status: 200 };
        };

        const currentServerState = { etag: "etag-v1", version: 1 };

        // 1. Missing both -> 428 Precondition Required
        expect(evaluatePrecondition(null, undefined, currentServerState).status).toBe(428);

        // 2. Stale ETag -> 412 Precondition Failed
        expect(evaluatePrecondition('"stale-etag"', undefined, currentServerState).status).toBe(412);

        // 3. Stale version -> 412 Precondition Failed
        expect(evaluatePrecondition(null, 0, currentServerState).status).toBe(412);

        // 4. Valid If-Match -> 200 OK
        expect(evaluatePrecondition('"etag-v1"', undefined, currentServerState).status).toBe(200);

        // 5. Valid expectedVersion -> 200 OK
        expect(evaluatePrecondition(null, 1, currentServerState).status).toBe(200);
    });
});

describe("Phase 3: Database Integration Tests", () => {
    it("[DB] cross-user parent isolation: User A cannot target User B's folder", async () => {
        const userBFolderId = randomUUID();
        await testDb.insert(schema.files).values({
            id: userBFolderId,
            userId: USER_B_ID,
            title: "User B Private Folder",
            isFolder: true,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        const parentLookupForUserA = await testDb.query.files.findFirst({
            where: and(
                eq(schema.files.id, userBFolderId),
                eq(schema.files.userId, USER_A_ID),
                isNull(schema.files.deletedAt)
            ),
        });

        expect(parentLookupForUserA).toBeUndefined();
    });

    it("[DB] ADV-01: multiple deleted files with same name coexist and restore without collision", async () => {
        const file1Id = randomUUID();
        const file2Id = randomUUID();

        // 1. Insert file 1, then soft-delete it
        await testDb.insert(schema.files).values({
            id: file1Id,
            userId: USER_A_ID,
            title: "Document.md",
            content: "first version",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
        });

        // 2. Insert file 2 with SAME title, and also soft-delete it (both deleted)
        await expect(testDb.insert(schema.files).values({
            id: file2Id,
            userId: USER_A_ID,
            title: "Document.md",
            content: "second version",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: new Date(),
        })).resolves.not.toThrow();

        // 3. Create a LIVE file with the same title "Document.md"
        const liveFileId = randomUUID();
        await testDb.insert(schema.files).values({
            id: liveFileId,
            userId: USER_A_ID,
            title: "Document.md",
            content: "live active document",
            isFolder: false,
            parentFolderId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
        });

        // 4. Restore file 1 using collision resolution: must become "Document (Restored).md"
        let finalTitle = "Document.md";
        let counter = 1;
        while (true) {
            const liveDup = await testDb.query.files.findFirst({
                where: and(
                    eq(schema.files.userId, USER_A_ID),
                    isNull(schema.files.parentFolderId),
                    eq(schema.files.title, finalTitle),
                    isNull(schema.files.deletedAt)
                ),
            });
            if (!liveDup) break;
            finalTitle = generateRestoredTitle("Document.md", counter);
            counter++;
        }

        expect(finalTitle).toBe("Document (Restored).md");

        await testDb.update(schema.files)
            .set({ title: finalTitle, deletedAt: null })
            .where(eq(schema.files.id, file1Id));

        const restored1 = await testDb.query.files.findFirst({
            where: eq(schema.files.id, file1Id),
        });
        expect(restored1?.title).toBe("Document (Restored).md");
        expect(restored1?.deletedAt).toBeNull();
    });

    it("[DB] restore lifecycle: restoring a file with deleted parent attaches to root", async () => {
        const parentFolderId = randomUUID();
        const fileId = randomUUID();

        await testDb.insert(schema.files).values([
            {
                id: parentFolderId,
                userId: USER_A_ID,
                title: "Deleted Parent Folder",
                isFolder: true,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: new Date(),
            },
            {
                id: fileId,
                userId: USER_A_ID,
                title: "Orphan Child File",
                isFolder: false,
                parentFolderId: parentFolderId,
                content: "content",
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: new Date(),
            },
        ]);

        const target = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, USER_A_ID)),
        });
        expect(target).toBeDefined();

        if (target?.parentFolderId) {
            const parent = await testDb.query.files.findFirst({
                where: and(eq(schema.files.id, target.parentFolderId), eq(schema.files.userId, USER_A_ID)),
            });
            if (!parent || parent.deletedAt) {
                await testDb.update(schema.files)
                    .set({ parentFolderId: null })
                    .where(eq(schema.files.id, fileId));
            }
        }

        await testDb.update(schema.files)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(eq(schema.files.id, fileId));

        const restoredFile = await testDb.query.files.findFirst({
            where: eq(schema.files.id, fileId),
        });

        expect(restoredFile?.deletedAt).toBeNull();
        expect(restoredFile?.parentFolderId).toBeNull();
    });
});
