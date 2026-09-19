import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq, and, isNull, isNotNull } from "drizzle-orm";

test.describe("Scenario 2: File System, Folder Tree & Trash Lifecycle", () => {
    test("creates nested folders, renames, soft deletes, verifies duplicate name coexistence, restores, and permanently purges", async ({
        page,
        authSession,
    }) => {
        // 1. Create a parent folder and a nested document directly in DB for this session
        const [parentFolder] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Projects",
                isFolder: true,
                parentFolderId: null,
            })
            .returning();

        const [subFolder] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Specs",
                isFolder: true,
                parentFolderId: parentFolder.id,
            })
            .returning();

        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Roadmap",
                isFolder: false,
                parentFolderId: subFolder.id,
                content: "# Platform Roadmap\n\nPhase 19 E2E Testing.",
            })
            .returning();

        await page.reload();
        await page.waitForLoadState("domcontentloaded");

        // Verify folder and document exist in DB
        let dbDoc = await getDbFile(doc.id);
        expect(dbDoc).toBeDefined();
        expect(dbDoc?.title).toBe("Roadmap");
        expect(dbDoc?.deletedAt).toBeNull();

        // 2. Rename document
        await e2eDb
            .update(schema.files)
            .set({ title: "Roadmap-Renamed", updatedAt: new Date() })
            .where(eq(schema.files.id, doc.id));

        dbDoc = await getDbFile(doc.id);
        expect(dbDoc?.title).toBe("Roadmap-Renamed");

        // 3. Soft Delete (Move to Trash)
        const deletedTimestamp = new Date();
        await e2eDb
            .update(schema.files)
            .set({ deletedAt: deletedTimestamp, updatedAt: new Date() })
            .where(eq(schema.files.id, doc.id));

        dbDoc = await getDbFile(doc.id);
        expect(dbDoc?.deletedAt).not.toBeNull();

        // 4. Duplicate Name Coexistence: create another active file with the identical name "Roadmap-Renamed"
        const [duplicateDoc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Roadmap-Renamed",
                isFolder: false,
                parentFolderId: subFolder.id,
                content: "# Fresh active document with same title",
            })
            .returning();

        expect(duplicateDoc.id).not.toBe(doc.id);

        // Verify that both files coexist in the database: one active, one deleted
        const activeFiles = await e2eDb.query.files.findMany({
            where: and(
                eq(schema.files.userId, authSession.userId),
                eq(schema.files.title, "Roadmap-Renamed"),
                isNull(schema.files.deletedAt)
            ),
        });
        const trashedFiles = await e2eDb.query.files.findMany({
            where: and(
                eq(schema.files.userId, authSession.userId),
                eq(schema.files.title, "Roadmap-Renamed"),
                isNotNull(schema.files.deletedAt)
            ),
        });

        expect(activeFiles.length).toBe(1);
        expect(trashedFiles.length).toBe(1);

        // 5. Restore soft-deleted file to Root if parent folder is deleted
        await e2eDb
            .update(schema.files)
            .set({ deletedAt: new Date() })
            .where(eq(schema.files.id, subFolder.id));

        // When restoring while parent is deleted, parentFolderId resets to null (root)
        await e2eDb
            .update(schema.files)
            .set({ deletedAt: null, parentFolderId: null, title: "Roadmap-Restored" })
            .where(eq(schema.files.id, doc.id));

        const restoredDoc = await getDbFile(doc.id);
        expect(restoredDoc?.deletedAt).toBeNull();
        expect(restoredDoc?.parentFolderId).toBeNull();

        // 6. Permanent Purge: hard delete the duplicate document
        await e2eDb.delete(schema.files).where(eq(schema.files.id, duplicateDoc.id));
        const purgedDoc = await getDbFile(duplicateDoc.id);
        expect(purgedDoc).toBeUndefined();
    });
});
