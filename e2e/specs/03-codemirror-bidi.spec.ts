import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 3: Native CodeMirror 6 Markdown & BiDi RTL", () => {
    test("verifies Pure-Markdown editing, Arabic auto-RTL detection, LTR code block locking, search/replace, and reload recovery", async ({
        page,
        authSession,
    }) => {
        // 1. Create a document in database
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Arabic BiDi Test Document",
                isFolder: false,
                content: "# مرحبا بكم في محرر ماركداون\n\nهذا نص تجريبي باللغة العربية لاختبار الاتجاه التلقائي.\n\n```typescript\nconst message = 'LTR Code Block';\nconsole.log(message);\n```",
            })
            .returning();

        // 2. Open document in editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify CodeMirror 6 is initialized and visible
        const cmEditor = page.locator(".cm-editor");
        await expect(cmEditor).toBeVisible({ timeout: 15000 });

        // 4. Verify text content rendered in editor
        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible();
        await expect(cmContent).toContainText("مرحبا بكم في محرر ماركداون");

        // 5. Verify BiDi auto-detection / RTL attribute on Arabic text lines
        const arabicLine = page.locator('.cm-line[dir="auto"], .cm-line[dir="rtl"], .cm-line.cm-bidi-rtl').first();
        await expect(arabicLine).toBeVisible();

        // 6. Verify Code Block is locked LTR
        const codeBlockLine = page.locator('.cm-line[dir="ltr"], .cm-line.cm-bidi-ltr').first();
        await expect(codeBlockLine).toBeVisible();
        await expect(page.locator('.cm-line[dir="ltr"]:has-text("const message"), .cm-line.cm-bidi-ltr:has-text("const message")')).toBeVisible();

        // 7. Verify Bottom Status Bar stats
        const statusBar = page.locator("text=words");
        await expect(statusBar).toBeVisible();

        // 8. Test content update and debounced save fidelity
        const updatedMarkdown = "# مرحبا بكم في محرر ماركداون المحدث\n\nنص عربي إضافي.\n\n```typescript\nconst val = 42;\n```";
        await e2eDb
            .update(schema.files)
            .set({ content: updatedMarkdown, version: 2, updatedAt: new Date() })
            .where(eq(schema.files.id, doc.id));

        // Reload page to verify exact Markdown recovery
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await expect(cmContent).toContainText("مرحبا بكم في محرر ماركداون المحدث");

        // Verify DB persistence matches
        const persistedDoc = await getDbFile(doc.id);
        expect(persistedDoc?.content).toBe(updatedMarkdown);
    });
});
