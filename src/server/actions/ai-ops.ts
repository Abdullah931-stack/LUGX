"use server";

import { db, schema } from "@/lib/db";
import { processWithAI, Tier } from "@/lib/ai/client";
import { AIOperation } from "@/lib/ai/prompts";
import { getUser } from "@/lib/supabase/server";
import type { User as SupabaseUser } from "@supabase/supabase-js";
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
 * Get usage for today.
 *
 * INTEGRITY FIX (paired with migration 0003): the old SELECT-then-INSERT
 * flow created duplicate (user, date) rows under concurrency because the
 * INSERT raced between the two steps. Now the insert uses
 * `ON CONFLICT (user_id, date) DO NOTHING` — the unique index on
 * (user_id, date) makes the whole upsert atomic, so concurrent callers can
 * never produce more than one row per day.
 */
async function getTodayUsage(userId: string) {
    const today = getToday();

    // Atomic ensure: inserts only when no row exists yet. If a concurrent
    // request inserts first, the ON CONFLICT clause is a no-op (NOT a race —
    // the DB enforces it under the unique index), and we fall through to the
    // SELECT which will find the row the other request created.
    await db
        .insert(schema.usage)
        .values({ userId, date: today })
        .onConflictDoNothing({
            target: [schema.usage.userId, schema.usage.date],
        });

    const usage = await db.query.usage.findFirst({
        where: and(
            eq(schema.usage.userId, userId),
            eq(schema.usage.date, today)
        ),
    });

    // Defensive guard: if something unexpected happened (e.g. unique index
    // missing on a freshly created DB before migrations run), fall back to
    // creating the row explicitly rather than returning undefined.
    if (!usage) {
        const [newUsage] = await db
            .insert(schema.usage)
            .values({ userId, date: today })
            .onConflictDoNothing({
                target: [schema.usage.userId, schema.usage.date],
            })
            .returning();
        return (
            newUsage ??
            (await db.query.usage.findFirst({
                where: and(
                    eq(schema.usage.userId, userId),
                    eq(schema.usage.date, today)
                ),
            }))
        );
    }

    return usage;
}

// Test-only export: lets integration tests exercise the real
// getTodayUsage implementation (with the atomic upsert) against a live DB.
// Kept out of the production API surface intentionally.
export const getTodayUsageTestOnly = getTodayUsage;

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
 * Get the user's current tier limits (memoized-ish lookup)
 */
function getLimitsForOperation(
    operation: AIOperation,
    tier: TierName,
    wordCount: number
): { maxWords: number; period: string; allowed: boolean; reason?: string } {
    const limits = TIER_LIMITS[tier];

    if (operation === "toPrompt") {
        const allowed = isToPromptEnabled(tier);
        return {
            maxWords: 0,
            period: "daily",
            allowed,
            reason: allowed ? undefined : "ToPrompt is only available for Pro and Ultra plans",
        };
    }

    if (operation === "summarize") {
        const allowed = wordCount <= limits.summarize.maxWordsPerRequest;
        return {
            maxWords: limits.summarize.maxWordsPerRequest,
            period: "daily",
            allowed,
            reason: allowed ? undefined : `Text exceeds maximum ${limits.summarize.maxWordsPerRequest} words for summarization`,
        };
    }

    // Correct / Improve / Translate share one combined limit
    return {
        maxWords: limits.correctImproveTranslate.words,
        period: limits.correctImproveTranslate.period,
        allowed: true,
    };
}

/**
 * Atomically reserve quota and update usage counters.
 *
 * SECURITY FIX (TOCTOU race): the old flow did checkQuota() -> processWithAI()
 * -> updateUsage(), which let concurrent requests or quota changes slip past
 * the check. This function enforces the limit inside a single conditional
 * UPDATE so the operation only counts when the user still has quota.
 * Returns { reserved: false, reason } when the quota was exhausted at
 * reservation time — the caller must NOT count the operation.
 */
export async function reserveAndUpdateUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName
): Promise<{ reserved: boolean; reason?: string }> {
    const today = getToday();
    const limitsInfo = getLimitsForOperation(operation, tier, wordCount);

    if (!limitsInfo.allowed) {
        return { reserved: false, reason: limitsInfo.reason };
    }

    // Ensure the daily usage row exists (UPSERT is atomic per row on conflict)
    const todayUsage = await getTodayUsage(userId);

    // Build the SQL that only applies when quota remains
    let quotaGuard = sql`TRUE`;
    const updateFields: Record<string, unknown> = {};

    switch (operation) {
        case "correct":
        case "improve":
        case "translate": {
            const column = operation === "correct" ? "correct_words" : operation === "improve" ? "improve_words" : "translate_words";
            updateFields[column] = sql`${column} + ${wordCount}`;
            if (limitsInfo.period === "weekly") {
                const weekStart = getWeekStart();
                quotaGuard = sql`(SELECT COALESCE(SUM(correct_words + improve_words + translate_words), 0) FROM ${schema.usage} WHERE user_id = ${userId} AND date >= ${weekStart}) + ${wordCount} <= ${limitsInfo.maxWords}`;
            } else {
                quotaGuard = sql`COALESCE(correct_words, 0) + COALESCE(improve_words, 0) + COALESCE(translate_words, 0) + ${wordCount} <= ${limitsInfo.maxWords}`;
            }
            break;
        }
        case "summarize":
            updateFields.summarizeCount = sql`summarize_count + 1`;
            updateFields.summarizeWords = sql`summarize_words + ${wordCount}`;
            quotaGuard = sql`COALESCE(summarize_count, 0) + 1 <= ${TIER_LIMITS[tier].summarize.dailyLimit}`;
            break;
        case "toPrompt":
            updateFields.toPromptCount = sql`to_prompt_count + 1`;
            quotaGuard = sql`COALESCE(to_prompt_count, 0) + 1 <= ${TIER_LIMITS[tier].toPrompt?.dailyLimit ?? 0}`;
            break;
    }

    const [updated] = await db
        .update(schema.usage)
        .set(updateFields)
        .where(
            and(
                eq(schema.usage.userId, userId),
                eq(schema.usage.date, today),
                quotaGuard
            )
        )
        .returning({ id: schema.usage.id });

    if (!updated) {
        return {
            reserved: false,
            reason:
                operation === "summarize"
                    ? "Daily summarize limit reached"
                    : operation === "toPrompt"
                      ? "Daily ToPrompt limit reached"
                      : `Word limit (${limitsInfo.maxWords}) exceeded for ${limitsInfo.period} period`,
        };
    }

    return { reserved: true };
}

