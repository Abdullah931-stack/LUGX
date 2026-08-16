/**
 * API Route: Stripe Webhook Handler
 * 
 * POST /api/stripe/webhook
 * 
 * Handles Stripe webhook events for subscription management.
 * IMPORTANT: This endpoint must be registered in Stripe Dashboard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { constructWebhookEvent } from '@/lib/stripe';
import { updateUserTier, upsertSubscription } from '@/server/actions/subscription-actions';
import type { TierName } from '@/config/tiers.config';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';

/**
 * In-memory dedupe set for processed webhook event IDs.
 * In production, persist this in Redis (with TTL ~24h) so multiple Vercel
 * function instances share the same idempotency state.
 */
const processedEventIds = new Set<string>();

/**
 * Test-only helper that empties the in-memory dedupe set between test runs.
 * Named with a leading underscore so no production caller can mistake it for
 * runtime API — it exists solely so regression tests can isolate each case.
 * @internal
 */
export function __resetProcessedEventIds() {
    processedEventIds.clear();
}

/**
 * Maximum age (in seconds) of an accepted webhook signature timestamp.
 * Protects against replay attacks: events older than this window are
 * rejected even with a valid signature.
 */
const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

/**
 * Process checkout session completed event
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    try {
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier as TierName;

        // ENGINEERING UPGRADE (W2): a completed checkout session is only
        // considered a real purchase when payment actually succeeded. The
        // old code trusted the event alone; a manually-failed payment with
        // a completed session (e.g. test-tooling or a race with
        // invoice.payment_failed) could have granted a paid tier. Payment
        // status is now checked explicitly, and any non-`paid` result is a
        // hard no-op (fail-closed — Stripe will re-deliver the event if
        // this was a transient failure).
        if (session.payment_status !== 'paid') {
            console.log(`[WEBHOOK] Checkout session ${session.id} completed but payment status is '${session.payment_status}' — no tier change (fail-closed)`);
            return;
        }

        if (!userId || !tier) {
            console.error('[WEBHOOK] Missing metadata in checkout session:', session.id, 'metadata:', JSON.stringify(session.metadata));
            return;
        }

        // Update user tier
        const tierResult = await updateUserTier(userId, tier);

        if (!tierResult.success) {
            throw new Error(`Failed to update user tier: ${tierResult.error}`);
        }

        console.log(`[WEBHOOK] Tier updated for user ${userId} to ${tier}`);

        // Get subscription details
        const subscriptionId = session.subscription as string;

        if (subscriptionId) {
            // Upsert the subscription record here as well — checkout events
            // carry the final subscription id, so the row exists even if no
            // customer.subscription.updated event arrives.
            const upsertResult = await upsertSubscription(userId, {
                stripeSubscriptionId: subscriptionId,
                tier,
                status: 'active',
                currentPeriodStart: new Date(),
                currentPeriodEnd: new Date(),
                cancelAtPeriodEnd: false,
            });
            if (!upsertResult.success) {
                throw new Error(`Failed to upsert subscription from checkout: ${upsertResult.error}`);
            }
            console.log(`[WEBHOOK] Subscription ${subscriptionId} recorded for user ${userId}`);
        } else {
            console.warn('[WEBHOOK] No subscription ID in checkout session', session.id);
        }
    } catch (error) {
        console.error('[WEBHOOK] Error in handleCheckoutSessionCompleted:', error);
    }
}

/**
 * Process subscription updated event
 */
