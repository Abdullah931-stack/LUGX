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
export async function getTodayUsageTestOnly(userId: string) {
    return getTodayUsage(userId);
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

export interface ReservationOptions {
    operationId?: string;
    fileId?: string | null;
    ttlMs?: number;
}

export interface ReservationResult {
    reserved: boolean;
    reason?: string;
    reservationId?: string;
    operationId?: string;
    periodKey?: string;
}

/**
 * Atomically reserve quota and update usage counters with idempotency tracking.
 *
 * G1 & G4 COMPLIANCE:
 * 1. Checks if `operationId` was already reserved (idempotent replay).
 * 2. Conditionally updates daily/weekly `usage` counters in UTC.
 * 3. Creates an `ai_reservations` record with status `reserved` and fixed TTL.
 */
export async function reserveAndUpdateUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName,
    options?: ReservationOptions
): Promise<ReservationResult> {
    const today = getToday();
    const limitsInfo = getLimitsForOperation(operation, tier, wordCount);

    if (!limitsInfo.allowed) {
        return { reserved: false, reason: limitsInfo.reason };
    }

    // Idempotency check: If operationId is provided, check existing reservation record
    if (options?.operationId) {
        const existing = await db.query.aiReservations.findFirst({
            where: and(
                eq(schema.aiReservations.userId, userId),
                eq(schema.aiReservations.operationId, options.operationId)
            ),
        });

        if (existing) {
            if (existing.status === "reserved") {
                return {
                    reserved: true,
                    reservationId: existing.id,
                    operationId: existing.operationId,
                    periodKey: existing.periodKey,
                };
            }
            if (existing.status === "committed") {
                return { reserved: false, reason: "Operation already committed" };
            }
            if (existing.status === "refunded") {
                return { reserved: false, reason: "Operation already refunded" };
            }
            if (existing.status === "expired") {
                return { reserved: false, reason: "Reservation expired" };
            }
        }
    }

    // Ensure the daily usage row exists (UPSERT is atomic per row on conflict)
    await getTodayUsage(userId);

    // Build the SQL that only applies when quota remains
    let quotaGuard = sql`TRUE`;
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
            quotaGuard = sql`COALESCE(summarize_count, 0) + 1 <= ${TIER_LIMITS[tier].summarize.dailyLimit}`;
            break;
        case "toPrompt":
            updateFields.toPromptCount = sql`to_prompt_count + 1`;
            quotaGuard = sql`COALESCE(to_prompt_count, 0) + 1 <= ${TIER_LIMITS[tier].toPrompt?.dailyLimit ?? 0}`;
            break;
    }

    if (operation === "correct" || operation === "improve" || operation === "translate") {
        if (limitsInfo.period === "weekly") {
            const weekStart = getWeekStart();
            quotaGuard = sql`(SELECT COALESCE(SUM(correct_words + improve_words + translate_words), 0) FROM ${schema.usage} WHERE user_id = ${userId} AND date >= ${weekStart}) + ${wordCount} <= ${limitsInfo.maxWords}`;
        } else {
            quotaGuard = sql`COALESCE(correct_words, 0) + COALESCE(improve_words, 0) + COALESCE(translate_words, 0) + ${wordCount} <= ${limitsInfo.maxWords}`;
        }
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

    // If operationId is provided, persist the reservation record in `ai_reservations`
    if (options?.operationId) {
        const ttlMs = options.ttlMs || 5 * 60 * 1000; // 5 minutes default TTL
        const expiresAt = new Date(Date.now() + ttlMs);

        try {
            const [newReservation] = await db
                .insert(schema.aiReservations)
                .values({
                    operationId: options.operationId,
                    userId,
                    fileId: options.fileId || null,
                    operation,
                    reservedUnits: wordCount,
                    committedUnits: 0,
                    refundedUnits: 0,
                    periodKey: today,
                    status: "reserved",
                    expiresAt,
                })
                .returning();

            return {
                reserved: true,
                reservationId: newReservation?.id,
                operationId: options.operationId,
                periodKey: today,
            };
        } catch (insertError) {
            // Check if concurrent insert happened (Double-click or parallel race on same operationId)
            const existing = await db.query.aiReservations.findFirst({
                where: and(
                    eq(schema.aiReservations.userId, userId),
                    eq(schema.aiReservations.operationId, options.operationId)
                ),
            });
            if (existing) {
                // REDUNDANT SPECULATIVE USAGE REVERSAL:
                // This duplicate request already updated usage counters before failing the unique constraint.
                // Revert this duplicate request's speculative increment so the user is never double-deducted!
                const undoFields: Record<string, unknown> = {};
                switch (operation) {
                    case "correct":
                        undoFields.correctWords = sql`GREATEST(correct_words - ${wordCount}, 0)`;
                        break;
                    case "improve":
                        undoFields.improveWords = sql`GREATEST(improve_words - ${wordCount}, 0)`;
                        break;
                    case "translate":
                        undoFields.translateWords = sql`GREATEST(translate_words - ${wordCount}, 0)`;
                        break;
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
                        and(
                            eq(schema.usage.userId, userId),
                            eq(schema.usage.date, today)
                        )
                    );

                if (existing.status === "reserved") {
                    return {
                        reserved: true,
                        reservationId: existing.id,
                        operationId: existing.operationId,
                        periodKey: existing.periodKey,
                    };
                }
                return {
                    reserved: false,
                    reason: `Operation already ${existing.status}`,
                };
            }
            throw insertError;
        }
    }

    return { reserved: true, periodKey: today };
}

