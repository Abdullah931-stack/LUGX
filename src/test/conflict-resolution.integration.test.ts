/**
 * Phase 4 Integration Test: Real Three-Way Conflict Resolution Lifecycle
 *
 * Exercises the end-to-end conflict resolution lifecycle against real PostgreSQL schema:
 * 1. Base snapshot tracking & dirty local modification
 * 2. Stale write rejection with 412 Conflict and serverVersion extraction
 * 3. Deterministic Three-Way Merge using base, local, and remote payloads
 * 4. Single authoritative write with newly incremented expectedVersion
 * 5. Persistence verification: reload from Postgres returns exact merged content & version
 * 6. Delete conflict detection & restore resolution
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { randomUUID } from "crypto";
import { conflictResolver } from "@/lib/sync/conflict-resolver";
import { generateETagSync } from "@/lib/sync/etag-generator";

const TEST_USER_ID = "66666666-6666-6666-6666-666666666666";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "conflict-integration-test@example.com" })
        .onConflictDoNothing();
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
});

beforeEach(async (ctx) => {
    if (!dbAvailable) {
        ctx.skip();
        return;
    }
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "conflict-integration-test@example.com" })
        .onConflictDoNothing();
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

/**
 * Executes an optimistic-locked write against the database matching updateFileContent contract
 */
async function executeOptimisticWrite(
    fileId: string,
    content: string,
    expectedVersion: number,
    userId: string = TEST_USER_ID,
    title?: string
) {
    const current = await testDb.query.files.findFirst({
        where: and(eq(schema.files.id, fileId), eq(schema.files.userId, userId), isNull(schema.files.deletedAt)),
    });

    if (!current) {
        return { success: false, status: "not_found" as const };
    }

    if (current.version !== expectedVersion) {
        return {
            success: false,
            status: "conflict" as const,
            serverVersion: {
                version: current.version,
                etag: current.etag,
                content: current.content,
                title: current.title,
                updatedAt: current.updatedAt.toISOString(),
            },
        };
    }

    const newVersion = current.version + 1;
    const now = new Date();
    const newEtag = generateETagSync({ id: fileId, content, updatedAt: now });

    const [updated] = await testDb
        .update(schema.files)
        .set({
            content,
            title: title ?? current.title,
            etag: newEtag,
            version: newVersion,
            updatedAt: now,
        })
        .where(
            and(
                eq(schema.files.id, fileId),
                eq(schema.files.userId, userId),
                eq(schema.files.version, expectedVersion),
                isNull(schema.files.deletedAt)
            )
        )
        .returning();

    if (!updated) {
        const refreshed = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, userId)),
        });
        return {
            success: false,
            status: "conflict" as const,
            serverVersion: refreshed ? {
                version: refreshed.version,
                etag: refreshed.etag,
                content: refreshed.content,
                title: refreshed.title,
                updatedAt: refreshed.updatedAt.toISOString(),
            } : undefined,
        };
    }

    return {
        success: true,
        version: updated.version,
        etag: updated.etag,
        content: updated.content,
        title: updated.title,
    };
}

