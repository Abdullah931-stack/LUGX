/**
 * API Route: Stripe Webhook Handler (Canonical Handler)
 * 
 * POST /api/stripe/webhook
 * 
 * Handles Stripe webhook events for subscription lifecycle management.
 * 
 * ARCHITECTURAL INVARIANTS (Phase 13):
 * 1. Canonical Handler: /api/stripe/webhook is the authoritative handler;
 *    /api/webhooks/stripe is a transparent re-export alias with zero parallel logic.
 * 2. Durable Idempotency: Webhook deduplication is enforced by the database
 *    (`subscription_events` table). In-memory `processedEventIds` serves as a fast-path cache.
 *    Replays after server restart or across distributed workers are safely deduplicated.
 * 3. Atomic ACID Transitions: User tier update, subscription upsert, and durable event
 *    ledger recording execute within a single atomic database transaction (`executeSubscriptionTransition`).
 * 4. Terminal State Protection: Subscriptions in terminal `canceled` state ignore stale
 *    out-of-order `customer.subscription.updated` events without requiring fragile clock math.
 * 5. Correct Period Calculation: Subscription billing periods (`currentPeriodStart` and
 *    `currentPeriodEnd`) are extracted from `SubscriptionItem` (`current_period_start/end`)
 *    or the associated `Invoice` line items (`period.start/end`). Duplicating `start_date`
 *    into both start and end fields is strictly prevented (`end > start` guaranteed).
 * 6. Zero-Allocation Cache Eviction: In-memory set eviction is performed via direct Set iteration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import {
    updateUserTier,
    upsertSubscription,
    getUserSubscription,
    isSubscriptionEventProcessed,
    recordSubscriptionEvent,
    executeSubscriptionTransition,
} from '@/server/actions/subscription-actions';
import type { TierName } from '@/config/tiers.config';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';

/**
 * In-memory fast-path dedupe set for processed webhook event IDs.
 * Note: Database `subscription_events` table is the authoritative durable ledger.
 */
const processedEventIds = new Set<string>();

/**
 * Test-only helper that empties the in-memory dedupe set between test runs.
 * Named with a leading underscore so no production caller can mistake it for
 * runtime API — it exists solely so regression tests can simulate server restarts.
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

export interface HandlerResult {
    success: boolean;
    userId?: string;
    subscriptionId?: string;
    error?: string;
}

/**
 * Extracts and normalizes billing period dates for subscriptions.
 * In Stripe SDK v20, period dates are anchored on SubscriptionItem (item.current_period_start/end)
 * or the associated Invoice (invoice.lines.data[0].period).
 *
 * Guarantees:
 * 1. currentPeriodStart !== currentPeriodEnd
 * 2. currentPeriodEnd > currentPeriodStart
 */
function extractPeriod(options: {
    itemStart?: number | null;
    itemEnd?: number | null;
    invoicePeriod?: { start?: number | null; end?: number | null } | null;
    fallbackAnchorSeconds?: number | null;
}): { currentPeriodStart: Date; currentPeriodEnd: Date } {
    let startMs: number | null = null;
    let endMs: number | null = null;

    if (
        typeof options.itemStart === 'number' &&
        typeof options.itemEnd === 'number' &&
        options.itemEnd > options.itemStart
    ) {
        startMs = options.itemStart * 1000;
        endMs = options.itemEnd * 1000;
    } else if (
        typeof options.invoicePeriod?.start === 'number' &&
        typeof options.invoicePeriod?.end === 'number' &&
        options.invoicePeriod.end > options.invoicePeriod.start
    ) {
        startMs = options.invoicePeriod.start * 1000;
        endMs = options.invoicePeriod.end * 1000;
    }

    if (startMs === null || endMs === null) {
        const anchor = options.fallbackAnchorSeconds
            ? options.fallbackAnchorSeconds * 1000
            : Date.now();
        startMs = anchor;
        // Default 30-day billing cycle if period boundaries are absent from payload
        endMs = anchor + 30 * 24 * 60 * 60 * 1000;
    }

    // Invariant check: end date must strictly exceed start date
    if (endMs <= startMs) {
        endMs = startMs + 30 * 24 * 60 * 60 * 1000;
    }

    return {
        currentPeriodStart: new Date(startMs),
        currentPeriodEnd: new Date(endMs),
    };
}

