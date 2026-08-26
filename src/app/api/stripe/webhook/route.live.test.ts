/**
 * LIVE integration tests — Stripe webhook route against the isolated Neon test branch (Phase 13).
 *
 * Real boundaries:
 * 1. REAL Stripe signature verification (HMAC over raw body with tolerance window).
 * 2. REAL database transactions and persistence to `subscription_events`, `users`, and `subscriptions`.
 * 3. REAL durable idempotency ledger surviving memory resets (__resetProcessedEventIds).
 * 4. REAL subscription period validation (guaranteeing currentPeriodStart !== currentPeriodEnd).
 * 
 * Mocked boundary ONLY: `next/headers` (Next.js request store shim).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { runMigrations } from "@/test/db.setup";
import * as schema from "@/lib/db/schema";

const SECRET = "whsec_live_test_secret";

// Shim next/headers so the route can read stripe-signature from our request.
let __lastRequest: NextRequest | null = null;
vi.mock("next/headers", () => ({
    headers: async () =>
        ({
            get: (name: string) => __lastRequest?.headers.get(name) ?? null,
        }) as never,
}));

process.env.STRIPE_WEBHOOK_SECRET = SECRET;
// Dynamic import AFTER env setup
const { POST, __resetProcessedEventIds } = await import("./route");

const USERS = {
    checkout: "12121212-1212-1212-1212-121212121212",
    unmapped: "34343434-3434-3434-3434-343434343434",
    deleted: "56565656-5656-5656-5656-565656565656",
};

const TEST_EVENTS = [
    "evt_checkout_live",
    "evt_unmapped_live",
    "evt_deleted_live",
    "evt_stale_live_resurrect",
];

function signedRequest(body: string, secret = SECRET): NextRequest {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
    const req = new NextRequest("http://localhost:3000/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
        body,
    });
    __lastRequest = req;
    return req;
}

function makeEventBody(
    type: string,
    dataObject: Record<string, unknown>,
    id: string
): string {
    return JSON.stringify({ id, type, data: { object: dataObject } });
}

async function seedUser(id: string) {
    await testDb
        .insert(schema.users)
        .values({ id, email: `${id}@live.test`, tier: "free" })
        .onConflictDoNothing();
}

beforeAll(async () => {
    await runMigrations();
    try {
        await testDb
            .delete(schema.subscriptionEvents)
            .where(inArray(schema.subscriptionEvents.eventId, TEST_EVENTS));
    } catch {
        // best effort
    }
    await Promise.all(Object.values(USERS).map(seedUser));
});

afterAll(async () => {
    try {
        await testDb
            .delete(schema.subscriptionEvents)
            .where(inArray(schema.subscriptionEvents.eventId, TEST_EVENTS));
    } catch {
        // best effort cleanup
    }
    await cleanupTestUsers(Object.values(USERS));
});

describe("LIVE: Stripe webhook route & durable idempotency on isolated branch", () => {
    it("rejects an invalid signature with 400 BEFORE any parsing or mutation", async () => {
        const body = makeEventBody("checkout.session.completed", {}, "evt_bad_sig");
        const req = new NextRequest("http://localhost:3000/api/stripe/webhook", {
            method: "POST",
            headers: { "stripe-signature": "t=1,v1=deadbeef" },
            body,
        });
        __lastRequest = req;

        const res = await POST(req);
        expect(res.status).toBe(400);

        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.checkout));
        expect(user.tier).toBe("free"); // untouched
    });

    it("checkout.session.completed (paid) upgrades tier, persists subscription with valid period, and writes durable event", async () => {
        const body = makeEventBody(
            "checkout.session.completed",
            {
                id: "cs_live_1",
                payment_status: "paid",
                subscription: "sub_live_1",
                metadata: { userId: USERS.checkout, tier: "pro" },
                created: 1700000000,
            },
            "evt_checkout_live"
        );

        const res = await POST(signedRequest(body));
        expect(res.status).toBe(200);

        // 1. Verify User Tier upgraded to pro
        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.checkout));
        expect(user.tier).toBe("pro");

        // 2. Verify Subscription record and period fields
        const [sub] = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USERS.checkout));
        expect(sub.stripeSubscriptionId).toBe("sub_live_1");
        expect(sub.tier).toBe("pro");
        expect(sub.status).toBe("active");
        expect(sub.currentPeriodStart).toBeInstanceOf(Date);
        expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
        expect(sub.currentPeriodStart?.getTime()).not.toBe(sub.currentPeriodEnd?.getTime());
        expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(sub.currentPeriodStart!.getTime());

        // 3. Verify Durable Event Record written
        const [eventRow] = await testDb
            .select()
            .from(schema.subscriptionEvents)
            .where(eq(schema.subscriptionEvents.eventId, "evt_checkout_live"));
        expect(eventRow).toBeDefined();
        expect(eventRow.eventType).toBe("checkout.session.completed");
        expect(eventRow.status).toBe("processed");
    });

    it("durable restart idempotency: re-sending event after in-memory cache clear yields duplicate: true with ZERO DB mutation", async () => {
        // Clear in-memory cache to simulate server restart / new worker instance
        __resetProcessedEventIds();

        const body = makeEventBody(
            "checkout.session.completed",
            {
                id: "cs_live_1",
                payment_status: "paid",
                subscription: "sub_live_1",
                metadata: { userId: USERS.checkout, tier: "pro" },
                created: 1700000000,
            },
            "evt_checkout_live"
        );

        const res = await POST(signedRequest(body));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toMatchObject({ received: true, duplicate: true });

        // Verify only 1 event row exists in subscription_events
        const eventRows = await testDb
            .select()
            .from(schema.subscriptionEvents)
            .where(eq(schema.subscriptionEvents.eventId, "evt_checkout_live"));
        expect(eventRows).toHaveLength(1);
    });

    it("unmapped subscription status is fail-closed: no DB mutation", async () => {
        const body = makeEventBody(
            "customer.subscription.updated",
            {
                id: "sub_future",
                metadata: { userId: USERS.unmapped, tier: "ultra" },
                status: "some_future_stripe_status",
                cancel_at_period_end: false,
                start_date: Math.floor(Date.now() / 1000),
            },
            "evt_unmapped_live"
        );

        await POST(signedRequest(body));

        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.unmapped));
        expect(user.tier).toBe("free"); // no silent upgrade

        const subs = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USERS.unmapped));
        expect(subs).toHaveLength(0); // no row created
    });

    it("customer.subscription.deleted downgrades tier to free and updates subscription status", async () => {
        // First, grant pro tier to user
        await testDb
            .update(schema.users)
            .set({ tier: "pro" })
            .where(eq(schema.users.id, USERS.deleted));

        await testDb
            .insert(schema.subscriptions)
            .values({
                userId: USERS.deleted,
                stripeSubscriptionId: "sub_to_delete",
                tier: "pro",
                status: "active",
                currentPeriodStart: new Date(1700000000 * 1000),
                currentPeriodEnd: new Date(1702592000 * 1000),
            })
            .onConflictDoNothing();

        const body = makeEventBody(
            "customer.subscription.deleted",
            {
                id: "sub_to_delete",
                metadata: { userId: USERS.deleted },
                status: "canceled",
                cancel_at_period_end: false,
                start_date: 1700000000,
            },
            "evt_deleted_live"
        );

        const res = await POST(signedRequest(body));
        expect(res.status).toBe(200);

        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.deleted));
        expect(user.tier).toBe("free");

        const [sub] = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USERS.deleted));
        expect(sub.status).toBe("canceled");
        expect(sub.tier).toBe("free");
        expect(sub.currentPeriodStart?.getTime()).not.toBe(sub.currentPeriodEnd?.getTime());
    });

    it("terminal state protection: stale customer.subscription.updated active event does not resurrect a canceled subscription on live DB", async () => {
        // User is currently deleted/canceled
        const body = makeEventBody(
            "customer.subscription.updated",
            {
                id: "sub_to_delete",
                metadata: { userId: USERS.deleted, tier: "pro" },
                status: "active",
                cancel_at_period_end: false,
                start_date: 1700000000,
            },
            "evt_stale_live_resurrect"
        );

        const res = await POST(signedRequest(body));
        expect(res.status).toBe(200);

        // Verify tier remains free
        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.deleted));
        expect(user.tier).toBe("free");

        // Verify subscription remains canceled
        const [sub] = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USERS.deleted));
        expect(sub.status).toBe("canceled");

        // Verify event was recorded as ignored_stale
        const [eventRow] = await testDb
            .select()
            .from(schema.subscriptionEvents)
            .where(eq(schema.subscriptionEvents.eventId, "evt_stale_live_resurrect"));
        expect(eventRow).toBeDefined();
        expect(eventRow.status).toBe("ignored_stale");
    });
});

