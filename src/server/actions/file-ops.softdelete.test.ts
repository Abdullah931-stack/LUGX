/**
 * M3: Soft-delete lifecycle integration tests.
 *
 * REAL DATABASE TEST: local Postgres + Drizzle (pg driver) + full schema.
 *
 * Verifies the production soft-delete contract implemented in
 * @/server/actions/file-ops and enforced by migration 0003:
 *
 *   1. delete = tombstone (deleted_at IS NOT NULL), row stays in the DB.
 *   2. Every live read query filters deleted_at IS NULL
 *      (getFile / getUserFiles / getRootFiles / getFolderChildren).
 *   3. Live writes (updateFileContent / renameFile / moveFile) REJECT
 *      tombstoned rows — no stale sync replay can resurrect/modify them.
 *   4. restoreFile clears the tombstone; purged (physically deleted)
 *      rows cannot be restored.
 *   5. The partial unique index (user_id, parent_folder_id, title)
 *      WHERE deleted_at IS NULL means a user CAN recreate a file with
 *      the same name after deletion (no false unique violation).
 *   6. The purge DELETE WHERE deleted_at <= cutoff LIMIT 500 is bounded
 *      and parameterized (no injection surface).
 *
 * Server actions themselves require Supabase auth + remote Neon, so the
 * algorithm is exercised directly against the real schema via the
 * pg-backed test client. The SQL shapes are identical to production.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull, isNotNull, lte, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations } from "@/test/db.setup";
import { testDb } from "@/test/test-db";
import { randomUUID } from "crypto";

const TEST_USER_ID = "22222222-2222-2222-2222-222222222222";

const fileOf = (title: string, parent: string | null = null) => ({
    id: randomUUID(),
    userId: TEST_USER_ID,
    title,
    content: "<p>content</p>",
    isFolder: false,
    parentFolderId: parent,
    storagePath: null,
    etag: null,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null as Date | null,
});

beforeAll(async () => {
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "softdelete-test@example.com" })
        .onConflictDoNothing();
});

afterAll(async () => {
    try { await testDb.delete(schema.files); } catch { /* ignore */ }
});

