/**
 * LIVE integration tests — Stripe webhook route against the isolated Neon
 * test branch.
 *
 * Real boundaries: REAL Stripe signature verification (HMAC over the raw body,
 * no SDK mocks) and REAL `subscription-actions` persisting to the branch.
 * Mocked boundary ONLY: `next/headers` (Next.js request store shim, same as
 * the mocked contract suite).
 *
 * Scope note: the durable event-ledger dedupe ("duplicate after restart") is a
 * Phase 13 deliverable — the current in-memory dedupe cannot survive process
 * restarts by design, so that scenario is intentionally NOT asserted here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
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
// Dynamic import AFTER env setup: the route/lib read the secret at call time.
const { POST } = await import("./route");

const USERS = {
    checkout: "12121212-1212-1212-1212-121212121212", // placeholder pattern
    unmapped: "34343434-3434-3434-3434-343434343434",
};

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
        .values({ id, email: `${id}@live.test` })
        .onConflictDoNothing();
}

afterAll(async () => {
    await cleanupTestUsers(Object.values(USERS));
});

describe("LIVE: Stripe webhook route on isolated branch", () => {
    beforeAll(async () => {
        await Promise.all(Object.values(USERS).map(seedUser));
    });

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

    it("checkout.session.completed (paid) really upgrades tier and persists the subscription row", async () => {
        const body = makeEventBody(
            "checkout.session.completed",
            {
                id: "cs_live_1",
                payment_status: "paid",
                subscription: "sub_live_1",
                metadata: { userId: USERS.checkout, tier: "pro" },
            },
            "evt_checkout_live"
        );

        const res = await POST(signedRequest(body));
        expect(res.status).toBe(200);

        const [user] = await testDb
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, USERS.checkout));
        expect(user.tier).toBe("pro");

        const [sub] = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USERS.checkout));
        expect(sub.stripeSubscriptionId).toBe("sub_live_1");
        expect(sub.tier).toBe("pro");
        expect(sub.status).toBe("active");
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
        expect(subs).toHaveLength(0); // no row created either
    });
});
