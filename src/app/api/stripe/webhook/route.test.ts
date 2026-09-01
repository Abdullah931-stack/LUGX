/**
 * Regression tests for Stripe Webhook Handler (Phase 13 & W2).
 *
 * Verifies, against mocked Stripe SDK and mocked server actions:
 * 1. An unmapped subscription status throws and does NOT mutate the row (fail-closed).
 * 2. checkout.session.completed with payment_status !== 'paid' grants no tier.
 * 3. invoice.payment_failed downgrades the user to free even when subscription cannot be reconciled.
 * 4. In-memory fast-path deduplication on immediate re-delivery.
 * 5. Durable database deduplication after server restart (__resetProcessedEventIds).
 * 6. Correct subscription period calculation across all event types (currentPeriodStart < currentPeriodEnd, never equal).
 * 7. Terminal State Protection: canceled subscription ignores stale customer.subscription.updated active events.
 * 8. Unknown event types are safely recorded and acknowledged without failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// next/headers() shim
vi.mock("next/headers", () => ({
    headers: async () => {
        return new Proxy(
            { get: () => "sig_test" },
            {
                get(_target, prop) {
                    const req = __lastRequest;
                    if (prop === "get" && req) {
                        return (name: string) => req.headers.get(name);
                    }
                    return undefined;
                },
            }
        ) as never;
    },
}));

vi.mock("@/lib/stripe", () => ({
    constructWebhookEvent: vi.fn(),
    stripe: {
        webhooks: {
            constructEvent: vi.fn(),
        },
        subscriptions: {
            list: vi.fn(async () => ({ data: [], has_more: false })),
            retrieve: vi.fn(async () => ({
                id: "sub_mock_retrieved",
                items: {
                    data: [
                        {
                            current_period_start: 1700000000,
                            current_period_end: 1702592000,
                        },
                    ],
                },
            })),
        },
    },
}));

vi.mock("@/server/actions/subscription-actions", () => ({
    updateUserTier: vi.fn(async () => ({ success: true })),
    upsertSubscription: vi.fn(async () => ({ success: true })),
    getUserSubscription: vi.fn(async () => null),
    isSubscriptionEventProcessed: vi.fn(async () => false),
    recordSubscriptionEvent: vi.fn(async () => ({ success: true })),
    executeSubscriptionTransition: vi.fn(async (op: any) => op({})),
}));

import { POST } from "./route";
import { __resetProcessedEventIds } from "@/lib/stripe/webhook-dedupe";
import Stripe from "stripe";
import * as stripeLib from "@/lib/stripe";
import * as subActions from "@/server/actions/subscription-actions";

type AnyFn = ReturnType<typeof vi.fn>;
const mockConstruct = vi.mocked(stripeLib.stripe.webhooks.constructEvent) as AnyFn;
const mockUpdateTier = vi.mocked(subActions.updateUserTier) as AnyFn;
const mockUpsert = vi.mocked(subActions.upsertSubscription) as AnyFn;
const mockGetSub = vi.mocked(subActions.getUserSubscription) as AnyFn;
const mockSubList = vi.mocked(stripeLib.stripe.subscriptions.list) as AnyFn;
const mockSubRetrieve = vi.mocked(stripeLib.stripe.subscriptions.retrieve) as AnyFn;
const mockIsProcessed = vi.mocked(subActions.isSubscriptionEventProcessed) as AnyFn;
const mockRecordEvent = vi.mocked(subActions.recordSubscriptionEvent) as AnyFn;

function makeEvent(
    type: string,
    dataObject: Record<string, unknown>,
    id = "evt_test_123"
): Stripe.Event {
    return {
        id,
        type,
        data: { object: dataObject },
    } as unknown as Stripe.Event;
}

function makeRequest(body = "{}", signature = "sig_test") {
    const req = new NextRequest("http://localhost:3000/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": signature },
        body,
    });
    __lastRequest = req;
    return req;
}

let __lastRequest: NextRequest | null = null;

beforeEach(() => {
    vi.clearAllMocks();
    __resetProcessedEventIds();
    mockConstruct.mockImplementation((_body: string, _sig: string, _secret: string) => {
        return Promise.resolve(makeEvent("unknown", {}));
    });
    mockUpdateTier.mockResolvedValue({ success: true } as never);
    mockUpsert.mockResolvedValue({ success: true } as never);
    mockGetSub.mockResolvedValue(null as never);
    mockSubList.mockResolvedValue({ data: [], has_more: false } as never);
    mockSubRetrieve.mockResolvedValue({
        id: "sub_mock_retrieved",
        items: {
            data: [
                {
                    current_period_start: 1700000000,
                    current_period_end: 1702592000,
                },
            ],
        },
    } as never);
    mockIsProcessed.mockResolvedValue(false as never);
    mockRecordEvent.mockResolvedValue({ success: true } as never);
});

function stubEvent(event: Stripe.Event) {
    mockConstruct.mockImplementation(
        (_body: string | Buffer | Uint8Array) => Promise.resolve(event)
    );
}

describe("Phase 13: Stripe webhook hardening & durable idempotency", () => {
    it("unmapped subscription status is fail-closed: throws, updates nothing", async () => {
        stubEvent(
            makeEvent("customer.subscription.updated", {
                id: "sub_x",
                metadata: { userId: "user-1", tier: "pro" },
                status: "some_future_stripe_status",
                cancel_at_period_end: false,
                start_date: Math.floor(Date.now() / 1000),
            })
        );

        const resp = await POST(makeRequest());

        const calls = mockUpdateTier.mock.calls.filter((c) => c[0] === "user-1");
        expect(calls.length).toBe(0);
        const upsertCalls = mockUpsert.mock.calls.filter((c) => c[0] === "user-1");
        expect(upsertCalls.length).toBe(0);
        expect(resp.status).toBeLessThan(500);
    });

    it("checkout.session.completed with unpaid payment grants no tier (fail-closed)", async () => {
        stubEvent(
            makeEvent("checkout.session.completed", {
                id: "cs_x",
                metadata: { userId: "user-2", tier: "ultra" },
                payment_status: "unpaid",
                subscription: "sub_x",
            })
        );

        const resp = await POST(makeRequest());

        const tierCalls = mockUpdateTier.mock.calls.filter((c) => c[0] === "user-2");
        expect(tierCalls.length).toBe(0);
        const upsertCalls = mockUpsert.mock.calls.filter((c) => c[0] === "user-2");
        expect(upsertCalls.length).toBe(0);
        expect(resp.status).toBeLessThan(500);
    });

    it("invoice.payment_failed downgrades to free and reconciles from local DB", async () => {
        mockGetSub.mockResolvedValueOnce({
            id: "sub_db_id",
            userId: "user-3",
            stripeSubscriptionId: "sub_existing_123",
            tier: "pro",
            status: "active",
            currentPeriodStart: new Date(1700000000 * 1000),
            currentPeriodEnd: new Date(1702592000 * 1000),
            cancelAtPeriodEnd: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as never);

        stubEvent(
            makeEvent("invoice.payment_failed", {
                id: "in_x",
                customer: "cus_x",
                metadata: { userId: "user-3" },
                created: 1700000000,
            })
        );

        const resp = await POST(makeRequest());

        expect(mockUpdateTier).toHaveBeenCalledWith("user-3", "free", expect.anything());
        expect(mockUpsert).toHaveBeenCalledWith(
            "user-3",
            expect.objectContaining({
                stripeSubscriptionId: "sub_existing_123",
                status: "past_due",
                tier: "free",
            }),
            expect.anything()
        );
        expect(resp.status).toBeLessThan(500);
    });

    it("in-memory fast-path deduplicates rapid sequential delivery", async () => {
        stubEvent(
            makeEvent(
                "customer.subscription.deleted",
                {
                    id: "sub_y",
                    metadata: { userId: "user-4" },
                    status: "canceled",
                    cancel_at_period_end: false,
                    start_date: 1700000000,
                },
                "evt_in_mem_dup"
            )
        );

        await POST(makeRequest());
        const resp2 = await POST(makeRequest());

        const calls = mockUpdateTier.mock.calls.filter((c) => c[0] === "user-4");
        expect(calls.length).toBe(1);
        const dup = await resp2.json();
        expect(dup).toMatchObject({ received: true, duplicate: true });
    });

    it("durable DB ledger deduplicates event after server restart (__resetProcessedEventIds)", async () => {
        stubEvent(
            makeEvent(
                "customer.subscription.deleted",
                {
                    id: "sub_restart",
                    metadata: { userId: "user-restart" },
                    status: "canceled",
                    cancel_at_period_end: false,
                    start_date: 1700000000,
                },
                "evt_restart_123"
            )
        );

        // First delivery: processes and records event
        const resp1 = await POST(makeRequest());
        expect(resp1.status).toBe(200);
        expect(mockUpdateTier).toHaveBeenCalledWith("user-restart", "free", expect.anything());
        expect(mockRecordEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: "evt_restart_123",
                eventType: "customer.subscription.deleted",
            }),
            expect.anything()
        );

        // Simulate complete server restart / new worker instance (in-memory cache cleared)
        __resetProcessedEventIds();

        // Database now has the event recorded
        mockIsProcessed.mockResolvedValueOnce(true as never);

        // Second delivery after restart
        const resp2 = await POST(makeRequest());
        expect(resp2.status).toBe(200);
        const body = await resp2.json();
        expect(body).toMatchObject({ received: true, duplicate: true });

        // Ensure NO second mutation was invoked
        const calls = mockUpdateTier.mock.calls.filter((c) => c[0] === "user-restart");
        expect(calls.length).toBe(1);
    });

    it("terminal state protection: ignores stale customer.subscription.updated on canceled subscription", async () => {
        mockGetSub.mockResolvedValueOnce({
            id: "sub_db_id",
            userId: "user-stale",
            stripeSubscriptionId: "sub_stale_123",
            tier: "free",
            status: "canceled",
            currentPeriodStart: new Date(1700000000 * 1000),
            currentPeriodEnd: new Date(1702592000 * 1000),
            cancelAtPeriodEnd: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as never);

        stubEvent(
            makeEvent(
                "customer.subscription.updated",
                {
                    id: "sub_stale_123",
                    metadata: { userId: "user-stale", tier: "pro" },
                    status: "active",
                    cancel_at_period_end: false,
                    start_date: 1700000000,
                },
                "evt_stale_update"
            )
        );

        const resp = await POST(makeRequest());
        expect(resp.status).toBe(200);

        // Verify NO tier upgrade occurred
        const tierCalls = mockUpdateTier.mock.calls.filter((c) => c[0] === "user-stale");
        expect(tierCalls.length).toBe(0);

        // Verify recorded as ignored_stale
        expect(mockRecordEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: "evt_stale_update",
                status: "ignored_stale",
            }),
            expect.anything()
        );
    });

    it("calculates distinct period boundaries for checkout.session.completed (end > start)", async () => {
        mockSubRetrieve.mockResolvedValueOnce({
            id: "sub_checkout_period",
            items: {
                data: [
                    {
                        current_period_start: 1700000000,
                        current_period_end: 1702592000,
                    },
                ],
            },
        } as never);

        stubEvent(
            makeEvent(
                "checkout.session.completed",
                {
                    id: "cs_period",
                    metadata: { userId: "user-period-cs", tier: "pro" },
                    payment_status: "paid",
                    subscription: "sub_checkout_period",
                    created: 1700000000,
                },
                "evt_cs_period"
            )
        );

        const resp = await POST(makeRequest());
        expect(resp.status).toBe(200);

        expect(mockUpsert).toHaveBeenCalledWith(
            "user-period-cs",
            expect.objectContaining({
                stripeSubscriptionId: "sub_checkout_period",
                tier: "pro",
                status: "active",
                currentPeriodStart: new Date(1700000000 * 1000),
                currentPeriodEnd: new Date(1702592000 * 1000),
            }),
            expect.anything()
        );

        const upsertArgs = mockUpsert.mock.calls.find((c) => c[0] === "user-period-cs")?.[1];
        expect(upsertArgs.currentPeriodStart.getTime()).not.toBe(
            upsertArgs.currentPeriodEnd.getTime()
        );
        expect(upsertArgs.currentPeriodEnd.getTime()).toBeGreaterThan(
            upsertArgs.currentPeriodStart.getTime()
        );
    });

    it("calculates distinct period boundaries for customer.subscription.updated (end > start)", async () => {
        stubEvent(
            makeEvent(
                "customer.subscription.updated",
                {
                    id: "sub_updated_period",
                    metadata: { userId: "user-sub-updated", tier: "ultra" },
                    status: "active",
                    cancel_at_period_end: false,
                    start_date: 1700000000,
                    items: {
                        data: [
                            {
                                current_period_start: 1700000000,
                                current_period_end: 1702592000,
                            },
                        ],
                    },
                },
                "evt_sub_updated_period"
            )
        );

        const resp = await POST(makeRequest());
        expect(resp.status).toBe(200);

        expect(mockUpsert).toHaveBeenCalledWith(
            "user-sub-updated",
            expect.objectContaining({
                stripeSubscriptionId: "sub_updated_period",
                tier: "ultra",
                status: "active",
                currentPeriodStart: new Date(1700000000 * 1000),
                currentPeriodEnd: new Date(1702592000 * 1000),
            }),
            expect.anything()
        );

        const upsertArgs = mockUpsert.mock.calls.find((c) => c[0] === "user-sub-updated")?.[1];
        expect(upsertArgs.currentPeriodStart.getTime()).not.toBe(
            upsertArgs.currentPeriodEnd.getTime()
        );
        expect(upsertArgs.currentPeriodEnd.getTime()).toBeGreaterThan(
            upsertArgs.currentPeriodStart.getTime()
        );
    });

    it("unknown event type logs fail-closed, persists event, and returns success", async () => {
        stubEvent(makeEvent("charge.refunded", { id: "ch_x" }, "evt_unknown_999"));
        const resp = await POST(makeRequest());
        expect(resp.status).toBeLessThan(500);
        const payload = await resp.json();
        expect(payload).toMatchObject({ received: true, event: "evt_unknown_999" });
        expect(mockRecordEvent).toHaveBeenCalledWith({
            eventId: "evt_unknown_999",
            eventType: "charge.refunded",
            status: "unhandled",
        });
    });
});
