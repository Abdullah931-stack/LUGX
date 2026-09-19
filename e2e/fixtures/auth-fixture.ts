import { test as base, expect } from "@playwright/test";
import { cleanupE2EUser } from "./test-db";

export interface AuthenticatedUser {
    userId: string;
    email: string;
    displayName: string;
}

interface TestAuthCookie {
    name: string;
    value: string;
    path?: string;
}

export const test = base.extend<{
    authSession: AuthenticatedUser;
    loginAs: (user: AuthenticatedUser) => Promise<void>;
}>({
    authSession: async ({ page, context }, provide) => {
        const timestamp = Date.now().toString().slice(-6);
        const testUser: AuthenticatedUser = {
            userId: `9999${timestamp}-9999-9999-9999-999999999999`,
            email: `e2e-${timestamp}@lugx.test`,
            displayName: `E2E User ${timestamp}`,
        };

        // Call the dedicated test authentication API using context.request
        const response = await context.request.post("/api/test/e2e-auth", {
            data: {
                email: testUser.email,
                password: "E2E_Secure_Pass_2026!",
                displayName: testUser.displayName,
            },
        });

        expect(response.ok()).toBeTruthy();
        const json = await response.json();
        testUser.userId = json.user.id;

        // Explicitly inject returned cookies into the browser context
        if (json.cookies && Array.isArray(json.cookies)) {
            const cookiesToAdd = (json.cookies as TestAuthCookie[]).map((c) => ({
                name: c.name,
                value: c.value,
                domain: "localhost",
                path: c.path || "/",
                httpOnly: false,
                secure: false,
                sameSite: "Lax" as const,
            }));
            await context.addCookies(cookiesToAdd);
        }

        // Navigate page to load workspace with the established cookies
        await page.goto("/workspace");
        await page.waitForLoadState("domcontentloaded");

        await provide(testUser);

        // Teardown: clean up database records
        await cleanupE2EUser(testUser.userId);
    },

    loginAs: async ({ page, context }, provide) => {
        const loginFn = async (user: AuthenticatedUser) => {
            const response = await context.request.post("/api/test/e2e-auth", {
                data: {
                    email: user.email,
                    password: "E2E_Secure_Pass_2026!",
                    displayName: user.displayName,
                },
            });
            expect(response.ok()).toBeTruthy();
            const json = await response.json();
            user.userId = json.user.id;

            if (json.cookies && Array.isArray(json.cookies)) {
                const cookiesToAdd = (json.cookies as TestAuthCookie[]).map((c) => ({
                    name: c.name,
                    value: c.value,
                    domain: "localhost",
                    path: c.path || "/",
                    httpOnly: false,
                    secure: false,
                    sameSite: "Lax" as const,
                }));
                await context.addCookies(cookiesToAdd);
            }

            await page.goto("/workspace");
            await page.waitForLoadState("domcontentloaded");
        };

        await provide(loginFn);
    },
});

export { expect };