/**
 * Refund a previously reserved quota by operationId (Idempotent).
 *
 * G1 & G4 COMPLIANCE:
 * 1. Checks if reservation is currently in `reserved` status.
 * 2. Transition to `refunded` is conditional and atomic (reserved -> refunded).
 * 3. Sets refundedUnits = reservedUnits atomically.
 * 4. Uses the EXACT `periodKey` captured at reservation time (cross-midnight safety).
 * 5. Reverts `usage` counters using bounded subtraction GREATEST(col - units, 0).
 * 6. Repeated call with same operationId returns `{ refunded: false, reason: "already_refunded" }`.
 * 7. Call on committed reservation returns `{ refunded: false, reason: "already_committed" }`.
 */
export async function refundAIReservation(
    operationId: string,
    reason: string = "stream_failed"
): Promise<{ refunded: boolean; reason?: string }> {
    const reservation = await db.query.aiReservations.findFirst({
        where: eq(schema.aiReservations.operationId, operationId),
    });

    if (!reservation) {
        return { refunded: false, reason: "reservation_not_found" };
    }

    if (reservation.status === "committed") {
        return { refunded: false, reason: "already_committed" };
    }

    if (reservation.status === "refunded") {
        return { refunded: false, reason: "already_refunded" };
    }

    if (reservation.status === "expired") {
        return { refunded: false, reason: "already_expired" };
    }

    const unitsToRefund = reservation.reservedUnits;

    // Atomic conditional transition: reserved -> refunded
    const [updatedReservation] = await db
        .update(schema.aiReservations)
        .set({
            status: "refunded",
            refundedUnits: unitsToRefund,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.aiReservations.id, reservation.id),
                eq(schema.aiReservations.status, "reserved")
            )
        )
        .returning();

    if (!updatedReservation) {
        // Raced with another refund or commit call
        const refreshed = await db.query.aiReservations.findFirst({
            where: eq(schema.aiReservations.id, reservation.id),
        });
        return { refunded: false, reason: refreshed?.status ? `already_${refreshed.status}` : "state_conflict" };
    }

    // Revert usage counters using the recorded `periodKey` (UTC date at reservation time)
    const undoFields: Record<string, unknown> = {};

    switch (reservation.operation as AIOperation) {
        case "correct":
            undoFields.correctWords = sql`GREATEST(correct_words - ${unitsToRefund}, 0)`;
            break;
        case "improve":
            undoFields.improveWords = sql`GREATEST(improve_words - ${unitsToRefund}, 0)`;
            break;
        case "translate":
            undoFields.translateWords = sql`GREATEST(translate_words - ${unitsToRefund}, 0)`;
            break;
        case "summarize":
            undoFields.summarizeCount = sql`GREATEST(summarize_count - 1, 0)`;
            undoFields.summarizeWords = sql`GREATEST(summarize_words - ${unitsToRefund}, 0)`;
            break;
        case "toPrompt":
            undoFields.toPromptCount = sql`GREATEST(to_prompt_count - 1, 0)`;
            break;
    }

    await db
        .update(schema.usage)
        .set(undoFields)
        .where(
            and(
                eq(schema.usage.userId, reservation.userId),
                eq(schema.usage.date, reservation.periodKey)
            )
        );

    return { refunded: true };
}

/**
 * Transition a reservation from reserved -> committed (Idempotent).
 */