describe("Three-Way Conflict Resolution Lifecycle on PostgreSQL", () => {
    it("full three-way merge lifecycle: base -> concurrent remote edit -> local conflict (412) -> 3-way merge -> single authoritative write -> reload verified", async () => {
        const fileId = randomUUID();
        const baseContent = "Title Section\nParagraph 1: Original text\nParagraph 2: Stable content\nFooter Note";
        const baseTitle = "Document V1";
        const now = new Date();
        const baseEtag = generateETagSync({ id: fileId, content: baseContent, updatedAt: now });

        // Step 1: Initialize document at Version 1
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: baseTitle,
            content: baseContent,
            version: 1,
            etag: baseEtag,
            isFolder: false,
            createdAt: now,
            updatedAt: now,
        });

        // Step 2: Remote writer updates line 1 (advancing server to Version 2)
        const remoteContent = "Title Section\nParagraph 1: Remote updated text\nParagraph 2: Stable content\nFooter Note";
        const remoteWrite = await executeOptimisticWrite(fileId, remoteContent, 1);
        expect(remoteWrite.success).toBe(true);
        expect(remoteWrite.version).toBe(2);

        // Step 3: Local user held base (v1) and modified line 4
        const localContent = "Title Section\nParagraph 1: Original text\nParagraph 2: Stable content\nFooter Note: Local additions";
        
        // Local attempts to write with stale expectedVersion: 1 -> MUST yield 412 Conflict
        const localAttempt = await executeOptimisticWrite(fileId, localContent, 1);
        expect(localAttempt.success).toBe(false);
        expect(localAttempt.status).toBe("conflict");
        expect(localAttempt.serverVersion).toBeDefined();
        expect(localAttempt.serverVersion?.version).toBe(2);
        expect(localAttempt.serverVersion?.content).toBe(remoteContent);

        // Step 4: Perform Three-Way Merge using base (v1), local (v1 edits), and remote (v2)
        const mergeResult = conflictResolver.attemptThreeWayMerge({
            base: { content: baseContent, title: baseTitle, version: 1 },
            local: { content: localContent, title: baseTitle, version: 1 },
            remote: {
                content: localAttempt.serverVersion!.content!,
                title: localAttempt.serverVersion!.title,
                version: localAttempt.serverVersion!.version ?? undefined,
            },
        });

        expect(mergeResult.success).toBe(true);
        expect(mergeResult.status).toBe("merged_clean");
        expect(mergeResult.hasOverlaps).toBe(false);
        expect(mergeResult.content).toContain("Paragraph 1: Remote updated text");
        expect(mergeResult.content).toContain("Footer Note: Local additions");

        // Step 5: Single authoritative write with expectedVersion: 2 (server's current version)
        const resolvedWrite = await executeOptimisticWrite(
            fileId,
            mergeResult.content!,
            localAttempt.serverVersion!.version || 2
        );

        expect(resolvedWrite.success).toBe(true);
        expect(resolvedWrite.version).toBe(3); // Successfully advanced to v3

        // Step 6: Reload verification from PostgreSQL
        const reloaded = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, fileId), eq(schema.files.userId, TEST_USER_ID)),
        });

        expect(reloaded).toBeDefined();
        expect(reloaded?.version).toBe(3);
        expect(reloaded?.content).toBe(mergeResult.content);
        expect(reloaded?.content).toContain("Paragraph 1: Remote updated text");
        expect(reloaded?.content).toContain("Footer Note: Local additions");
        expect(reloaded?.etag).toBe(resolvedWrite.etag);
    });

    it("rejects auto-merge when base snapshot is missing and requires manual resolution", async () => {
        const fileId = randomUUID();
        const serverContent = "Server text on file";
        const now = new Date();

        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "No Base Doc",
            content: serverContent,
            version: 2,
            etag: generateETagSync({ id: fileId, content: serverContent, updatedAt: now }),
            isFolder: false,
            createdAt: now,
            updatedAt: now,
        });

        // Attempting 3-way merge with null base must flag manual_resolution_required
        const mergeResult = conflictResolver.attemptThreeWayMerge({
            base: null,
            local: { content: "Local text without base" },
            remote: { content: serverContent },
        });

        expect(mergeResult.success).toBe(false);
        expect(mergeResult.status).toBe("manual_resolution_required");
        expect(mergeResult.hasOverlaps).toBe(true);
    });

    it("detects remote delete conflict and allows manual restoration write", async () => {
        const fileId = randomUUID();
        const originalContent = "Original document content";
        const now = new Date();

        await testDb.insert(schema.files).values({
            id: fileId,
            userId: TEST_USER_ID,
            title: "Deleted Doc",
            content: originalContent,
            version: 1,
            etag: generateETagSync({ id: fileId, content: originalContent, updatedAt: now }),
            isFolder: false,
            createdAt: now,
            updatedAt: now,
        });

        // Soft delete the file in server
        await testDb.update(schema.files).set({ deletedAt: new Date(), version: 2 }).where(eq(schema.files.id, fileId));

        // Local user has edits
        const localEditedContent = "Original document content with local unsaved additions";

        // Detect conflict with deleted server version
        const mergeResult = conflictResolver.attemptThreeWayMerge({
            base: { content: originalContent, version: 1 },
            local: { content: localEditedContent, deleted: false },
            remote: { content: "", deleted: true, version: 2 },
        });

        expect(mergeResult.success).toBe(false);
        expect(mergeResult.status).toBe("delete_conflict");
        expect(mergeResult.deleteAction).toBe("remote_deleted_local_modified");

        // User chooses to restore with local content
        const resolution = conflictResolver.resolveConflict(
            {
                fileId,
                localVersion: {
                    content: localEditedContent,
                    etag: "local-etag",
                    lastModified: Date.now(),
                    version: 1,
                },
                serverVersion: {
                    content: "",
                    etag: "server-etag",
                    lastModified: Date.now(),
                    version: 2,
                    deleted: true,
                },
                operations: [],
                detectedAt: Date.now(),
                type: "delete_conflict",
            },
            "restore"
        );

        expect(resolution.content).toBe(localEditedContent);
        expect(resolution.deleted).toBe(false);

        // Restore in Postgres
        const [restored] = await testDb
            .update(schema.files)
            .set({
                content: resolution.content,
                deletedAt: null,
                version: 3,
                updatedAt: new Date(),
                etag: generateETagSync({ id: fileId, content: resolution.content, updatedAt: new Date() }),
            })
            .where(and(eq(schema.files.id, fileId), eq(schema.files.userId, TEST_USER_ID)))
            .returning();

        expect(restored).toBeDefined();
        expect(restored.deletedAt).toBeNull();
        expect(restored.version).toBe(3);
        expect(restored.content).toBe(localEditedContent);
    });
});
