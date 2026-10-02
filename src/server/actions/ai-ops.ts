"use server";

import { db } from "@/server/db";
import * as schema from "@/server/db/schema";
import crypto from "node:crypto";
import { processWithAI, Tier } from "@/lib/ai/client";
import { AIOperation } from "@/lib/ai/prompts";
import { getUser } from "@/lib/supabase/server";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { TIER_LIMITS, TierName, isToPromptEnabled } from "@/config/tiers.config";
import { countWords } from "@/lib/utils";
import { eq, and, sql } from "drizzle-orm";
import {
    getUserTier as getTierFromService,
    getTodayUsage as getUsageFromService,
    reserveAIQuota,
    commitAIReservation as commitReservationService,
    refundAIReservation as refundReservationService,
    getAIReservationStatus as getStatusFromService,
} from "@/server/services/ai-settlement-service";

/**
 * Get user's tier from database (read-only query).
 */
export async function getUserTier(userId: string): Promise<TierName> {
    return getTierFromService(userId);
}

/**
 * Get usage for today (read-only query / ensure record).
 */
export async function getTodayUsage(userId: string) {
    return getUsageFromService(userId);
}

// Get start of current week (Sunday) for weekly quota
function getWeekStart(): string {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    return startOfWeek.toISOString().split("T")[0];
}

/**
 * Get weekly word usage for free tier
 */
async function getWeeklyWordUsage(userId: string): Promise<number> {
    const weekStart = getWeekStart();

    const result = await db
        .select({
            total: sql<number>`COALESCE(SUM(correct_words + improve_words + translate_words), 0)`,
        })
        .from(schema.usage)
        .where(
            and(
                eq(schema.usage.userId, userId),
                sql`date >= ${weekStart}`
            )
        );

    return result[0]?.total || 0;
}

/**
 * Check if user has quota for operation (read-only pre-flight check)
 */
export async function checkQuota(
    userId: string,
    operation: AIOperation,
    wordCount: number
): Promise<{ allowed: boolean; reason?: string }> {
    const tier = await getUserTier(userId);
    const limits = TIER_LIMITS[tier];
    const usage = await getTodayUsage(userId);

    // Check ToPrompt availability
    if (operation === "toPrompt") {
        if (!isToPromptEnabled(tier)) {
            return { allowed: false, reason: "ToPrompt is only available for Pro and Ultra plans" };
        }
        if (usage.toPromptCount >= limits.toPrompt!.dailyLimit) {
            return { allowed: false, reason: "Daily ToPrompt limit reached" };
        }
        return { allowed: true };
    }

    // Check Summarize limits
    if (operation === "summarize") {
        if (wordCount > limits.summarize.maxWordsPerRequest) {
            return {
                allowed: false,
                reason: `Text exceeds maximum ${limits.summarize.maxWordsPerRequest} words for summarization`,
            };
        }
        if (usage.summarizeCount >= limits.summarize.dailyLimit) {
            return { allowed: false, reason: "Daily summarize limit reached" };
        }
        return { allowed: true };
    }

    // Check Correct/Improve/Translate limits
    if (limits.correctImproveTranslate.period === "weekly") {
        const weeklyUsage = await getWeeklyWordUsage(userId);
        if (weeklyUsage + wordCount > limits.correctImproveTranslate.words) {
            return {
                allowed: false,
                reason: `Weekly word limit (${limits.correctImproveTranslate.words}) exceeded`,
            };
        }
    } else {
        // Daily limit
        const todayTotal =
            (usage.correctWords || 0) +
            (usage.improveWords || 0) +
            (usage.translateWords || 0);
        if (todayTotal + wordCount > limits.correctImproveTranslate.words) {
            return {
                allowed: false,
                reason: `Daily word limit (${limits.correctImproveTranslate.words}) exceeded`,
            };
        }
    }

    return { allowed: true };
}

/**
 * Server Action: Process text with AI (synchronous complete generation).
 * Internal settlement is server-authoritative and not directly callable by client.
 */
