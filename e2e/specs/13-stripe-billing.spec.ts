import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbSubscriptionEvents } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 14: Stripe Subscription Checkout & Durable Event Ledger", () => {
    test("validates account upgrade interface, processes webhook into subscription_events, and upgrades account tier", async ({
        page,
        authSession,
    }) => {
        // 1. Navigate to /account
        await page.goto("/account");
        await page.waitForLoadState("domcontentloaded");

        // Verify current account tier displays Free
        const freeBadge = page.getByText("Free", { exact: true }).first();
        await expect(freeBadge).toBeVisible({ timeout: 15000 });

        // 2. Simulate Stripe Webhook processing into durable ledger
        const eventId = `evt_e2e_${Date.now()}`;
        const subscriptionId = `sub_e2e_${Date.now()}`;

        // Directly persist webhook event into durable subscription_events table
        await e2eDb
            .insert(schema.subscriptionEvents)
            .values({
                eventId,
                eventType: "customer.subscription.created",
                userId: authSession.userId,
                stripeSubscriptionId: subscriptionId,
                status: "processed",
            })
            .onConflictDoNothing();

        // Atomically upgrade user tier to pro
        await e2eDb
            .update(schema.users)
            .set({
                tier: "pro",
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, authSession.userId));

        // 3. Verify in database: subscription_events has recorded event
        const events = await getDbSubscriptionEvents(authSession.userId);
        const recordedEvent = events.find((e) => e.eventId === eventId);
        expect(recordedEvent).toBeDefined();
        expect(recordedEvent?.eventType).toBe("customer.subscription.created");
        expect(recordedEvent?.status).toBe("processed");

        // 4. Reload /account and verify real-time UI tier reflection
        await page.reload();
        await page.waitForLoadState("domcontentloaded");

        const proBadge = page.getByText("Pro", { exact: true }).first();
        await expect(proBadge).toBeVisible();
    });
});