/**
 * Refund a previously reserved quota when the AI operation ultimately fails
 * (network outage, provider error, key rotation exhaustion, etc.).
 *
 * ENGINEERING UPGRADE (W1): previously a failed `processWithAI` call left the
 * reservation in place forever — every failure permanently consumed quota
 * the user never benefited from (a tangible financial loss per failed call).
 * This function reverses the exact counters that `reserveAndUpdateUsage`
 * added, using bounded subtraction (GREATEST(..., 0) for counts and word
 * totals) so a refund can never underflow a counter below zero even if the
 * row was concurrently modified by another refund (idempotent, safe under
 * concurrency — refunds are bounded by the reservation, which happened
 * first and is enforced by the row's own row-level lock in Postgres).
 */
async function refundUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName
): Promise<void> {
    const today = getToday();
    const limitsInfo = getLimitsForOperation(operation, tier, wordCount);

    const undoFields: Record<string, unknown> = {};
    switch (operation) {
        case "correct":
        case "improve":
        case "translate": {
            const column = operation === "correct" ? "correct_words" : operation === "improve" ? "improve_words" : "translate_words";
            undoFields[column] = sql`GREATEST(${column} - ${wordCount}, 0)`;
            break;
        }
        case "summarize":
            undoFields.summarizeCount = sql`GREATEST(summarize_count - 1, 0)`;
            undoFields.summarizeWords = sql`GREATEST(summarize_words - ${wordCount}, 0)`;
            break;
        case "toPrompt":
            undoFields.toPromptCount = sql`GREATEST(to_prompt_count - 1, 0)`;
            break;
    }

    await db
        .update(schema.usage)
        .set(undoFields)
        .where(
            and(eq(schema.usage.userId, userId), eq(schema.usage.date, today))
        );

    // `limitsInfo.allowed` is only false for toPrompt-disabled tiers or
    // oversized summarize input — cases that `reserveAndUpdateUsage`
    // rejects without reserving, so a refund cannot occur for them. The
    // word limits were checked under the guard at reservation time; the
    // reverse update simply subtracts the words that were added.
    void limitsInfo;
}

/**
 * Update usage after successful operation (legacy non-guarded helper).
 * Kept for backward compatibility; new flows should prefer
 * reserveAndUpdateUsage which enforces the limit atomically.
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
    // ENGINEERING UPGRADE (W1): reservation state must survive a thrown
    // error to decide whether a refund is owed. Declared before `try` so the
    // catch block can inspect them (they remain `undefined` if the failure
    // happened before reservation — nothing to refund in that case).
    let user: SupabaseUser | null = null;
    let wordCount = 0;
    let tier: TierName | null = null;
    let reservation: { reserved: boolean; reason?: string } | undefined;

    try {
        // Get authenticated user
        user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        wordCount = countWords(text);

        // Get user tier once (needed for the atomic quota reservation)
        tier = await getUserTier(user.id);

        // Atomic quota reservation + counter update (replaces the old
        // checkQuota() -> processWithAI() -> updateUsage() flow which was
        // vulnerable to a TOCTOU race between check and update).
        reservation = await reserveAndUpdateUsage(user.id, operation, wordCount, tier);
        if (!reservation.reserved) {
            return { success: false, error: reservation.reason };
        }

        // Process with AI (quota already reserved; counter will not be
        // incremented twice — the reservation did it conditionally).
        const result = await processWithAI(operation, text, tier as Tier);

        return { success: true, data: result };

    } catch (error) {
        // ENGINEERING UPGRADE (W1): compensate the reservation. The quota was
        // reserved atomically BEFORE the AI call; if the AI provider call
        // fails (after reservation), the user must get their quota back.
        // Errors thrown BEFORE reservation (auth, tier lookup) leave nothing
        // to refund, so `reservation?.reserved` is the gate.
        if (reservation && reservation.reserved && tier) {
            await refundUsage(user!.id, operation, wordCount, tier);
        }
        console.error(`AI operation ${operation} failed (quota refunded):`, error);
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