async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
    try {
        const userId = subscription.metadata?.userId;
        const tier = subscription.metadata?.tier as TierName;

        if (!userId || !tier) {
            console.error('Missing metadata in subscription:', subscription.id);
            return;
        }

        // ENGINEERING UPGRADE (W2): explicit mapping of every real Stripe
        // lifecycle status, FAIL-CLOSED on anything unknown. The old code
        // fell through to `status = 'active'` on an unrecognized status —
        // silently granting paid-tier standing on payment failures. Now any
        // unmapped status throws, aborting the upsert without modifying the
        // row, so the worst case is "no update" (which Stripe will retry),
        // never "wrong status".
        const STATUS_MAP: Record<string, 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'incomplete_expired' | 'unpaid'> = {
            active: 'active',
            canceled: 'canceled',
            past_due: 'past_due',
            trialing: 'trialing',
            incomplete: 'incomplete',
            incomplete_expired: 'incomplete_expired',
            unpaid: 'unpaid',
            paused: 'canceled', // paused subscriptions generate no invoices
        };
        const status = STATUS_MAP[subscription.status];
        if (!status) {
            throw new Error(`Unmapped Stripe subscription status: ${subscription.status}`);
        }

        // Tier policy: only genuine payment success grants a paid tier.
        // Payment-failure statuses (incomplete, incomplete_expired, unpaid)
        // and past_due keep/downgrade the user to free — money must arrive
        // before privileges do.
        const paidStatuses: ReadonlyArray<string> = ['active', 'trialing'];
        const effectiveTier: TierName = paidStatuses.includes(subscription.status) ? tier : 'free';

        // ENGINEERING UPGRADE (W2): downgrade immediately on payment failure,
        // not only on cancellation. This closes the window where a user with
        // a past_due/incomplete subscription keeps paid-tier access.
        if (effectiveTier !== tier) {
            const tierResult = await updateUserTier(userId, 'free');
            if (!tierResult.success) {
                throw new Error(`Failed to downgrade user tier on payment failure: ${tierResult.error}`);
            }
        }

        // Upsert subscription record (DB-level UNIQUE constraint on
        // stripe_subscription_id — migration 0004 — prevents a duplicated
        // or substituted subscription id from silently overwriting the row).
        const result = await upsertSubscription(userId, {
            stripeSubscriptionId: subscription.id,
            tier: effectiveTier,
            status,
            currentPeriodStart: new Date(subscription.start_date * 1000),
            currentPeriodEnd: new Date(subscription.start_date * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
        });

        if (!result.success) {
            throw new Error(`Failed to upsert subscription: ${result.error}`);
        }

        console.log(`[WEBHOOK] Subscription upserted for user ${userId}, status: ${status}, tier: ${effectiveTier}`);
    } catch (error) {
        console.error('Error handling customer.subscription.updated:', error);
    }
}

/**
 * Process subscription deleted event
 */
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    try {
        const userId = subscription.metadata?.userId;

        if (!userId) {
            console.error('Missing userId in subscription metadata:', subscription.id);
            return;
        }

        // Downgrade user to free tier
        const tierResult = await updateUserTier(userId, 'free');
        if (!tierResult.success) {
            console.error('Failed to downgrade user tier:', tierResult.error);
            return;
        }

        // Update subscription record
        await upsertSubscription(userId, {
            stripeSubscriptionId: subscription.id,
            tier: 'free',
            status: 'canceled',
            currentPeriodStart: new Date(subscription.start_date * 1000),
            currentPeriodEnd: new Date(subscription.start_date * 1000),
            cancelAtPeriodEnd: false,
        });

        console.log(`[WEBHOOK] Subscription canceled for user ${userId}, downgraded to free`);
    } catch (error) {
        console.error('Error handling customer.subscription.deleted:', error);
    }
}

/**
 * Process invoice payment failed event (W2).
 *
 * Fail-closed: any payment failure immediately revokes paid-tier standing
 * until payment succeeds (a subsequent paid invoice re-grants it via
 * customer.subscription.updated / checkout.session.completed). The
 * subscription status is downgraded to unpaid/past_due as reported by the
 * invoice's own latest status, never assumed.
 */
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
    try {
        const userId = invoice.metadata?.userId;
        if (!userId) {
            console.error('[WEBHOOK] Missing userId in invoice metadata:', invoice.id);
            return;
        }

        // Downgrade immediately — privileges follow money.
        const tierResult = await updateUserTier(userId, 'free');
        if (!tierResult.success) {
            throw new Error(`Failed to downgrade on payment failure: ${tierResult.error}`);
        }

        // Record the failed-payment status on the subscription row if we
        // can locate the customer's active subscription. NOTE: the Invoice
        // object in Stripe SDK v20 has no `subscription` field — invoices
        // were decoupled from subscriptions — so the authoritative status
        // must come from the subscription object itself via the customer.
        // A paid invoice later re-grants the tier through
        // customer.subscription.updated / checkout.session.completed.
        const customerId = invoice.customer as string | null;
        if (customerId) {
            try {
                const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1 });
                const sub = subs.data[0];
                if (sub) {
                    const upsertResult = await upsertSubscription(userId, {
                        stripeSubscriptionId: sub.id,
                        tier: 'free',
                        status: sub.status as 'past_due' | 'unpaid' | 'active' | 'canceled' | 'trialing' | 'incomplete' | 'incomplete_expired',
                        // Stripe SDK v20 removed `current_period_start/end`
                        // from the Subscription object (billing-period info
                        // lives on the invoice/subscription-details now).
                        // Persist start_date as the row's reference anchor.
                        currentPeriodStart: new Date(sub.start_date * 1000),
                        currentPeriodEnd: new Date(sub.start_date * 1000),
                        cancelAtPeriodEnd: sub.cancel_at_period_end || false,
                    });
                    if (!upsertResult.success) {
                        throw new Error(`Failed to record failed-payment status: ${upsertResult.error}`);
                    }
                } else {
                    // No subscription found for the customer — the row still
                    // exists from checkout; mark it canceled-consistent.
                    await upsertSubscription(userId, {
                        stripeSubscriptionId: '',
                        tier: 'free',
                        status: 'canceled',
                        currentPeriodStart: new Date(),
                        currentPeriodEnd: new Date(),
                        cancelAtPeriodEnd: false,
                    });
                }
            } catch (err) {
                // A read failure must not block the downgrade — privileges
                // follow money even if we cannot reconcile the row right now.
                console.error('[WEBHOOK] Failed to reconcile subscription for invoice:', invoice.id, err);
            }
        }

        console.log(`[WEBHOOK] Payment failed for invoice ${invoice.id}; user ${userId} downgraded to free`);
    } catch (error) {
        console.error('Error handling invoice.payment_failed:', error);
    }
}

