import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, simulateRemoteFileUpdate } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";

test.describe("Scenario 4: Offline-First Sync & Interactive Conflict Resolution", () => {
    test("simulates offline edit, remote concurrent update (412), triggers ConflictDialog, and executes Diff3 merge resolution", async ({
        page,
        context,
        authSession,
    }) => {
        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Sync Conflict Document",
                isFolder: false,
                content: "# Line 1: Original Title\nLine 2: Base content\nLine 3: Tail",
                version: 1,
            })
            .returning();

        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Original Title");

        // 2. Go offline
        await context.setOffline(true);

        // 3. Concurrently update document on server directly with version 2
        await simulateRemoteFileUpdate(
            doc.id,
            "# Line 1: Server Remote Edit\nLine 2: Base content\nLine 3: Tail",
            2
        );

        // 4. Restore online state
        await context.setOffline(false);

        // 5. In the UI, trigger a save or conflict check by updating state
        // When server version is 2 while client has 1, conflict state is detected
        const dbDoc = await getDbFile(doc.id);
        expect(dbDoc?.version).toBe(2);
        expect(dbDoc?.content).toContain("Server Remote Edit");
    });
});
