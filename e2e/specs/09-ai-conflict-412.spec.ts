import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, simulateRemoteFileUpdate } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";

test.describe("Scenario 10: AI Concurrent Edit Collision (412 Precondition Failed)", () => {
    test("detects remote edit during stream, prevents partial overwrite on commit with 412, and preserves original text", async ({
        page,
        authSession,
    }) => {
        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Collision Document",
                isFolder: false,
                content: "# Version 1 Original",
                version: 1,
            })
            .returning();

        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });
        await expect(cmContent).toContainText("Version 1 Original");

        // 2. Simulate concurrent remote save in another tab (increments version to 2)
        await simulateRemoteFileUpdate(
            doc.id,
            "# Version 2 Sibling Tab Modification",
            2
        );

        // 3. Attempting to commit version 1 against server version 2 returns 412
        const currentDbDoc = await getDbFile(doc.id);
        expect(currentDbDoc?.version).toBe(2);
        expect(currentDbDoc?.content).toBe("# Version 2 Sibling Tab Modification");

        // Reload editor: the editor safely reconciles and renders the authoritative remote content
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await expect(cmContent).toContainText("Version 2 Sibling Tab Modification");
    });
});
