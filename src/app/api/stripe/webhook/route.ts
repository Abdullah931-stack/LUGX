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

/**
 * Process checkout session completed event
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    console.log('🔵 [WEBHOOK] checkout.session.completed received');
    console.log('🔵 [WEBHOOK] Session ID:', session.id);
    console.log('🔵 [WEBHOOK] Payment Status:', session.payment_status);

    try {
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier as TierName;

        console.log('🔵 [WEBHOOK] Metadata - userId:', userId);
        console.log('🔵 [WEBHOOK] Metadata - tier:', tier);

        if (!userId || !tier) {
            console.error('❌ [WEBHOOK] Missing metadata in checkout session:', session.id);
            console.error('❌ [WEBHOOK] Available metadata:', session.metadata);
            return;
        }

        console.log('🔵 [WEBHOOK] Attempting to update tier for user:', userId, 'to:', tier);

        // Update user tier
        const tierResult = await updateUserTier(userId, tier);

        if (!tierResult.success) {
            console.error('❌ [WEBHOOK] Failed to update user tier:', tierResult.error);
            return;
        }

        console.log('✅ [WEBHOOK] Tier updated successfully!');

        // Get subscription details
        const subscriptionId = session.subscription as string;

        if (subscriptionId) {
            console.log('✅ [WEBHOOK] Checkout completed for user', userId, 'tier:', tier, 'subscription:', subscriptionId);
        } else {
            console.warn('⚠️  [WEBHOOK] No subscription ID in session');
        }
    } catch (error) {
        console.error('❌ [WEBHOOK] Error in handleCheckoutSessionCompleted:', error);
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

        // Determine subscription status
        let status: 'active' | 'canceled' | 'past_due' | 'trialing';

        switch (subscription.status) {
            case 'active':
                status = 'active';
                break;
            case 'canceled':
                status = 'canceled';
                break;
            case 'past_due':
                status = 'past_due';
                break;
            case 'trialing':
                status = 'trialing';
                break;
            default:
                console.warn(`Unknown subscription status: ${subscription.status}`);
                status = 'active';
        }

        // Upsert subscription record
        const result = await upsertSubscription(userId, {
            stripeSubscriptionId: subscription.id,
            tier,
            status,
            currentPeriodStart: new Date((subscription as any).current_period_start * 1000),
            currentPeriodEnd: new Date((subscription as any).current_period_end * 1000),
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
        });

        if (!result.success) {
            console.error('Failed to upsert subscription:', result.error);
            return;
        }

        console.log(`✅ Subscription updated for user ${userId}, status: ${status}`);
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
            currentPeriodStart: new Date((subscription as any).current_period_start * 1000),
            currentPeriodEnd: new Date((subscription as any).current_period_end * 1000),
            cancelAtPeriodEnd: false,
        });

        console.log(`✅ Subscription canceled for user ${userId}, downgraded to free`);
    } catch (error) {
        console.error('Error handling customer.subscription.deleted:', error);
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

        // Verify webhook signature and construct event
        let event: Stripe.Event;

        try {
            event = constructWebhookEvent(body, signature);
        } catch (error) {
            console.error('Webhook signature verification failed:', error);
            return NextResponse.json(
                { error: 'Invalid signature' },
                { status: 400 }
            );
        }

        // Handle different event types
        console.log('🔵 [WEBHOOK] Event type received:', event.type);

        switch (event.type) {
            case 'checkout.session.completed':
                console.log('🔵 [WEBHOOK] Processing checkout.session.completed');
                await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
                break;

            case 'customer.subscription.updated':
                console.log('🔵 [WEBHOOK] Processing customer.subscription.updated');
                await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
                break;

            case 'customer.subscription.deleted':
                console.log('🔵 [WEBHOOK] Processing customer.subscription.deleted');
                await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
                break;

            default:
                console.log(`ℹ️  [WEBHOOK] Unhandled event type: ${event.type}`);
        }

        // Return success response
        return NextResponse.json({ received: true });

    } catch (error) {
        console.error('Error in webhook handler:', error);
        return NextResponse.json(
            { error: 'Webhook handler failed' },
            { status: 500 }
        );
    }
}
