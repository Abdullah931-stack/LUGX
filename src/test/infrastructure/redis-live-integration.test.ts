/**
 * LIVE Integration Test Suite — Upstash Redis Integration, Lock Contention,
 * and Fail-Open Verification (Phase 4).
 *
 * Verifies:
 * 1. In-memory Upstash HTTP REST protocol emulator (`node:http`)wire compliance.
 * 2. Distributed concurrency locking (`stripe:lock:${eventId}`) with `nx: true` and `ex: 30`.
 * 3. Simultaneous lock contention race condition mitigation before database connection consumption.
 * 4. Latency degradation (>1500ms) with graceful fail-open fallback to PostgreSQL ACID Ledger.
 * 5. Complete network outage resilience with zero unhandled exceptions.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { runMigrations } from "@/test/db.setup";
import * as schema from "@/server/db/schema";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { redis, getRedisClient } from "@/lib/redis";
import { UpstashHttpMockServer } from "./redis-mock-server";

const SECRET = "whsec_redis_live_test_secret";

// Shim next/headers so the route can read stripe-signature from our requests
let __lastRequest: NextRequest | null = null;
vi.mock("next/headers", () => ({
    headers: async () =>
        ({
            get: (name: string) => __lastRequest?.headers.get(name) ?? null,
        }) as never,
}));

// Mock Stripe subscription retrieval to avoid external network calls during route processing
vi.spyOn(stripe.subscriptions, "retrieve").mockImplementation(async (subId: string) => ({
    id: subId,
    items: {
        data: [
            {
                current_period_start: 1700000000,
                current_period_end: 1702592000,
            },
        ],
    },
    latest_invoice: null,
} as unknown as Stripe.Response<Stripe.Subscription>));

process.env.STRIPE_WEBHOOK_SECRET = SECRET;

// Dynamic import of webhook route and cache reset helper
const { POST } = await import("@/app/api/stripe/webhook/route");
const { __resetProcessedEventIds } = await import("@/lib/stripe/webhook-dedupe");

const USERS = {
    healthy: "41414141-4141-4141-4141-414141414141",
    contention: "42424242-4242-4242-4242-424242424242",
    timeout: "43434343-4343-4343-4343-434343434343",
    outage: "45454545-4545-4545-4545-454545454545",
};

const TEST_EVENTS = [
    "evt_redis_healthy_test",
    "evt_redis_contention_test",
    "evt_redis_timeout_test",
    "evt_redis_outage_test",
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

function makeEventBody(type: string, dataObject: Record<string, unknown>, id: string): string {
    return JSON.stringify({ id, type, data: { object: dataObject } });
}

async function seedUser(id: string) {
    await testDb
        .insert(schema.users)
        .values({ id, email: `${id}@live.test`, tier: "free" })
        .onConflictDoNothing();
}

describe("Upstash Redis Live Integration, Lock Contention & Fail-Open Suite (Phase 4)", () => {
    let mockServer: UpstashHttpMockServer;
    let originalRedisUrl: string | undefined;
    let originalRedisToken: string | undefined;

    beforeAll(async () => {
        await runMigrations();

        mockServer = new UpstashHttpMockServer();
        const serverUrl = await mockServer.start();

        originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
        originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

        process.env.UPSTASH_REDIS_REST_URL = serverUrl;
        process.env.UPSTASH_REDIS_REST_TOKEN = "mock-redis-integration-token";

        // Force client cache refresh to bind to mock server
        getRedisClient();

        // Seed initial users
        await Promise.all(Object.values(USERS).map(seedUser));
    });

    afterAll(async () => {
        if (mockServer) {
            await mockServer.stop();
        }

        process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
        process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;

        try {
            await testDb
                .delete(schema.subscriptionEvents)
                .where(inArray(schema.subscriptionEvents.eventId, TEST_EVENTS));
            await testDb
                .delete(schema.subscriptions)
                .where(inArray(schema.subscriptions.userId, Object.values(USERS)));
        } catch {
            // best effort
        }

        await cleanupTestUsers(Object.values(USERS));
    });

    beforeEach(async () => {
        mockServer.clear();
        __resetProcessedEventIds();
    });

    // =========================================================================
    // Step 1: Upstash HTTP REST Emulator Wire Protocol Verification
    // =========================================================================
    describe("1. Upstash HTTP REST Emulator Wire Protocol", () => {
        it("acquires key with NX EX and rejects duplicate NX acquisition", async () => {
            const key = "test:lock:nx_ex_1";
            const setRes1 = await redis.set(key, "locked", { nx: true, ex: 10 });
            expect(setRes1).toBe("OK");

            // Duplicate attempt while key exists must return null
            const setRes2 = await redis.set(key, "collision", { nx: true, ex: 10 });
            expect(setRes2).toBeNull();

            // Value must remain the first value
            const val = await redis.get(key);
            expect(val).toBe("locked");

            // Deletion returns count
            const delRes = await redis.del(key);
            expect(delRes).toBe(1);

            // After deletion, NX can be acquired again
            const setRes3 = await redis.set(key, "reacquired", { nx: true, ex: 10 });
            expect(setRes3).toBe("OK");
        });

        it("handles batch pipelines seamlessly", async () => {
            const p = redis.pipeline();
            p.set("pipe:1", "val1");
            p.set("pipe:2", "val2");
            p.get("pipe:1");
            p.del("pipe:2");
            const results = await p.exec();

            expect(results).toEqual(["OK", "OK", "val1", 1]);
        });
    });

    // =========================================================================
    // Step 3: Redis Healthy Path (Lock acquisition, DB mutation, Dedup cache)
    // =========================================================================
    describe("2. Redis Healthy Path: Lock Lifecycle & Fast-Path Deduplication", () => {
        it("acquires lock, updates tier in DB, sets dedup cache, and frees lock", async () => {
            const eventId = "evt_redis_healthy_test";
            const body = makeEventBody(
                "checkout.session.completed",
                {
                    id: "cs_healthy_1",
                    payment_status: "paid",
                    subscription: "sub_healthy_1",
                    metadata: { userId: USERS.healthy, tier: "pro" },
                    created: 1700000000,
                },
                eventId
            );

            const res = await POST(signedRequest(body));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toMatchObject({ received: true, event: eventId });

            // 1. Verify User Tier upgraded to pro
            const [user] = await testDb
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, USERS.healthy));
            expect(user.tier).toBe("pro");

            // 2. Verify subscription recorded in DB
            const [sub] = await testDb
                .select()
                .from(schema.subscriptions)
                .where(eq(schema.subscriptions.userId, USERS.healthy));
            expect(sub.stripeSubscriptionId).toBe("sub_healthy_1");
            expect(sub.tier).toBe("pro");
            expect(sub.status).toBe("active");

            // 3. Verify event recorded in DB subscription_events
            const [eventRow] = await testDb
                .select()
                .from(schema.subscriptionEvents)
                .where(eq(schema.subscriptionEvents.eventId, eventId));
            expect(eventRow).toBeDefined();
            expect(eventRow.status).toBe("processed");

            // 4. Verify Redis state: lock released, dedup cache written
            const lockExists = mockServer.has(`stripe:lock:${eventId}`);
            expect(lockExists).toBe(false);

            const dedupVal = await redis.get(`stripe:dedup:${eventId}`);
            expect(dedupVal).toBe("processed");

            // 5. Fast-path replay: reset memory L1 cache and replay event
            __resetProcessedEventIds();

            const replayRes = await POST(signedRequest(body));
            expect(replayRes.status).toBe(200);
            const replayData = await replayRes.json();
            expect(replayData).toMatchObject({ received: true, duplicate: true });

            // Ensure DB still has exactly 1 event row
            const eventRows = await testDb
                .select()
                .from(schema.subscriptionEvents)
                .where(eq(schema.subscriptionEvents.eventId, eventId));
            expect(eventRows).toHaveLength(1);
        });
    });

    // =========================================================================
    // Step 4: Lock Contention Path (Simultaneous duplicate deliveries)
    // =========================================================================
    describe("3. Lock Contention Path: Parallel Simultaneous Deliveries", () => {
        it("drops duplicate concurrent delivery with deduplicated: true at Redis layer before DB lock", async () => {
            const eventId = "evt_redis_contention_test";
            const body = makeEventBody(
                "checkout.session.completed",
                {
                    id: "cs_contention_1",
                    payment_status: "paid",
                    subscription: "sub_contention_1",
                    metadata: { userId: USERS.contention, tier: "pro" },
                    created: 1700000000,
                },
                eventId
            );

            // Dispatch two identical requests concurrently
            const [res1, res2] = await Promise.all([
                POST(signedRequest(body)),
                POST(signedRequest(body)),
            ]);

            // One request must process (200), the other must be intercepted by lock contention (503 Retry-After: 5 per Phase 12 LUGX-025/LUGX-148)
            const statuses = [res1.status, res2.status].sort();
            expect(statuses).toEqual([200, 503]);

            const successRes = res1.status === 200 ? res1 : res2;
            const contentionRes = res1.status === 503 ? res1 : res2;

            const successData = await successRes.json();
            const contentionData = await contentionRes.json();

            expect(successData.event).toBe(eventId);
            expect(contentionData.error).toContain("Concurrent event in flight, retry requested");
            expect(contentionRes.headers.get("Retry-After")).toBe("5");

            // Verify User Tier was upgraded
            const [user] = await testDb
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, USERS.contention));
            expect(user.tier).toBe("pro");

            // Verify exactly ONE database entry in subscription_events
            const eventRows = await testDb
                .select()
                .from(schema.subscriptionEvents)
                .where(eq(schema.subscriptionEvents.eventId, eventId));
            expect(eventRows).toHaveLength(1);

            // Verify distributed lock is released after completion
            expect(mockServer.has(`stripe:lock:${eventId}`)).toBe(false);
        });
    });

    // =========================================================================
    // Step 5: Timeout & Fail-Open Path (>1500ms latency degradation)
    // =========================================================================
    describe("4. Timeout & Fail-Open Path: Upstream Redis Latency Degradation", () => {
        it("falls back to PostgreSQL ACID ledger when Redis latency exceeds 1500ms without crashing", async () => {
            const eventId = "evt_redis_timeout_test";
            const body = makeEventBody(
                "checkout.session.completed",
                {
                    id: "cs_timeout_1",
                    payment_status: "paid",
                    subscription: "sub_timeout_1",
                    metadata: { userId: USERS.timeout, tier: "pro" },
                    created: 1700000000,
                },
                eventId
            );

            // Inject 1600ms latency on the mock server (> REDIS_TIMEOUT_MS of 1500ms)
            mockServer.setDelay(1600);

            const startTime = Date.now();
            const res = await POST(signedRequest(body));
            const elapsed = Date.now() - startTime;

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toMatchObject({ received: true, event: eventId });
            expect(elapsed).toBeGreaterThanOrEqual(1400);

            // 1. Verify User Tier upgraded to pro via PostgreSQL fallback
            const [user] = await testDb
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, USERS.timeout));
            expect(user.tier).toBe("pro");

            // 2. Verify event logged in durable subscription_events
            const [eventRow] = await testDb
                .select()
                .from(schema.subscriptionEvents)
                .where(eq(schema.subscriptionEvents.eventId, eventId));
            expect(eventRow).toBeDefined();
            expect(eventRow.status).toBe("processed");

            // 3. Replay with memory cache cleared while Redis is still slow:
            // Redis dedup check times out, falls open to PostgreSQL, which catches the duplicate
            __resetProcessedEventIds();

            const replayRes = await POST(signedRequest(body));
            expect(replayRes.status).toBe(200);
            const replayData = await replayRes.json();
            expect(replayData).toMatchObject({ received: true, duplicate: true });

            // Restore mock server delay
            mockServer.setDelay(0);
        }, 15000); // 15s Vitest test timeout
    });

    // =========================================================================
    // Resilience: Complete Redis Outage / Unreachability
    // =========================================================================
    describe("5. Complete Redis Outage & Unreachability", () => {
        it("handles completely unreachable Redis endpoint by failing open to Postgres", async () => {
            const eventId = "evt_redis_outage_test";
            const body = makeEventBody(
                "checkout.session.completed",
                {
                    id: "cs_outage_1",
                    payment_status: "paid",
                    subscription: "sub_outage_1",
                    metadata: { userId: USERS.outage, tier: "pro" },
                    created: 1700000000,
                },
                eventId
            );

            // Point Redis client to an unreachable port
            process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:59999";
            getRedisClient();

            const res = await POST(signedRequest(body));
            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data).toMatchObject({ received: true, event: eventId });

            // Verify User Tier upgraded
            const [user] = await testDb
                .select()
                .from(schema.users)
                .where(eq(schema.users.id, USERS.outage));
            expect(user.tier).toBe("pro");

            // Restore valid mock server URL
            process.env.UPSTASH_REDIS_REST_URL = mockServer.url;
            getRedisClient();
        });
    });
});
