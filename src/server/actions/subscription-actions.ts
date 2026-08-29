/**
 * Subscription Database Utilities (Internal Server-Only)
 * 
 * Handles database operations for user subscriptions and durable webhook event idempotency.
 */

import { db } from '@/lib/db';
import { txDb } from '@/lib/db/transactional';
import { users, subscriptions, subscriptionEvents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { TierName } from '@/config/tiers.config';

export type DbClient = {
    select: typeof db.select;
    insert: typeof db.insert;
    update: typeof db.update;
};

/**
 * Check if a Stripe webhook event ID has already been recorded in the database.
 * Used as the durable backstop against replay/duplicates across server restarts.
 * @param eventId - Stripe event ID (evt_xxx)
 * @param client - Optional DB / transaction client
 */
export async function isSubscriptionEventProcessed(
    eventId: string,
    client?: DbClient
): Promise<boolean> {
    const targetDb = client || db;
    try {
        const rows = await targetDb
            .select({ id: subscriptionEvents.id })
            .from(subscriptionEvents)
            .where(eq(subscriptionEvents.eventId, eventId))
            .limit(1);

        return rows.length > 0;
    } catch (error) {
        console.error('Error checking subscription event processed status:', error);
        return false;
    }
}

/**
 * Record a Stripe webhook event into the durable event ledger.
 * @param eventData - Event data to persist
 * @param client - Optional DB / transaction client
 */
export async function recordSubscriptionEvent(
    eventData: {
        eventId: string;
        eventType: string;
        userId?: string | null;
        stripeSubscriptionId?: string | null;
        status?: string;
    },
    client?: DbClient
): Promise<{ success: boolean; duplicate?: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        await targetDb.insert(subscriptionEvents).values({
            eventId: eventData.eventId,
            eventType: eventData.eventType,
            userId: eventData.userId || null,
            stripeSubscriptionId: eventData.stripeSubscriptionId || null,
            status: eventData.status || 'processed',
            createdAt: new Date(),
        });

        return { success: true };
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (
            msg.includes('unique') ||
            msg.includes('duplicate key') ||
            msg.includes('idx_subscription_events_event_id') ||
            msg.includes('subscription_events_event_id_unique')
        ) {
            return { success: false, duplicate: true, error: 'Duplicate event ID' };
        }
        console.error('Error recording subscription event:', error);
        return {
            success: false,
            error: 'Failed to record subscription event',
        };
    }
}

/**
 * Execute an atomic transition within a database transaction if supported.
 * Falls back to direct execution if txDb.transaction is not available in test/env.
 */
export async function executeSubscriptionTransition<T>(
    operation: (tx: DbClient) => Promise<T>
): Promise<T> {
    const targetDb = txDb && typeof txDb.transaction === 'function' ? txDb : db;
    if (typeof targetDb.transaction === 'function') {
        return (targetDb.transaction as unknown as (cb: (tx: DbClient) => Promise<T>) => Promise<T>)(operation);
    }
    return operation(db as unknown as DbClient);
}

/**
 * Update user tier in database
 * @param userId - User UUID
 * @param tier - New tier
 * @param client - Optional DB / transaction client
 * @returns Success boolean
 */
export async function updateUserTier(
    userId: string,
    tier: TierName,
    client?: DbClient
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    console.log('🔵 [DB] updateUserTier called - userId:', userId, 'tier:', tier);

    try {
        const result = await targetDb
            .update(users)
            .set({
                tier,
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));

        console.log('✅ [DB] User tier updated successfully!');
        console.log('🔵 [DB] Update result:', result);

        return { success: true };
    } catch (error) {
        console.error('❌ [DB] Error updating user tier:', error);
        return {
            success: false,
            error: 'Failed to update user tier',
        };
    }
}

/**
 * Update Stripe customer ID for user
 * @param userId - User UUID
 * @param stripeCustomerId - Stripe Customer ID
 * @param client - Optional DB / transaction client
 * @returns Success boolean
 */
export async function updateUserStripeCustomerId(
    userId: string,
    stripeCustomerId: string,
    client?: DbClient
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        await targetDb
            .update(users)
            .set({
                stripeCustomerId,
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));

        return { success: true };
    } catch (error) {
        console.error('Error updating Stripe customer ID:', error);
        return {
            success: false,
            error: 'Failed to update Stripe customer ID',
        };
    }
}

/**
 * Create or update subscription record
 * @param userId - User UUID
 * @param subscriptionData - Subscription data from Stripe
 * @param client - Optional DB / transaction client
 * @returns Success boolean
 */
export async function upsertSubscription(
    userId: string,
    subscriptionData: {
        stripeSubscriptionId: string;
        tier: TierName;
        // ENGINEERING UPGRADE (W2): full Stripe lifecycle (fail-closed):
        // payment-failure states are now legal values instead of silently
        // falling back to 'active'.
        status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'incomplete_expired' | 'unpaid';
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd?: boolean;
    },
    client?: DbClient
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        // Check if subscription exists
        const existing = await targetDb
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);

        if (existing.length > 0) {
            // Update existing subscription
            await targetDb
                .update(subscriptions)
                .set({
                    ...subscriptionData,
                    updatedAt: new Date(),
                })
                .where(eq(subscriptions.userId, userId));
        } else {
            // Create new subscription
            await targetDb.insert(subscriptions).values({
                userId,
                ...subscriptionData,
                createdAt: new Date(),
                updatedAt: new Date(),
            });
        }

        return { success: true };
    } catch (error) {
        console.error('Error upserting subscription:', error);
        return {
            success: false,
            error: 'Failed to update subscription',
        };
    }
}

/**
 * Cancel subscription and downgrade user to free tier
 * @param userId - User UUID
 * @param client - Optional DB / transaction client
 * @returns Success boolean
 */
export async function cancelUserSubscription(
    userId: string,
    client?: DbClient
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        // Update user tier to free
        await targetDb
            .update(users)
            .set({
                tier: 'free',
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));

        // Update subscription status
        await targetDb
            .update(subscriptions)
            .set({
                status: 'canceled',
                cancelAtPeriodEnd: false,
                updatedAt: new Date(),
            })
            .where(eq(subscriptions.userId, userId));

        return { success: true };
    } catch (error) {
        console.error('Error canceling subscription:', error);
        return {
            success: false,
            error: 'Failed to cancel subscription',
        };
    }
}

/**
 * Get user subscription record from database
 * @param userId - User UUID
 * @param client - Optional DB / transaction client
 * @returns Subscription object or null
 */
export async function getUserSubscription(
    userId: string,
    client?: DbClient
): Promise<typeof subscriptions.$inferSelect | null> {
    const targetDb = client || db;
    try {
        const rows = await targetDb
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);

        return rows[0] || null;
    } catch (error) {
        console.error('Error fetching user subscription:', error);
        return null;
    }
}
