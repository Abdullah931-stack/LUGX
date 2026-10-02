/**
 * Subscription Database Utilities (Internal Server-Only)
 * 
 * Handles database operations for user subscriptions and durable webhook event idempotency.
 */

import { db } from '@/server/db';
import { txDb } from '@/server/db/transactional';
import { users, subscriptions, subscriptionEvents } from '@/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import type { TierName } from '@/config/tiers.config';
import { BillingService } from '@/server/services/billing-service';

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
        throw error;
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
        // ENGINEERING UPGRADE (W2 & Phase 12): full Stripe lifecycle with paused status
        status: 'active' | 'canceled' | 'past_due' | 'trialing' | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused';
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd?: boolean;
    },
    client?: DbClient
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        await BillingService.syncSubscription(
            {
                userId,
                ...subscriptionData,
            },
            targetDb as unknown as import('@/server/services/billing-service').DbClient
        );

        return { success: true };
    } catch (error) {
        console.error('Error upserting subscription:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update subscription',
        };
    }
}

/**
 * Cancel subscription and recalculate user tier (1:N supported)
 * @param userId - User UUID
 * @param client - Optional DB / transaction client
 * @param stripeSubscriptionId - Optional specific subscription ID to cancel
 * @returns Success boolean
 */
export async function cancelUserSubscription(
    userId: string,
    client?: DbClient,
    stripeSubscriptionId?: string
): Promise<{ success: boolean; error?: string }> {
    const targetDb = client || db;
    try {
        if (stripeSubscriptionId) {
            await BillingService.handleCancellation(
                stripeSubscriptionId,
                userId,
                targetDb as unknown as import('@/server/services/billing-service').DbClient
            );
        } else {
            await targetDb
                .update(subscriptions)
                .set({
                    status: 'canceled',
                    cancelAtPeriodEnd: false,
                    updatedAt: new Date(),
                })
                .where(eq(subscriptions.userId, userId));

            await targetDb
                .update(users)
                .set({
                    tier: 'free',
                    updatedAt: new Date(),
                })
                .where(eq(users.id, userId));
        }

        return { success: true };
    } catch (error) {
        console.error('Error canceling subscription:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to cancel subscription',
        };
    }
}

/**
 * Get the most relevant user subscription record from database (prioritizing active/trialing)
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
            .orderBy(desc(subscriptions.createdAt));

        if (rows.length === 0) return null;

        // Prioritize active or trialing subscriptions
        const activeSub = rows.find((r) => r.status === 'active' || r.status === 'trialing');
        return activeSub || rows[0];
    } catch (error) {
        console.error('Error fetching user subscription:', error);
        return null;
    }
}

/**
 * Get all subscription records for a user
 */
export async function getUserSubscriptions(
    userId: string,
    client?: DbClient
): Promise<(typeof subscriptions.$inferSelect)[]> {
    const targetDb = client || db;
    try {
        return await targetDb
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .orderBy(desc(subscriptions.createdAt));
    } catch (error) {
        console.error('Error fetching user subscriptions:', error);
        return [];
    }
}

/**
 * Derive user effective tier from all active subscriptions
 */
export async function calculateEffectiveTier(
    userId: string,
    client?: DbClient
): Promise<TierName> {
    return BillingService.calculateEffectiveTier(
        userId,
        client as unknown as import('@/server/services/billing-service').DbClient
    );
}