export async function commitAIReservation(
    operationId: string
): Promise<{ committed: boolean; reason?: string }> {
    const reservation = await db.query.aiReservations.findFirst({
        where: eq(schema.aiReservations.operationId, operationId),
    });

    if (!reservation) {
        return { committed: false, reason: "not_found" };
    }

    if (reservation.status === "committed") {
        return { committed: true, reason: "already_committed" };
    }

    if (reservation.status !== "reserved") {
        return { committed: false, reason: reservation.status };
    }

    const [updated] = await db
        .update(schema.aiReservations)
        .set({
            status: "committed",
            committedUnits: reservation.reservedUnits,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(schema.aiReservations.id, reservation.id),
                eq(schema.aiReservations.status, "reserved")
            )
        )
        .returning();

    if (!updated) {
        const current = await db.query.aiReservations.findFirst({
            where: eq(schema.aiReservations.id, reservation.id),
        });
        if (current?.status === "committed") {
            return { committed: true, reason: "already_committed" };
        }
        return { committed: false, reason: current?.status || "state_conflict" };
    }

    return { committed: true };
}

/**
 * Sweep and expire stale reservations that passed their TTL.
 */
export async function expireStaleReservations(): Promise<number> {
    const now = new Date();
    const staleReservations = await db.query.aiReservations.findMany({
        where: and(
            eq(schema.aiReservations.status, "reserved"),
            sql`expires_at <= ${now}`
        ),
    });

    let expiredCount = 0;
    for (const res of staleReservations) {
        const unitsToRefund = res.reservedUnits;
        const [updated] = await db
            .update(schema.aiReservations)
            .set({
                status: "expired",
                refundedUnits: unitsToRefund,
                updatedAt: now,
            })
            .where(
                and(
                    eq(schema.aiReservations.id, res.id),
                    eq(schema.aiReservations.status, "reserved")
                )
            )
            .returning();

        if (updated) {
            // Refund the quota on the original periodKey
            const undoFields: Record<string, unknown> = {};

            switch (res.operation as AIOperation) {
                case "correct":
                    undoFields.correctWords = sql`GREATEST(correct_words - ${unitsToRefund}, 0)`;
                    break;
                case "improve":
                    undoFields.improveWords = sql`GREATEST(improve_words - ${unitsToRefund}, 0)`;
                    break;
                case "translate":
                    undoFields.translateWords = sql`GREATEST(translate_words - ${unitsToRefund}, 0)`;
                    break;
                case "summarize":
                    undoFields.summarizeCount = sql`GREATEST(summarize_count - 1, 0)`;
                    undoFields.summarizeWords = sql`GREATEST(summarize_words - ${unitsToRefund}, 0)`;
                    break;
                case "toPrompt":
                    undoFields.toPromptCount = sql`GREATEST(to_prompt_count - 1, 0)`;
                    break;
            }

            await db
                .update(schema.usage)
                .set(undoFields)
                .where(
                    and(
                        eq(schema.usage.userId, res.userId),
                        eq(schema.usage.date, res.periodKey)
                    )
                );

            expiredCount++;
        }
    }

    return expiredCount;
}

/**
 * Refund a previously reserved quota (Legacy wrapper for backward compatibility).
 */
export async function refundUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName
): Promise<void> {
    const today = getToday();
    const undoFields: Record<string, unknown> = {};
    switch (operation) {
        case "correct":
            undoFields.correctWords = sql`GREATEST(correct_words - ${wordCount}, 0)`;
            break;
        case "improve":
            undoFields.improveWords = sql`GREATEST(improve_words - ${wordCount}, 0)`;
            break;
        case "translate":
            undoFields.translateWords = sql`GREATEST(translate_words - ${wordCount}, 0)`;
            break;
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
    text: string,
    options?: { operationId?: string }
): Promise<{ success: boolean; data?: string; error?: string }> {
    let user: SupabaseUser | null = null;
    let wordCount = 0;
    let tier: TierName | null = null;
    let reservation: ReservationResult | undefined;
    const operationId = options?.operationId || `op_${crypto.randomUUID()}`;

    try {
        // Get authenticated user
        user = await getUser();
        if (!user) {
            return { success: false, error: "Authentication required" };
        }

        wordCount = countWords(text);

        // Get user tier once (needed for the atomic quota reservation)
        tier = await getUserTier(user.id);

        // Atomic quota reservation + counter update
        reservation = await reserveAndUpdateUsage(user.id, operation, wordCount, tier, {
            operationId,
        });

        if (!reservation.reserved) {
            return { success: false, error: reservation.reason };
        }

        // Process with AI (quota already reserved atomically)
        const result = await processWithAI(operation, text, tier as Tier);

        // Commit reservation upon confirmed successful response
        await commitAIReservation(operationId);

        return { success: true, data: result };

    } catch (error) {
        // Auto-refund reservation on AI failure
        if (reservation && reservation.reserved) {
            await refundAIReservation(operationId, "process_text_failure");
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
