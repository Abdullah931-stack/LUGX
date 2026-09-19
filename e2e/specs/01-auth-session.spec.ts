import { test, expect } from "../fixtures/auth-fixture";

test.describe("Scenario 1: Authentication & Session Lifecycle", () => {
    test("validates login, SSR session cookies, cross-tab persistence, reload recovery, and logout teardown", async ({
        page,
        context,
        authSession: _authSession,
    }) => {
        // 1. Verify successful authentication on /workspace
        await expect(page).toHaveURL(/\/workspace/);
        await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

        // 2. Verify SSR authentication cookies are present and properly scoped
        const cookies = await context.cookies();
        const authCookie = cookies.find(
            (c) => c.name.startsWith("sb-") && c.name.includes("auth-token")
        );
        expect(authCookie).toBeDefined();
        expect(authCookie?.value.length).toBeGreaterThan(10);

        // 3. Test reload recovery: session must survive hard reload
        await page.reload();
        await page.waitForLoadState("domcontentloaded");
        await expect(page).toHaveURL(/\/workspace/);
        await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

        // 4. Test cross-tab persistence: new page in same browser context must be authenticated
        const secondaryPage = await context.newPage();
        await secondaryPage.goto("/workspace");
        await secondaryPage.waitForLoadState("domcontentloaded");
        await expect(secondaryPage).toHaveURL(/\/workspace/);
        await expect(secondaryPage.getByRole("heading", { name: "Workspace" })).toBeVisible();
        await secondaryPage.close();

        // 5. Test clean logout teardown
        const logoutRes = await page.request.delete("/api/test/e2e-auth");
        expect(logoutRes.ok()).toBeTruthy();

        // Attempting to visit /workspace after logout must redirect to /login
        await page.goto("/workspace");
        await page.waitForLoadState("domcontentloaded");
        await expect(page).toHaveURL(/\/login/);
    });
});