/**
 * Process checkout session completed event atomically
 */
async function handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session,
    eventId: string
): Promise<HandlerResult> {
    try {
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier as TierName;
        const subscriptionId = session.subscription as string | undefined;

        // Fail-closed check: completed checkout session must have payment_status === 'paid'
        if (session.payment_status !== 'paid') {
            console.log(
                `[WEBHOOK] Checkout session ${session.id} completed but payment status is '${session.payment_status}' — no tier change (fail-closed)`
            );
            return { success: true, userId, subscriptionId };
        }

        if (!userId || !tier) {
            console.error(
                '[WEBHOOK] Missing metadata in checkout session:',
                session.id,
                'metadata:',
                JSON.stringify(session.metadata)
            );
            return { success: false, error: 'Missing metadata' };
        }

        let itemStart: number | undefined;
        let itemEnd: number | undefined;
        let invoicePeriod: { start?: number; end?: number } | undefined;

        if (subscriptionId) {
            try {
                const sub = await stripe.subscriptions.retrieve(subscriptionId, {
                    expand: ['latest_invoice'],
                });
                const firstItem = sub.items?.data?.[0];
                itemStart = firstItem?.current_period_start;
                itemEnd = firstItem?.current_period_end;
                if (sub.latest_invoice && typeof sub.latest_invoice === 'object') {
                    invoicePeriod = (sub.latest_invoice as Stripe.Invoice).lines?.data?.[0]?.period;
                }
            } catch (err) {
                console.warn(
                    '[WEBHOOK] Could not expand subscription details for checkout session',
                    session.id,
                    err
                );
            }
        }

        const { currentPeriodStart, currentPeriodEnd } = extractPeriod({
            itemStart,
            itemEnd,
            invoicePeriod,
            fallbackAnchorSeconds: session.created,
        });

        // Atomic Transaction: User Tier + Subscription Upsert + Durable Event
        return await executeSubscriptionTransition(async (tx) => {
            const tierResult = await updateUserTier(userId, tier, tx);
            if (!tierResult.success) {
                throw new Error(`Failed to update user tier: ${tierResult.error}`);
            }

            if (subscriptionId) {
                const upsertResult = await upsertSubscription(
                    userId,
                    {
                        stripeSubscriptionId: subscriptionId,
                        tier,
                        status: 'active',
                        currentPeriodStart,
                        currentPeriodEnd,
                        cancelAtPeriodEnd: false,
                    },
                    tx
                );

                if (!upsertResult.success) {
                    throw new Error(
                        `Failed to upsert subscription from checkout: ${upsertResult.error}`
                    );
                }
            }

            await recordSubscriptionEvent(
                {
                    eventId,
                    eventType: 'checkout.session.completed',
                    userId,
                    stripeSubscriptionId: subscriptionId || null,
                    status: 'processed',
                },
                tx
            );

            console.log(
                `[WEBHOOK] Checkout processed atomically for user ${userId}, tier: ${tier}, sub: ${subscriptionId}`
            );
            return { success: true, userId, subscriptionId };
        });
    } catch (error) {
        console.error('Error in handleCheckoutSessionCompleted:', error);
        return { success: false, error: String(error) };
    }
}

/**
 * Process subscription updated event atomically with terminal state protection
 */