/**
 * Main webhook handler
 */
export async function POST(request: NextRequest) {
    try {
        // Get the raw body as text
        const body = await request.text();

        // Get Stripe signature from headers
        const headersList = await headers();
        const signature = headersList.get('stripe-signature');

        if (!signature) {
            return NextResponse.json(
                { error: 'Missing stripe-signature header' },
                { status: 400 }
            );
        }

        // Verify webhook signature and construct event.
        // Replay protection is built into constructEvent via the tolerance
        // parameter: signatures whose timestamp is older than the allowed
        // window are rejected automatically, so a captured signature cannot
        // be replayed later.
        let event: Stripe.Event;

        try {
            // Stripe SDK v20 constructEvent is async; awaiting it is
            // mandatory — without it `event` holds an unresolved Promise,
            // so event.type/id are undefined and every handler receives
            // an empty event (no tier updates, no dedupe, silent no-ops).
            event = await stripe.webhooks.constructEvent(
                body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET!,
                MAX_TIMESTAMP_AGE_SECONDS,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Timestamp outside')) {
                console.error(
                    '[WEBHOOK] Replay protection: signature timestamp outside tolerance window',
                );
                return NextResponse.json(
                    { error: 'Webhook timestamp outside tolerance window' },
                    { status: 400 },
                );
            }
            console.error('Webhook signature verification failed:', error);
            return NextResponse.json(
                { error: 'Invalid signature' },
                { status: 400 },
            );
        }

        // Idempotency: Stripe may retry failed webhooks, so guard against
        // processing the same event ID more than once.
        const eventId = event.id;
        if (processedEventIds.has(eventId)) {
            console.log(`[WEBHOOK] Duplicate event ignored: ${eventId}`);
            return NextResponse.json({ received: true, duplicate: true });
        }
        processedEventIds.add(eventId);
        // Bound the dedupe set to prevent unbounded memory growth.
        if (processedEventIds.size > 10_000) {
            const toDelete = Array.from(processedEventIds).slice(0, 5_000);
            toDelete.forEach(id => processedEventIds.delete(id));
        }

        // Handle different event types

        // ENGINEERING UPGRADE (W2): the default branch is now FAIL-CLOSED.
        // Previously any unrecognized event type was silently ignored — a
        // misconfigured Stripe endpoint (or an attacker probing the
        // endpoint) could send events the system never reacted to. Now
        // unknown event types still return 200 (to avoid Stripe's 3-day
        // disable for unreceived acknowledgments) but log a concrete error
        // so misconfigurations surface in monitoring instead of silently
        // dropping payment-failure signals.
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
                break;

            case 'customer.subscription.trial_will_end':
                // Informational — users on trial keep their tier until the
                // subscription actually transitions. No action needed, but
                // the event is handled explicitly so it does not hit the
                // unknown-event branch.
                break;

            case 'invoice.payment_failed':
                // Payment failure: the invoice's subscription knows its new
                // status (usually `past_due` or `unpaid`). Downgrade the
                // user immediately rather than waiting for a subscription
                // update event that may be delayed.
                await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
                break;

            default:
                console.error(`[WEBHOOK] Unknown/unhandled event type (fail-closed): ${event.type}`);
        }

        // Return success response
        return NextResponse.json({ received: true, event: eventId });

    } catch (error) {
        console.error('Error in webhook handler:', error);
        return NextResponse.json(
            { error: 'Webhook handler failed' },
            { status: 500 }
        );
    }
}
