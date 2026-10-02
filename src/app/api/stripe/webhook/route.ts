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
    cancelUserSubscription,
    getUserSubscription,
    isSubscriptionEventProcessed,
    recordSubscriptionEvent,
    executeSubscriptionTransition,
} from '@/server/actions/subscription-actions';
import type { TierName } from '@/config/tiers.config';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe';
import { getTierFromPriceId } from '@/lib/stripe/config';
import { redis } from '@/lib/redis';
import { BillingService } from '@/server/services/billing-service';

import {
    isEventProcessedInMemory,
    markEventProcessedInMemory,
    type HandlerResult,
} from '@/lib/stripe/webhook-dedupe';

export const dynamic = 'force-dynamic';

/**
 * Maximum age (in seconds) of an accepted webhook signature timestamp.
 * Protects against replay attacks: events older than this window are
 * rejected even with a valid signature.
 */
const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

/**
 * Maximum duration (in milliseconds) before a Redis REST call is aborted.
 * Guarantees fast fail-open behavior so transient Redis latency never stalls
 * the webhook handler beyond Stripe's delivery tolerance window.
 */
const REDIS_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs = REDIS_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`Redis operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as { unref: () => void }).unref();
        }
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timer) {
            clearTimeout(timer);
        }
    });
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
        const firstItem = subscription.items?.data?.[0];
        const priceTier = getTierFromPriceId(firstItem?.price?.id);
        const metadataTier = subscription.metadata?.tier as TierName | undefined;
        const tier: TierName | undefined = priceTier || metadataTier;

        const customerId = typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;

        const userId = await BillingService.resolveUserId({
            metadataUserId: subscription.metadata?.userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
        });

        if (!userId || !tier) {
            console.error('Missing metadata or unrecognized price in subscription:', subscription.id);
            return { success: false, subscriptionId: subscription.id, error: 'Missing metadata' };
        }

        // Fail-closed mapping: any unrecognized status throws, aborting mutation
        const STATUS_MAP: Record<
            string,
            'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused'
        > = {
            active: 'active',
            canceled: 'canceled',
            past_due: 'past_due',
            trialing: 'trialing',
            incomplete: 'incomplete',
            incomplete_expired: 'incomplete_expired',
            unpaid: 'unpaid',
            paused: 'paused',
        };

        const status = STATUS_MAP[subscription.status];
        if (!status) {
            throw new Error(`Unmapped Stripe subscription status: ${subscription.status}`);
        }

        // Privileges follow money: only genuine active/trialing statuses retain a paid tier
        const paidStatuses: ReadonlyArray<string> = ['active', 'trialing'];
        const effectiveTier: TierName = paidStatuses.includes(subscription.status) ? tier : 'free';

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

        // Atomic Transaction: Check Terminal State + Sync Sub + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const currentSub = await getUserSubscription(userId, tx);

            // TERMINAL STATE PROTECTION: If subscription is already canceled in DB,
            // an incoming out-of-order update event attempting to set it back to active is ignored.
            if (currentSub?.status === 'canceled' && status === 'active' && (!currentSub?.stripeSubscriptionId || currentSub?.stripeSubscriptionId === subscription.id)) {
                console.warn(
                    `[WEBHOOK] Stale update event ignored: subscription ${subscription.id} for user ${userId} is already canceled (terminal state protection)`
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

            const upsertResult = await upsertSubscription(
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

            if (!upsertResult.success) {
                throw new Error(`Failed to upsert subscription: ${upsertResult.error}`);
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
        const customerId = typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer?.id;

        const userId = await BillingService.resolveUserId({
            metadataUserId: subscription.metadata?.userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
        });

        if (!userId) {
            console.error('Missing userId in subscription metadata:', subscription.id);
            return { success: false, subscriptionId: subscription.id, error: 'Missing userId' };
        }

        // Atomic Transaction: Cancel Subscription + Recalculate Tier (1:N) + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const cancelResult = await cancelUserSubscription(
                userId,
                tx,
                subscription.id
            );

            if (!cancelResult.success) {
                throw new Error(`Failed to cancel subscription: ${cancelResult.error}`);
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

            console.log(
                `[WEBHOOK] Subscription canceled atomically for user ${userId}`
            );
            return { success: true, userId, subscriptionId: subscription.id };
        });
    } catch (error) {
        console.error('Error handling customer.subscription.deleted:', error);
        return { success: false, subscriptionId: subscription.id, error: String(error) };
    }
}

/**
 * Process invoice payment failed event atomically with grace period preservation (LUGX-026)
 */
async function handleInvoicePaymentFailed(
    invoice: Stripe.Invoice,
    eventId: string
): Promise<HandlerResult> {
    try {
        const rawInvoice = invoice as unknown as {
            subscription?: string | { id: string };
            subscription_details?: { metadata?: { userId?: string } };
        };
        const subDetails = rawInvoice.subscription_details;
        const subId = typeof rawInvoice.subscription === 'string'
            ? rawInvoice.subscription
            : rawInvoice.subscription?.id;
        const customerId = typeof invoice.customer === 'string'
            ? invoice.customer
            : (invoice.customer as Stripe.Customer | undefined)?.id;

        const userId = await BillingService.resolveUserId({
            metadataUserId: invoice.metadata?.userId,
            subscriptionDetailsUserId: subDetails?.metadata?.userId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
        });

        if (!userId) {
            console.error('[WEBHOOK] Missing userId in invoice metadata:', invoice.id);
            return { success: false, error: 'Missing userId' };
        }

        const invoicePeriod = invoice.lines?.data?.[0]?.period;
        const { currentPeriodStart, currentPeriodEnd } = extractPeriod({
            invoicePeriod,
            fallbackAnchorSeconds: invoice.created,
        });

        // Atomic Transaction: Grace Period (past_due) + Recalculate Tier + Record Event
        return await executeSubscriptionTransition(async (tx) => {
            const existingSub = await getUserSubscription(userId, tx);
            const resolvedSubId = subId || existingSub?.stripeSubscriptionId || '';

            const upsertResult = await upsertSubscription(
                userId,
                {
                    stripeSubscriptionId: resolvedSubId,
                    tier: existingSub?.tier || 'free',
                    status: 'past_due',
                    currentPeriodStart: existingSub?.currentPeriodStart || currentPeriodStart,
                    currentPeriodEnd: existingSub?.currentPeriodEnd || currentPeriodEnd,
                    cancelAtPeriodEnd: existingSub?.cancelAtPeriodEnd ?? false,
                },
                tx
            );

            if (!upsertResult.success) {
                throw new Error(`Failed to update past_due status: ${upsertResult.error}`);
            }

            await recordSubscriptionEvent(
                {
                    eventId,
                    eventType: 'invoice.payment_failed',
                    userId,
                    stripeSubscriptionId: resolvedSubId || null,
                    status: 'processed',
                },
                tx
            );

            console.log(
                `[WEBHOOK] Payment failed handled atomically for user ${userId}; status: past_due`
            );
            return { success: true, userId, subscriptionId: resolvedSubId };
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
    let lockKey = '';
    let lockAcquired = false;
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

        // 4. Idempotency Gate (Layered: L1 Memory -> L1.5 Redis Dedup -> L1.5 Redis Lock -> L2 Postgres DB)

        // L1 — In-Memory Fast-Path Check
        if (isEventProcessedInMemory(eventId)) {
            console.log(`[WEBHOOK] Duplicate event ignored (in-memory): ${eventId}`);
            return NextResponse.json({ received: true, duplicate: true });
        }

        // L1.5 — Durable Redis Deduplication Fast-Path Check (Checked BEFORE DB to shield Postgres)
        try {
            const dedupResult = await withTimeout(redis.get(`stripe:dedup:${eventId}`));
            if (dedupResult === 'processed') {
                console.log(`[WEBHOOK] Duplicate event ignored (Redis dedup cache): ${eventId}`);
                markEventProcessedInMemory(eventId);
                return NextResponse.json({ received: true, duplicate: true });
            }
        } catch (error) {
            // Fail-Open: skip Redis dedup check on timeout/error
            console.warn('[WEBHOOK] Redis dedup check error (failing open):', error);
        }

        // L1.5 — In-Flight Distributed Lock (Upstash Redis REST API with 1500ms timeout)
        lockKey = `stripe:lock:${eventId}`;
        try {
            const lockResult = await withTimeout(redis.set(lockKey, '1', { nx: true, ex: 30 }));
            if (lockResult === null) {
                // Another worker is processing this exact event right now (LUGX-025)
                console.warn(`[WEBHOOK] Lock contention for event: ${eventId} - returning 503`);
                return NextResponse.json(
                    { error: 'Concurrent event in flight, retry requested' },
                    { status: 503, headers: { 'Retry-After': '5' } }
                );
            }
            lockAcquired = true;
        } catch (redisError) {
            // Fail-Open: Redis unreachable/timed out → fall through to Postgres ACID guard
            console.warn('[WEBHOOK] Redis lock unavailable, falling back to DB idempotency:', redisError);
        }

        // L2 — Durable PostgreSQL Ledger Check (Authoritative fallback)
        const isProcessedInDb = await isSubscriptionEventProcessed(eventId);
        if (isProcessedInDb) {
            console.log(`[WEBHOOK] Duplicate event ignored (durable DB ledger): ${eventId}`);
            markEventProcessedInMemory(eventId);
            if (lockAcquired && lockKey) {
                try {
                    await withTimeout(redis.set(`stripe:dedup:${eventId}`, 'processed', { ex: 86400 }));
                    await withTimeout(redis.del(lockKey));
                } catch {
                    /* non-critical: DB is authoritative */
                }
            }
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
                mutationMeta = { success: true };
                break;
        }

        if (mutationMeta.success) {
            markEventProcessedInMemory(eventId);
            if (lockAcquired && lockKey) {
                try {
                    await withTimeout(redis.set(`stripe:dedup:${eventId}`, 'processed', { ex: 86400 }));
                    await withTimeout(redis.del(lockKey));
                } catch {
                    /* non-critical: DB is authoritative */
                }
            }
            return NextResponse.json({ received: true, event: eventId });
        } else {
            // LUGX-025: Return 500 on mutation failure so Stripe retries
            if (lockAcquired && lockKey) {
                await withTimeout(redis.del(lockKey)).catch(() => {});
            }
            console.error(`[WEBHOOK] Mutation failed for event ${eventId}: ${mutationMeta.error}`);
            return NextResponse.json(
                { error: mutationMeta.error || 'Webhook mutation failed' },
                { status: 500 }
            );
        }
    } catch (error) {
        console.error('Error in webhook handler:', error);
        if (lockAcquired && lockKey) {
            await withTimeout(redis.del(lockKey)).catch(() => {});
        }
        return NextResponse.json(
            { error: 'Webhook handler failed' },
            { status: 500 }
        );
    }
}
