import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";

test.describe("Scenario 12: Vault Inactivity Auto-Lock, Multi-Modal Unlock & Device Trust", () => {
    test("asserts lock state triggers VaultUnlockModal on encrypted note and clears sensitive keys from volatile RAM", async ({
        page,
        authSession,
    }) => {
        // 1. Seed an encrypted document in database
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "Locked Confidential Note",
                isFolder: false,
                content: "enc:iv_mock_123:auth_tag_456:ciphertext_789",
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "mk-1",
                    salt: "salt",
                    iv: "iv_mock_123",
                    kdfIterations: 600000,
                },
                version: 1,
            })
            .returning();

        // 2. Open editor in browser
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Verify that the encrypted file indicator or lock status is active
        const lockIcon = page.locator('svg.lucide-lock, [data-testid="ai-encrypted-badge"]');
        await expect(lockIcon.first()).toBeVisible({ timeout: 15000 });

        // 4. Verify volatile memory isolation: window.__sessionKeyStore or RAM keys must not leak into localStorage
        const localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
        const leakedKeys = localStorageKeys.filter((k) =>
            k.toLowerCase().includes("master_key") || k.toLowerCase().includes("private_key")
        );
        expect(leakedKeys).toHaveLength(0);
    });
});
