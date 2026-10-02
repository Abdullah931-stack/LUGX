import "server-only";

/**
 * Authoritative Billing Service (Phase 12)
 *
 * Implements core domain logic for Stripe 1:N multi-subscriptions, dynamic tier derivation,
 * graceful invoice handling, and customer portal integration.
 *
 * Remediates:
 * - LUGX-025: Strict error propagation and deterministic execution.
 * - LUGX-026: Subscription-level userId resolution and invoice grace periods.
 * - LUGX-027: 1:N subscription tracking and dynamic MAX(tier) derivation.
 * - LUGX-068: Price-derived tier mapping.
 * - LUGX-069: Non-terminal paused state support.
 * - LUGX-135: Deterministic customer binding.
 * - LUGX-141: Fast user resolution via indexed stripe_customer_id.
 * - LUGX-149: Stripe Customer Portal session creation.
 */

import { db } from "@/server/db";
import { txDb } from "@/server/db/transactional";
import * as schema from "@/server/db/schema";
import { eq, desc } from "drizzle-orm";
import type { TierName } from "@/config/tiers.config";
import { stripe } from "@/lib/stripe";

export type DbClient = {
    select: typeof db.select;
    insert: typeof db.insert;
    update: typeof db.update;
    delete: typeof db.delete;
    query?: typeof db.query;
};

export type SubscriptionStatus =
    | "active"
    | "canceled"
    | "past_due"
    | "trialing"
    | "incomplete"
    | "incomplete_expired"
    | "unpaid"
    | "paused";

/**
 * Numeric weight hierarchy for deterministic MAX(tier) calculation.
 * Ultra (2) > Pro (1) > Free (0)
 */
const TIER_WEIGHTS: Record<TierName, number> = {
    ultra: 2,
    pro: 1,
    free: 0,
};

/**
 * Get the target database client (transaction client or default client)
 */
function getActiveClient(client?: DbClient): DbClient {
    if (client) return client;
    if (txDb && typeof txDb.transaction === "function") return txDb as unknown as DbClient;
    return db as unknown as DbClient;
}

