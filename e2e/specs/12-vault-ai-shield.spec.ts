import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";

test.describe("Scenario 13: Zero-Knowledge AI Shield Gatekeeper & HTTP 403 Block", () => {
    test("verifies that encrypted documents render the ai-encrypted-badge and block AI invocation with HTTP 403", async ({
        page,
        context,
        authSession,
    }) => {
        // 1. Seed an encrypted document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Confidential Financials",
                isFolder: false,
                content: "enc:iv_mock:auth_tag_mock:ciphertext_mock",
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-1",
                    salt: "salt",
                    iv: "iv_mock",
                    kdfIterations: 600000,
                },
                version: 1,
            })
            .returning();

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify that the amber AI Shield badge is explicitly displayed in the UI toolbar
        const aiBadge = page.locator('[data-testid="ai-encrypted-badge"]');
        await expect(aiBadge).toBeVisible({ timeout: 15000 });
        await expect(aiBadge).toContainText(/ميزات الـ AI معطلة لحماية التشفير|التشفير محمي/);

        // 4. Verify that programmatic invocation of /api/ai/stream against this encrypted file is blocked with HTTP 403
        const streamResponse = await context.request.post("/api/ai/stream", {
            data: {
                fileId: doc.id,
                text: "Summarize this encrypted text",
                operation: "summarize",
            },
        });

        expect(streamResponse.status()).toBe(403);
        const resBody = await streamResponse.text();
        expect(resBody).toContain("AI_PROHIBITED_ON_ENCRYPTED_FILES");
    });
});