async function handleSubscriptionUpdated(
    subscription: Stripe.Subscription,
    eventId: string
): Promise<HandlerResult> {
    try {
        const userId = subscription.metadata?.userId;
        const tier = subscription.metadata?.tier as TierName;

        if (!userId || !tier) {
            console.error('Missing metadata in subscription:', subscription.id);
            return { success: false, subscriptionId: subscription.id, error: 'Missing metadata' };
        }

        // Fail-closed mapping: any unrecognized status throws, aborting mutation
        const STATUS_MAP: Record<
            string,
            'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'incomplete_expired' | 'unpaid'
        > = {
            active: 'active',
            canceled: 'canceled',
            past_due: 'past_due',
            trialing: 'trialing',
            incomplete: 'incomplete',
            incomplete_expired: 'incomplete_expired',
            unpaid: 'unpaid',
            paused: 'canceled',
        };

        const status = STATUS_MAP[subscription.status];
        if (!status) {
            throw new Error(`Unmapped Stripe subscription status: ${subscription.status}`);
        }

        // Privileges follow money: only genuine active/trialing statuses retain a paid tier
        const paidStatuses: ReadonlyArray<string> = ['active', 'trialing'];
        const effectiveTier: TierName = paidStatuses.includes(subscription.status) ? tier : 'free';

        const firstItem = subscription.items?.data?.[0];
        let invoicePeriod: { start?: number; end?: number } | undefined;
        if (subscription.latest_invoice && typeof subscription.latest_invoice === 'object') {
            invoicePeriod = (subscription.latest_invoice as Stripe.Invoice).lines?.data?.[0]?.period;
        }

        const { currentPeriodStart, currentPeriodEnd } = extractPeriod({
            itemStart: firstItem?.current_period_start,
            itemEnd: firstItem?.current_period_end,
            invoicePeriod,
            fallbackAnchorSeconds: subscription.start_date,
        });

        // Atomic Transaction: Check Terminal State + Update Tier + Upsert Sub + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const currentSub = await getUserSubscription(userId, tx);

            // TERMINAL STATE PROTECTION: If subscription is already canceled in DB,
            // an incoming out-of-order update event attempting to set it back to active is ignored.
            if (currentSub?.status === 'canceled' && status === 'active') {
                console.warn(
                    `[WEBHOOK] Stale update event ignored: subscription for user ${userId} is already canceled (terminal state protection)`
                );
                await recordSubscriptionEvent(
                    {
                        eventId,
                        eventType: 'customer.subscription.updated',
                        userId,
                        stripeSubscriptionId: subscription.id,
                        status: 'ignored_stale',
                    },
                    tx
                );
                return { success: true, userId, subscriptionId: subscription.id };
            }

            if (effectiveTier !== tier) {
                const tierResult = await updateUserTier(userId, 'free', tx);
                if (!tierResult.success) {
                    throw new Error(
                        `Failed to downgrade user tier on payment failure: ${tierResult.error}`
                    );
                }
            } else {
                const tierResult = await updateUserTier(userId, effectiveTier, tx);
                if (!tierResult.success) {
                    throw new Error(`Failed to update user tier: ${tierResult.error}`);
                }
            }

            const result = await upsertSubscription(
                userId,
                {
                    stripeSubscriptionId: subscription.id,
                    tier: effectiveTier,
                    status,
                    currentPeriodStart,
                    currentPeriodEnd,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
                },
                tx
            );

            if (!result.success) {
                throw new Error(`Failed to upsert subscription: ${result.error}`);
            }

            await recordSubscriptionEvent(
                {
                    eventId,
                    eventType: 'customer.subscription.updated',
                    userId,
                    stripeSubscriptionId: subscription.id,
                    status: 'processed',
                },
                tx
            );

            console.log(
                `[WEBHOOK] Subscription updated atomically for user ${userId}, status: ${status}, tier: ${effectiveTier}`
            );

            return { success: true, userId, subscriptionId: subscription.id };
        });
    } catch (error) {
        console.error('Error handling customer.subscription.updated:', error);
        return { success: false, subscriptionId: subscription.id, error: String(error) };
    }
}

/**
 * Process subscription deleted event atomically
 */
