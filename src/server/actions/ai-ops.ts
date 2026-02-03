"use server";

import { db, schema } from "@/lib/db";
import { processWithAI, Tier } from "@/lib/ai/client";
import { AIOperation } from "@/lib/ai/prompts";
import { getUser } from "@/lib/supabase/server";
import { TIER_LIMITS, TierName, isToPromptEnabled } from "@/config/tiers.config";
import { countWords } from "@/lib/utils";
import { eq, and, sql } from "drizzle-orm";

// Get current date as string for usage tracking
function getToday(): string {
    return new Date().toISOString().split("T")[0];
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
 * Get user's tier from database
 */
export async function getUserTier(userId: string): Promise<TierName> {
    const user = await db.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { tier: true },
    });

    return (user?.tier as TierName) || "free";
}

/**
 * Get usage for today
 */
async function getTodayUsage(userId: string) {
    const today = getToday();

    let usage = await db.query.usage.findFirst({
        where: and(
            eq(schema.usage.userId, userId),
            eq(schema.usage.date, today)
        ),
    });

    // Create usage record if doesn't exist
    if (!usage) {
        const [newUsage] = await db
            .insert(schema.usage)
            .values({
                userId,
                date: today,
            })
            .returning();
        usage = newUsage;
    }

    return usage;
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
 * Check if user has quota for operation
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
    const operationsMap: Record<string, keyof typeof usage> = {
        correct: "correctWords",
        improve: "improveWords",
        translate: "translateWords",
    };

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
 * Update usage after successful operation
 */
export async function updateUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number
): Promise<void> {
    const today = getToday();

    const updateFields: Record<string, unknown> = {};

    switch (operation) {
        case "correct":
            updateFields.correctWords = sql`correct_words + ${wordCount}`;
            break;
        case "improve":
            updateFields.improveWords = sql`improve_words + ${wordCount}`;
            break;
        case "translate":
            updateFields.translateWords = sql`translate_words + ${wordCount}`;
            break;
        case "summarize":
            updateFields.summarizeCount = sql`summarize_count + 1`;
            updateFields.summarizeWords = sql`summarize_words + ${wordCount}`;
            break;
        case "toPrompt":
            updateFields.toPromptCount = sql`to_prompt_count + 1`;
            break;
    }

    await db
        .update(schema.usage)
        .set(updateFields)
        .where(
            and(
                eq(schema.usage.userId, userId),
                eq(schema.usage.date, today)
            )
        );
}

/**
 * Server Action: Process text with AI
 */
export async function processText(
    operation: AIOperation,
    text: string
): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
        // Get authenticated user
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        const wordCount = countWords(text);

        // Check quota
        const quotaCheck = await checkQuota(user.id, operation, wordCount);
        if (!quotaCheck.allowed) {
            return { success: false, error: quotaCheck.reason };
        }

        // Get user tier
        const tier = await getUserTier(user.id);

        // Process with AI
        const result = await processWithAI(operation, text, tier as Tier);

        // Update usage
        await updateUsage(user.id, operation, wordCount);

        return { success: true, data: result };

    } catch (error) {
        console.error(`AI operation ${operation} failed:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "An error occurred",
        };
    }
}

/**
 * Server Action: Get remaining quota for current user
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

        const tier = await getUserTier(user.id);
        const limits = TIER_LIMITS[tier];
        const usage = await getTodayUsage(user.id);

        // Get word usage based on period
        let wordUsage: number;
        if (limits.correctImproveTranslate.period === "weekly") {
            wordUsage = await getWeeklyWordUsage(user.id);
        } else {
            wordUsage =
                (usage.correctWords || 0) +
                (usage.improveWords || 0) +
                (usage.translateWords || 0);
        }

        // Calculate remaining quotas
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