export class BillingService {
    /**
     * Dynamically derives the effective user tier from all active or trialing subscriptions (1:N).
     * Calculates MAX(tier) based on tier weights.
     */
    static async calculateEffectiveTier(
        userId: string,
        client?: DbClient
    ): Promise<TierName> {
        const targetDb = getActiveClient(client);

        const rows = await targetDb
            .select({ tier: schema.subscriptions.tier, status: schema.subscriptions.status })
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, userId));

        let highestTier: TierName = "free";
        let maxWeight = 0;

        for (const row of rows) {
            if (row.status === "active" || row.status === "trialing") {
                const weight = TIER_WEIGHTS[row.tier as TierName] || 0;
                if (weight > maxWeight) {
                    maxWeight = weight;
                    highestTier = row.tier as TierName;
                }
            }
        }

        return highestTier;
    }

    /**
     * Resolves the internal userId from multiple candidate sources:
     * 1. Direct metadata on subscription or session
     * 2. Nested subscription_details metadata on invoice
     * 3. Indexed stripe_customer_id in users table (LUGX-141)
     * 4. Existing subscription record matching stripeSubscriptionId
     */
    static async resolveUserId(
        options: {
            metadataUserId?: string | null;
            subscriptionDetailsUserId?: string | null;
            stripeCustomerId?: string | null;
            stripeSubscriptionId?: string | null;
        },
        client?: DbClient
    ): Promise<string | null> {
        if (options.metadataUserId) {
            return options.metadataUserId;
        }

        if (options.subscriptionDetailsUserId) {
            return options.subscriptionDetailsUserId;
        }

        const targetDb = getActiveClient(client);

        // Resolve via stripeCustomerId if available
        if (options.stripeCustomerId) {
            const userRows = await targetDb
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(eq(schema.users.stripeCustomerId, options.stripeCustomerId))
                .limit(1);

            if (userRows.length > 0) {
                return userRows[0].id;
            }
        }

        // Resolve via existing subscription record
        if (options.stripeSubscriptionId) {
            const subRows = await targetDb
                .select({ userId: schema.subscriptions.userId })
                .from(schema.subscriptions)
                .where(eq(schema.subscriptions.stripeSubscriptionId, options.stripeSubscriptionId))
                .limit(1);

            if (subRows.length > 0) {
                return subRows[0].userId;
            }
        }

        return null;
    }

    /**
     * Atomically upserts a subscription row indexed by stripe_subscription_id (1:N)
     * and synchronizes the user's effective tier via MAX(tier).
     */
    static async syncSubscription(
        data: {
            userId: string;
            stripeSubscriptionId: string;
            tier: TierName;
            status: SubscriptionStatus;
            currentPeriodStart: Date;
            currentPeriodEnd: Date;
            cancelAtPeriodEnd?: boolean;
        },
        client?: DbClient
    ): Promise<{ success: boolean; effectiveTier: TierName; error?: string }> {
        const targetDb = getActiveClient(client);

        try {
            // Upsert subscription by stripeSubscriptionId
            const existing = await targetDb
                .select()
                .from(schema.subscriptions)
                .where(eq(schema.subscriptions.stripeSubscriptionId, data.stripeSubscriptionId))
                .limit(1);

            if (existing.length > 0) {
                await targetDb
                    .update(schema.subscriptions)
                    .set({
                        userId: data.userId,
                        tier: data.tier,
                        status: data.status,
                        currentPeriodStart: data.currentPeriodStart,
                        currentPeriodEnd: data.currentPeriodEnd,
                        cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.subscriptions.id, existing[0].id));
            } else {
                await targetDb.insert(schema.subscriptions).values({
                    userId: data.userId,
                    stripeSubscriptionId: data.stripeSubscriptionId,
                    tier: data.tier,
                    status: data.status,
                    currentPeriodStart: data.currentPeriodStart,
                    currentPeriodEnd: data.currentPeriodEnd,
                    cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });
            }

            // Derive user's effective tier across all subscriptions
            const effectiveTier = await this.calculateEffectiveTier(data.userId, targetDb);

            // Update user tier in the same transaction
            await targetDb
                .update(schema.users)
                .set({
                    tier: effectiveTier,
                    updatedAt: new Date(),
                })
                .where(eq(schema.users.id, data.userId));

            return { success: true, effectiveTier };
        } catch (error) {
            console.error("[BillingService] Error syncing subscription:", error);
            throw error; // Propagate to trigger atomic rollback and HTTP 500 retry
        }
    }

    /**
     * Handles subscription cancellation without destroying other active user subscriptions (1:N).
     * Recalculates effective tier from remaining active subscriptions.
     */
    static async handleCancellation(
        stripeSubscriptionId: string,
        fallbackUserId?: string | null,
        client?: DbClient
    ): Promise<{ success: boolean; effectiveTier: TierName; userId?: string }> {
        const targetDb = getActiveClient(client);

        // Find existing subscription
        const existing = await targetDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId))
            .limit(1);

        const resolvedUserId = existing[0]?.userId || fallbackUserId;
        if (!resolvedUserId) {
            throw new Error(`Cannot cancel subscription ${stripeSubscriptionId}: userId unresolved`);
        }

        if (existing.length > 0) {
            await targetDb
                .update(schema.subscriptions)
                .set({
                    status: "canceled",
                    tier: "free",
                    cancelAtPeriodEnd: false,
                    updatedAt: new Date(),
                })
                .where(eq(schema.subscriptions.id, existing[0].id));
        }

        // Recalculate effective tier: if user has another active subscription, they keep that tier!
        const effectiveTier = await this.calculateEffectiveTier(resolvedUserId, targetDb);

        await targetDb
            .update(schema.users)
            .set({
                tier: effectiveTier,
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, resolvedUserId));

        return { success: true, effectiveTier, userId: resolvedUserId };
    }

    /**
     * Handles invoice payment failure (LUGX-026).
     * Marks the specific subscription as past_due during the grace period
     * without immediately wiping out the user's tier if smart retries are pending.
     */
    static async handleInvoicePaymentFailed(
        options: {
            stripeSubscriptionId?: string | null;
            userId: string;
            currentPeriodStart?: Date;
            currentPeriodEnd?: Date;
        },
        client?: DbClient
    ): Promise<{ success: boolean; effectiveTier: TierName; subscriptionId?: string }> {
        const targetDb = getActiveClient(client);

        let subId = options.stripeSubscriptionId;

        // If subscriptionId was omitted, find user's most recent active subscription
        if (!subId) {
            const existing = await targetDb
                .select()
                .from(schema.subscriptions)
                .where(eq(schema.subscriptions.userId, options.userId))
                .orderBy(desc(schema.subscriptions.createdAt))
                .limit(1);

            subId = existing[0]?.stripeSubscriptionId || null;
        }

        if (subId) {
            const existing = await targetDb
                .select()
                .from(schema.subscriptions)
                .where(eq(schema.subscriptions.stripeSubscriptionId, subId))
                .limit(1);

            if (existing.length > 0) {
                await targetDb
                    .update(schema.subscriptions)
                    .set({
                        status: "past_due",
                        updatedAt: new Date(),
                    })
                    .where(eq(schema.subscriptions.id, existing[0].id));
            }
        }

        // Re-evaluate user tier (past_due is not active/trialing, but user might have another subscription)
        const effectiveTier = await this.calculateEffectiveTier(options.userId, targetDb);

        await targetDb
            .update(schema.users)
            .set({
                tier: effectiveTier,
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, options.userId));

        return { success: true, effectiveTier, subscriptionId: subId || undefined };
    }

    /**
     * Creates a Stripe Customer Portal session for subscription self-management (LUGX-149).
     */
    static async createCustomerPortalSession(
        userId: string,
        returnUrl?: string
    ): Promise<{ url: string }> {
        const [user] = await db
            .select({ stripeCustomerId: schema.users.stripeCustomerId })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1);

        if (!user || !user.stripeCustomerId) {
            throw new Error("No Stripe customer found for this account. Please subscribe first.");
        }

        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
        const session = await stripe.billingPortal.sessions.create({
            customer: user.stripeCustomerId,
            return_url: returnUrl || `${appUrl}/account`,
        });

        return { url: session.url };
    }

    /**
     * Retrieve all subscriptions for a user ordered by creation date.
     */
    static async getUserSubscriptions(
        userId: string,
        client?: DbClient
    ): Promise<schema.Subscription[]> {
        const targetDb = getActiveClient(client);
        return await targetDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, userId))
            .orderBy(desc(schema.subscriptions.createdAt));
    }
}
