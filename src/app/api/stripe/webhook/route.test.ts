/**
 * Regression tests for ENGINEERING UPGRADE W2 (Stripe webhook hardening).
 *
 * Verifies, against mocked Stripe SDK and mocked server actions:
 * 1. An unmapped subscription status throws and does NOT mutate the row
 *    (fail-closed — no silent fallthrough to 'active').
 * 2. checkout.session.completed with payment_status !== 'paid' grants no tier.
 * 3. invoice.payment_failed downgrades the user to free even when the
 *    subscription cannot be reconciled.
 * 4. Duplicate event IDs are deduplicated on second delivery.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Stripe as StripeTypes } from "stripe";

// next/headers() requires the Next.js request store, which does not exist in
// jsdom. Stub it with a function that reads the stripe-signature header
// from the request's own headers object via a lightweight shim.
vi.mock("next/headers", () => ({
    headers: async () => {
        // Return a proxy that resolves against the mocked request. The route
        // reads `stripe-signature` right after `request.text()`, and vitest
        // runs tests serially so capturing the LAST created NextRequest is safe.
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

// Hoisted-safe mocks: each vi.mock factory returns the spies inline so that
// the tests can reach the SAME functions by re-importing the mocked modules
// with `vi.mocked`. Factories must not reference top-level variables other
// than vi.fn() calls, so we return everything directly.
vi.mock("@/lib/stripe", () => ({
    constructWebhookEvent: vi.fn(),
    stripe: {
        webhooks: {
            constructEvent: vi.fn(),
        },
        subscriptions: {
            list: vi.fn(async () => ({ data: [], has_more: false })),
            retrieve: vi.fn(),
        },
    },
}));

vi.mock("@/server/actions/subscription-actions", () => ({
    updateUserTier: vi.fn(async () => ({ success: true })),
    upsertSubscription: vi.fn(async () => ({ success: true })),
}));

import { POST, __resetProcessedEventIds } from "./route";
import Stripe from "stripe";
import * as stripeLib from "@/lib/stripe";
import * as subActions from "@/server/actions/subscription-actions";

const SECRET = "whsec_test";
type AnyFn = ReturnType<typeof vi.fn>;
// Re-imported references point at the SAME functions returned by the factories
// above (module singletons), so configuring them here reaches the runtime.
const mockConstruct = vi.mocked(stripeLib.stripe.webhooks.constructEvent) as AnyFn;
const mockUpdateTier = vi.mocked(subActions.updateUserTier) as AnyFn;
const mockUpsert = vi.mocked(subActions.upsertSubscription) as AnyFn;
const mockSubList = vi.mocked(stripeLib.stripe.subscriptions.list) as AnyFn;

/**
 * Build a fake Stripe.Event of the requested type. The route module types its
 * parameter as Stripe.Event, but the handler only reads event.type and
 * event.data.object and the metadata fields, so a structural stub is enough.
 */
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
    // Default behaviour: constructEvent echoes a stub event whose payload is
    // carried in the JSON body we post (body is expected to look like
    // {"type":..., "data":...}).
    mockConstruct.mockImplementation((_body: string, _sig: string, _secret: string) => {
        return Promise.resolve(makeEvent("unknown", {}));
    });
    mockUpdateTier.mockResolvedValue({ success: true } as never);
    mockUpsert.mockResolvedValue({ success: true } as never);
    mockSubList.mockResolvedValue({ data: [], has_more: false } as never);
});

function stubEvent(event: Stripe.Event) {
    mockConstruct.mockImplementation(
        (_body: string | Buffer | Uint8Array) => Promise.resolve(event)
    );
}

describe("W2 webhook hardening", () => {
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

        // The handler catches the throw internally but must NOT have called
        // updateUserTier/upsertSubscription with a wrong tier for that user.
        const calls = mockUpdateTier.mock.calls.filter(c => c[0] === "user-1");
        expect(calls.length).toBe(0);
        const upsertCalls = mockUpsert.mock.calls.filter(c => c[0] === "user-1");
        expect(upsertCalls.length).toBe(0);
        // Still returns 200-ish JSON (Stripe will retry).
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

        const tierCalls = mockUpdateTier.mock.calls.filter(c => c[0] === "user-2");
        expect(tierCalls.length).toBe(0);
        const upsertCalls = mockUpsert.mock.calls.filter(c => c[0] === "user-2");
        expect(upsertCalls.length).toBe(0);
        expect(resp.status).toBeLessThan(500);
    });

    it("invoice.payment_failed downgrades to free even when subscription cannot be reconciled", async () => {
        mockSubList.mockRejectedValueOnce(new Error("stripe api down"));

        stubEvent(
            makeEvent("invoice.payment_failed", {
                id: "in_x",
                customer: "cus_x",
                metadata: { userId: "user-3" },
            })
        );

        const resp = await POST(makeRequest());

        // Privileges follow money: downgrade MUST happen regardless of the
        // reconciliation failure.
        expect(mockUpdateTier).toHaveBeenCalledWith("user-3", "free");
        expect(resp.status).toBeLessThan(500);
    });

    it("duplicate event id is processed only once", async () => {
        stubEvent(
            makeEvent("customer.subscription.deleted", {
                id: "sub_y",
                metadata: { userId: "user-4" },
                status: "canceled",
                cancel_at_period_end: false,
                start_date: Math.floor(Date.now() / 1000),
            })
        );

        const resp1 = await POST(makeRequest());
        const resp2 = await POST(makeRequest());

        const calls = mockUpdateTier.mock.calls.filter(c => c[0] === "user-4");
        expect(calls.length).toBe(1);
        // Duplicate response explicitly flags the skip.
        const dup = await resp2.json();
        expect(dup).toMatchObject({ received: true, duplicate: true });
    });

    it("unknown event type logs fail-closed and still returns success", async () => {
        stubEvent(makeEvent("charge.refunded", { id: "ch_x" }));
        const resp = await POST(makeRequest());
        expect(resp.status).toBeLessThan(500);
        const payload = await resp.json();
        expect(payload).toMatchObject({ received: true });
    });
});