describe("soft delete lifecycle", () => {
    it("delete is a tombstone: row stays, reads become invisible", async () => {
        const file = fileOf("to-be-deleted.md");
        await testDb.insert(schema.files).values(file);

        // Live read finds it
        const live = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, file.id), eq(schema.files.userId, TEST_USER_ID)),
        });
        expect(live?.deletedAt).toBeNull();

        // Tombstone (production deleteFile does exactly this UPDATE)
        await testDb
            .update(schema.files)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(schema.files.id, file.id), eq(schema.files.userId, TEST_USER_ID)));

        // Live read (all four production read queries) no longer sees it
        const queries = [
            // getFile
            testDb.query.files.findFirst({
                where: and(
                    eq(schema.files.id, file.id),
                    eq(schema.files.userId, TEST_USER_ID),
                    isNull(schema.files.deletedAt)
                ),
            }),
            // getUserFiles
            testDb.query.files.findMany({
                where: and(eq(schema.files.userId, TEST_USER_ID), isNull(schema.files.deletedAt)),
            }),
            // getRootFiles
            testDb.query.files.findMany({
                where: and(
                    eq(schema.files.userId, TEST_USER_ID),
                    isNull(schema.files.parentFolderId),
                    isNull(schema.files.deletedAt)
                ),
            }),
            // getFolderChildren — same where-shape as production
            testDb.query.files.findMany({
                where: and(
                    eq(schema.files.userId, TEST_USER_ID),
                    file.parentFolderId
                        ? eq(schema.files.parentFolderId, file.parentFolderId)
                        : isNull(schema.files.parentFolderId),
                    isNull(schema.files.deletedAt)
                ),
            }),
        ];

        const [one, many, roots, children] = await Promise.all(queries) as [
            typeof schema.files.$inferSelect | undefined,
            typeof schema.files.$inferSelect[],
            typeof schema.files.$inferSelect[],
            typeof schema.files.$inferSelect[],
        ];
        expect(one).toBeUndefined();
        expect(many.every((f) => f.id !== file.id)).toBe(true);
        expect(roots.every((f) => f.id !== file.id)).toBe(true);
        expect(children.every((f) => f.id !== file.id)).toBe(true);

        // Row still exists (tombstone, visible to admin/restore only)
        const tomb = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, file.id), isNotNull(schema.files.deletedAt)),
        });
        expect(tomb).toBeDefined();
        expect(tomb!.deletedAt).toBeInstanceOf(Date);
    });

    it("restoreFile clears the tombstone and the file reappears in reads", async () => {
        const file = fileOf("to-be-restored.md");
        await testDb.insert(schema.files).values(file);
        await testDb
            .update(schema.files)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.files.id, file.id));

        // restoreFile: clear deleted_at
        await testDb
            .update(schema.files)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(and(eq(schema.files.id, file.id), eq(schema.files.userId, TEST_USER_ID)));

        const restored = await testDb.query.files.findFirst({
            where: and(
                eq(schema.files.id, file.id),
                eq(schema.files.userId, TEST_USER_ID),
                isNull(schema.files.deletedAt)
            ),
        });
        expect(restored?.deletedAt).toBeNull();

        // Purged rows (physically deleted) are not restorable
        const goneId = randomUUID();
        const gone = fileOf("gone-forever.md");
        await testDb.insert(schema.files).values({ ...gone, id: goneId, deletedAt: new Date() });
        await testDb.delete(schema.files).where(eq(schema.files.id, goneId));
        const lookup = await testDb.query.files.findFirst({
            where: and(eq(schema.files.id, goneId), eq(schema.files.userId, TEST_USER_ID)),
        });
        expect(lookup).toBeUndefined();
    });

    it("live writes reject tombstoned rows (updateContent / rename / move)", async () => {
        const file = fileOf("frozen-while-deleted.md");
        await testDb.insert(schema.files).values(file);
        await testDb
            .update(schema.files)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.files.id, file.id));

        const whereLive = and(
            eq(schema.files.id, file.id),
            eq(schema.files.userId, TEST_USER_ID),
            isNull(schema.files.deletedAt)
        );

        // updateFileContent: read returns nothing → rejects with "not found"
        const currentFile = await testDb.query.files.findFirst({ where: whereLive });
        expect(currentFile).toBeUndefined();

        // renameFile / moveFile: UPDATE touches 0 rows → rejects
        const renameResult = await testDb
            .update(schema.files)
            .set({ title: "sneaky-rename.md", updatedAt: new Date() })
            .where(whereLive);
        expect(renameResult.rowCount ?? 0).toBe(0);

        const moveResult = await testDb
            .update(schema.files)
            .set({ parentFolderId: randomUUID(), updatedAt: new Date() })
            .where(whereLive);
        expect(moveResult.rowCount ?? 0).toBe(0);

        // Title and parent are unchanged (the tombstone survived)
        const tomb = await testDb.query.files.findFirst({ where: eq(schema.files.id, file.id) });
        expect(tomb!.title).toBe("frozen-while-deleted.md");
    });

    it("unique name index ignores tombstones — re-creating a deleted name never conflicts", async () => {
        // Tombstone a row whose name will be reused
        const old = fileOf("same-name.md");
        await testDb.insert(schema.files).values(old);
        await testDb
            .update(schema.files)
            .set({ deletedAt: new Date() })
            .where(eq(schema.files.id, old.id));

        // Live row with the same name in the same folder
        const fresh = fileOf("same-name.md");
        await expect(
            testDb.insert(schema.files).values(fresh)
        ).resolves.not.toThrow();

        // Live duplicate (same name, no tombstone) still conflicts
        const dup = fileOf("same-name.md");
        await expect(
            testDb.insert(schema.files).values(dup)
            // Drizzle wraps Postgres errors: match the wrapped "Failed query" or
            // the raw "duplicate key … unique constraint" message.
        ).rejects.toThrow(/unique|duplicate|violates|Failed query/i);
    });
});

describe("purge job semantics", () => {
    it("bounded parameterized DELETE only removes rows past the retention window", async () => {
        const BATCH_LIMIT = 500;

        // One row still within the 30-day window (must survive)
        const fresh = fileOf("fresh-tombstone.md");
        await testDb.insert(schema.files).values({
            ...fresh,
            deletedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
        });

        // One row past the window (must be purged)
        const expired = fileOf("expired-tombstone.md");
        await testDb.insert(schema.files).values({
            ...expired,
            deletedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
        });

        const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

        // Exact SQL shape of /api/cron/purge-deleted (CTE-bounded DELETE).
        // LIMIT must be a fixed literal — Postgres prepared statements reject
        // parameterized LIMIT ($2) — so the production route keeps a constant
        // BATCH_LIMIT instead of any request-controlled value.
        const result = await testDb.execute(sql`
            WITH doomed AS (
                SELECT id FROM files
                WHERE deleted_at <= ${cutoff}
                LIMIT 500
            )
            DELETE FROM files USING doomed
            WHERE files.id = doomed.id
        `);

        expect(result.rowCount ?? 0).toBe(1);

        const survivors = await testDb.query.files.findMany({
            where: eq(schema.files.userId, TEST_USER_ID),
        });
        expect(survivors.map((f) => f.id)).toContain(fresh.id);
        expect(survivors.map((f) => f.id)).not.toContain(expired.id);
    });
});