export async function processText(
    operation: AIOperation,
    text: string,
    options?: { operationId?: string }
): Promise<{ success: boolean; data?: string; error?: string }> {
    let user: SupabaseUser | null = null;
    let wordCount = 0;
    let tier: TierName | null = null;
    let reserved = false;
    const operationId = options?.operationId || `op_${crypto.randomUUID()}`;

    try {
        user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        wordCount = countWords(text);
        tier = await getUserTier(user.id);

        const requestHash = crypto
            .createHash("sha256")
            .update(`${user.id}:${operation}:direct:${text}`)
            .digest("hex");

        const reservation = await reserveAIQuota(user.id, operation, wordCount, tier, {
            operationId,
            fileId: "",
            requestHash,
        });

        if (!reservation.reserved) {
            return { success: false, error: reservation.reason };
        }

        reserved = true;

        const result = await processWithAI(operation, text, tier as Tier);

        await commitReservationService(operationId);

        return { success: true, data: result };

    } catch (error) {
        if (reserved) {
            await refundReservationService(operationId, "process_text_failure").catch(() => {});
        }
        console.error(`AI operation ${operation} failed:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "An error occurred",
        };
    }
}

/**
 * Server Action: Get remaining quota for current user (read-only query).
 */
export async function getRemainingQuota(): Promise<{
    tier: TierName;
    correctImproveTranslate: { remaining: number; limit: number; period: string };
    summarize: { remaining: number; limit: number; maxWordsPerRequest: number };
    toPrompt: { remaining: number; limit: number } | null;
} | null> {
    try {
        const user = await getUser();
        if (!user) return null;

        // Self-healing: ensure authenticated user exists in DB before querying tier or usage
        try {
            const userEmail = user.email || `${user.id}@auth.local`;
            const displayName = (user.user_metadata?.full_name as string) || user.email?.split("@")[0] || "User";
            const avatarUrl = (user.user_metadata?.avatar_url as string) || null;

            await db.insert(schema.users).values({
                id: user.id,
                email: userEmail,
                displayName,
                avatarUrl,
                tier: "free",
            }).onConflictDoNothing();
        } catch {
            // Non-fatal if concurrency or conflict occurred
        }

        const tier = await getUserTier(user.id);
        const limits = TIER_LIMITS[tier];
        const usage = await getTodayUsage(user.id);

        let wordUsage: number;
        if (limits.correctImproveTranslate.period === "weekly") {
            wordUsage = await getWeeklyWordUsage(user.id);
        } else {
            wordUsage =
                (usage.correctWords || 0) +
                (usage.improveWords || 0) +
                (usage.translateWords || 0);
        }

        const wordsRemaining = Math.max(0, limits.correctImproveTranslate.words - wordUsage);
        const summarizeRemaining = Math.max(0, limits.summarize.dailyLimit - (usage.summarizeCount || 0));

        return {
            tier,
            correctImproveTranslate: {
                remaining: wordsRemaining,
                limit: limits.correctImproveTranslate.words,
                period: limits.correctImproveTranslate.period,
            },
            summarize: {
                remaining: summarizeRemaining,
                limit: limits.summarize.dailyLimit,
                maxWordsPerRequest: limits.summarize.maxWordsPerRequest,
            },
            toPrompt: limits.toPrompt
                ? {
                    remaining: Math.max(0, limits.toPrompt.dailyLimit - (usage.toPromptCount || 0)),
                    limit: limits.toPrompt.dailyLimit,
                }
                : null,
        };

    } catch (error) {
        console.error("Failed to get quota:", error);
        return null;
    }
}

/**
 * Query an AI reservation lifecycle status by operationId (read-only Server Action).
 * Enforces authenticated user ownership boundary.
 */
export async function getAIReservationStatus(operationId: string) {
    const user = await getUser();
    if (!user) {
        return { found: false as const, reason: "unauthorized" as const };
    }
    return getStatusFromService(operationId, user.id);
}
