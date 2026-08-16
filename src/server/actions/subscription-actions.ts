/**
 * Subscription Server Actions
 * 
 * Handles database operations for user subscriptions.
 */

'use server';

import { db } from '@/lib/db';
import { users, subscriptions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { TierName } from '@/config/tiers.config';

/**
 * Update user tier in database
 * @param userId - User UUID
 * @param tier - New tier
 * @returns Success boolean
 */
export async function updateUserTier(
    userId: string,
    tier: TierName
): Promise<{ success: boolean; error?: string }> {
    console.log('🔵 [DB] updateUserTier called - userId:', userId, 'tier:', tier);

    try {
        const result = await db
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
 * @returns Success boolean
 */
export async function updateUserStripeCustomerId(
    userId: string,
    stripeCustomerId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        await db
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
 * @returns Success boolean
 */
export async function upsertSubscription(
    userId: string,
    subscriptionData: {
        stripeSubscriptionId: string;
        tier: TierName;
        status: 'active' | 'canceled' | 'past_due' | 'trialing';
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        cancelAtPeriodEnd?: boolean;
    }
): Promise<{ success: boolean; error?: string }> {
    try {
        // Check if subscription exists
        const existing = await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.userId, userId))
            .limit(1);

        if (existing.length > 0) {
            // Update existing subscription
            await db
                .update(subscriptions)
                .set({
                    ...subscriptionData,
                    updatedAt: new Date(),
                })
                .where(eq(subscriptions.userId, userId));
        } else {
            // Create new subscription
            await db.insert(subscriptions).values({
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
 * @returns Success boolean
 */
export async function cancelUserSubscription(
    userId: string
): Promise<{ success: boolean; error?: string }> {
    try {
        // Update user tier to free
        await db
            .update(users)
            .set({
                tier: 'free',
                updatedAt: new Date(),
            })
            .where(eq(users.id, userId));

        // Update subscription status
        await db
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