async function handleSubscriptionDeleted(
    subscription: Stripe.Subscription,
    eventId: string
): Promise<HandlerResult> {
    try {
        const userId = subscription.metadata?.userId;

        if (!userId) {
            console.error('Missing userId in subscription metadata:', subscription.id);
            return { success: false, subscriptionId: subscription.id, error: 'Missing userId' };
        }

        const firstItem = subscription.items?.data?.[0];
        const { currentPeriodStart, currentPeriodEnd } = extractPeriod({
            itemStart: firstItem?.current_period_start,
            itemEnd: firstItem?.current_period_end,
            fallbackAnchorSeconds: subscription.start_date || subscription.canceled_at,
        });

        // Atomic Transaction: Downgrade User + Mark Canceled + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const tierResult = await updateUserTier(userId, 'free', tx);
            if (!tierResult.success) {
                console.error('Failed to downgrade user tier:', tierResult.error);
                return {
                    success: false,
                    userId,
                    subscriptionId: subscription.id,
                    error: tierResult.error,
                };
            }

            const upsertResult = await upsertSubscription(
                userId,
                {
                    stripeSubscriptionId: subscription.id,
                    tier: 'free',
                    status: 'canceled',
                    currentPeriodStart,
                    currentPeriodEnd,
                    cancelAtPeriodEnd: false,
                },
                tx
            );

            if (!upsertResult.success) {
                throw new Error(`Failed to cancel subscription: ${upsertResult.error}`);
            }

            await recordSubscriptionEvent(
                {
                    eventId,
                    eventType: 'customer.subscription.deleted',
                    userId,
                    stripeSubscriptionId: subscription.id,
                    status: 'processed',
                },
                tx
            );

            console.log(`[WEBHOOK] Subscription canceled atomically for user ${userId}`);
            return { success: true, userId, subscriptionId: subscription.id };
        });
    } catch (error) {
        console.error('Error handling customer.subscription.deleted:', error);
        return { success: false, subscriptionId: subscription.id, error: String(error) };
    }
}

/**
 * Process invoice payment failed event atomically using local database state
 */
async function handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
    eventId: string
): Promise<HandlerResult> {
    try {
        const userId = invoice.metadata?.userId;
        if (!userId) {
            console.error('[WEBHOOK] Missing userId in invoice metadata:', invoice.id);
            return { success: false, error: 'Missing userId' };
        }

        const invoicePeriod = invoice.lines?.data?.[0]?.period;
        const { currentPeriodStart, currentPeriodEnd } = extractPeriod({
            invoicePeriod,
            fallbackAnchorSeconds: invoice.created,
        });

        // Atomic Transaction: Downgrade User + Update Subscription locally + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const tierResult = await updateUserTier(userId, 'free', tx);
            if (!tierResult.success) {
                throw new Error(`Failed to downgrade on payment failure: ${tierResult.error}`);
            }

            // Local DB Lookup: Look up user's existing subscription directly without external Stripe network call
            const existingSub = await getUserSubscription(userId, tx);
            const subId = existingSub?.stripeSubscriptionId || '';

            const upsertResult = await upsertSubscription(
                userId,
                {
                    stripeSubscriptionId: subId,
                    tier: 'free',
                    status: 'past_due',
                    currentPeriodStart: existingSub?.currentPeriodStart || currentPeriodStart,
                    currentPeriodEnd: existingSub?.currentPeriodEnd || currentPeriodEnd,
                    cancelAtPeriodEnd: existingSub?.cancelAtPeriodEnd ?? false,
                },
                tx
            );

            if (!upsertResult.success) {
                throw new Error(`Failed to record failed-payment status: ${upsertResult.error}`);
            }

            await recordSubscriptionEvent(
                {
                    eventId,
                    eventType: 'invoice.payment_failed',
                    userId,
                    stripeSubscriptionId: subId || null,
                    status: 'processed',
                },
                tx
            );

            console.log(
                `[WEBHOOK] Payment failed handled atomically for user ${userId}; downgraded to free`
            );
            return { success: true, userId, subscriptionId: subId };
        });
    } catch (error) {
        console.error('Error handling invoice.payment_failed:', error);
        return { success: false, error: String(error) };
    }
}

/**
 * Main webhook handler (POST /api/stripe/webhook)
 */
export async function POST(request: NextRequest) {
    try {
        // 1. Get raw body as text
        const body = await request.text();

        // 2. Get Stripe signature from headers
        const headersList = await headers();
        const signature = headersList.get('stripe-signature');

        if (!signature) {
            return NextResponse.json(
                { error: 'Missing stripe-signature header' },
                { status: 400 }
            );
        }

        // 3. Verify webhook signature & timestamp tolerance (Fail-closed)
        let event: Stripe.Event;

        try {
            event = await stripe.webhooks.constructEvent(
                body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET!,
                MAX_TIMESTAMP_AGE_SECONDS
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('Timestamp outside')) {
                console.error(
                    '[WEBHOOK] Replay protection: signature timestamp outside tolerance window'
                );
                return NextResponse.json(
                    { error: 'Webhook timestamp outside tolerance window' },
                    { status: 400 }
                );
            }
            console.error('Webhook signature verification failed:', error);
            return NextResponse.json(
                { error: 'Invalid signature' },
                { status: 400 }
            );
        }

        const eventId = event.id;

        // 4. Idempotency Gate (Fast-path memory check + Authoritative DB check)
        if (processedEventIds.has(eventId)) {
            console.log(`[WEBHOOK] Duplicate event ignored (in-memory): ${eventId}`);
            return NextResponse.json({ received: true, duplicate: true });
        }

        const isProcessedInDb = await isSubscriptionEventProcessed(eventId);
        if (isProcessedInDb) {
            console.log(`[WEBHOOK] Duplicate event ignored (durable DB ledger): ${eventId}`);
            processedEventIds.add(eventId);
            return NextResponse.json({ received: true, duplicate: true });
        }

        // 5. Route to event handlers
        let mutationMeta: HandlerResult = { success: true };

        switch (event.type) {
            case 'checkout.session.completed':
                mutationMeta = await handleCheckoutSessionCompleted(
                    event.data.object as Stripe.Checkout.Session,
                    eventId
                );
                break;

            case 'customer.subscription.updated':
                mutationMeta = await handleSubscriptionUpdated(
                    event.data.object as Stripe.Subscription,
                    eventId
                );
                break;

            case 'customer.subscription.deleted':
                mutationMeta = await handleSubscriptionDeleted(
                    event.data.object as Stripe.Subscription,
                    eventId
                );
                break;

            case 'customer.subscription.trial_will_end':
                // Informational event — user retains current tier until subscription transitions
                break;

            case 'invoice.payment_failed':
                mutationMeta = await handleInvoicePaymentFailed(
                    event.data.object as Stripe.Invoice,
                    eventId
                );
                break;

            default:
                console.error(`[WEBHOOK] Unknown/unhandled event type (fail-closed): ${event.type}`);
                await recordSubscriptionEvent({
                    eventId,
                    eventType: event.type,
                    status: 'unhandled',
                });
                processedEventIds.add(eventId);
                return NextResponse.json({ received: true, event: eventId });
        }

        if (mutationMeta.success) {
            processedEventIds.add(eventId);
        }

        // 6. Zero-Allocation Fast-Path Cache Eviction (O(1) Memory Overhead)
        if (processedEventIds.size > 10_000) {
            let count = 0;
            for (const id of processedEventIds) {
                processedEventIds.delete(id);
                if (++count >= 5_000) break;
            }
        }

        return NextResponse.json({ received: true, event: eventId });
    } catch (error) {
        console.error('Error in webhook handler:', error);
        return NextResponse.json(
            { error: 'Webhook handler failed' },
            { status: 500 }
        );
    }
}
