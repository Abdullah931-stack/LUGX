import "server-only";

import { db } from "@/server/db";
import { txDb } from "@/server/db/transactional";
import * as schema from "@/server/db/schema";
import crypto from "node:crypto";
import { AIOperation } from "@/lib/ai/prompts";
import { TIER_LIMITS, TierName, isToPromptEnabled } from "@/config/tiers.config";
import { countWords } from "@/lib/utils";
import { eq, and, sql } from "drizzle-orm";

/**
 * Compute canonical deterministic request fingerprint for replay attack prevention.
 * Formula: sha256(userId + ":" + operation + ":" + fileId + ":" + text)
 */
export function computeRequestHash(
    userId: string,
    operation: string,
    fileId: string,
    text: string
): string {
    return crypto
        .createHash("sha256")
        .update(`${userId}:${operation}:${fileId}:${text}`)
        .digest("hex");
}

function getToday(): string {
    return new Date().toISOString().split("T")[0];
}

function getWeekStart(): string {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - dayOfWeek);
    return startOfWeek.toISOString().split("T")[0];
}

function getActiveDb() {
    return txDb && typeof txDb.transaction === "function" ? txDb : db;
}

export async function getUserTier(userId: string): Promise<TierName> {
    const user = await db.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { tier: true },
    });

    return (user?.tier as TierName) || "free";
}

export async function getTodayUsage(userId: string) {
    const today = getToday();

    const userExists = await db.query.users.findFirst({
        where: eq(schema.users.id, userId),
        columns: { id: true },
    });

    if (!userExists) {
        return {
            id: "",
            userId,
            date: today,
            correctWords: 0,
            improveWords: 0,
            translateWords: 0,
            summarizeCount: 0,
            summarizeWords: 0,
            toPromptCount: 0,
            createdAt: new Date(),
        };
    }

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
            })) ?? {
                id: "",
                userId,
                date: today,
                correctWords: 0,
                improveWords: 0,
                translateWords: 0,
                summarizeCount: 0,
                summarizeWords: 0,
                toPromptCount: 0,
                createdAt: new Date(),
            }
        );
    }

    return usage;
}

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

    return {
        maxWords: limits.correctImproveTranslate.words,
        period: limits.correctImproveTranslate.period,
        allowed: true,
    };
}

export interface ReserveAIQuotaOptions {
    operationId?: string;
    fileId?: string;
    requestHash?: string;
    ttlMs?: number;
}

export interface ReserveAIQuotaResult {
    reserved: boolean;
    reason?: string;
    reservationId?: string;
    operationId?: string;
    periodKey?: string;
    isReplayConflict?: boolean;
}

/**
 * Server-Authoritative atomic quota reservation with replay-attack protection.
 */
export async function reserveAIQuota(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tier: TierName,
    options?: ReserveAIQuotaOptions
): Promise<ReserveAIQuotaResult> {
    const operationId = options?.operationId || crypto.randomUUID();
    const fileId = options?.fileId || "f_default";
    const requestHash = options?.requestHash || computeRequestHash(userId, operation, fileId, "");
    const ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
    const today = getToday();
    const limitsInfo = getLimitsForOperation(operation, tier, wordCount);

    if (!limitsInfo.allowed) {
        return { reserved: false, reason: limitsInfo.reason };
    }

    const targetDb = getActiveDb();

    const executeReservation = async (client: typeof db): Promise<ReserveAIQuotaResult> => {
        // 1. Replay Attack & Idempotency Check
        const existing = await client.query.aiReservations.findFirst({
            where: eq(schema.aiReservations.operationId, operationId),
        });

        if (existing) {
            // Anti-Replay: Verify requestHash integrity
            if (existing.requestHash && existing.requestHash !== requestHash) {
                return {
                    reserved: false,
                    reason: "Replay attack detected: operationId reused with divergent payload",
                    isReplayConflict: true,
                };
            }

            // Verify user ownership
            if (existing.userId !== userId) {
                return {
                    reserved: false,
                    reason: "Unauthorized: operationId belongs to another account",
                    isReplayConflict: true,
                };
            }

            if (existing.status === "reserved") {
                return {
                    reserved: true,
                    reservationId: existing.id,
                    operationId: existing.operationId,
                    periodKey: existing.periodKey,
                };
            }

            if (existing.status === "committed") {
                return {
                    reserved: false,
                    reason: "Operation already committed",
                    isReplayConflict: true,
                };
            }

            if (existing.status === "refunded" || existing.status === "expired") {
                return {
                    reserved: false,
                    reason: `Operation already ${existing.status}`,
                    isReplayConflict: true,
                };
            }
        }

        // 2. Ensure daily usage record exists
        await getTodayUsage(userId);

        // 3. Construct bounded deduction guarded by available quota
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

        const [updated] = await client
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

        const expiresAt = new Date(Date.now() + ttlMs);

        const [newReservation] = await client
            .insert(schema.aiReservations)
            .values({
                operationId,
                userId,
                fileId: fileId || null,
                operation,
                reservedUnits: wordCount,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: today,
                status: "reserved",
                expiresAt,
                requestHash,
            })
            .returning();

        return {
            reserved: true,
            reservationId: newReservation?.id,
            operationId,
            periodKey: today,
        };
    };

    if (typeof targetDb.transaction === "function") {
        try {
            return await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<ReserveAIQuotaResult>) => Promise<ReserveAIQuotaResult>)(executeReservation);
        } catch (error) {
            // Concurrent race check on operationId
            const existing = await db.query.aiReservations.findFirst({
                where: eq(schema.aiReservations.operationId, operationId),
            });
            if (existing) {
                if (existing.requestHash && existing.requestHash !== requestHash) {
                    return {
                        reserved: false,
                        reason: "Replay attack detected: operationId reused with divergent payload",
                        isReplayConflict: true,
                    };
                }
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
                    isReplayConflict: true,
                };
            }
            throw error;
        }
    }

    return await executeReservation(db);
}

/**
 * Server-Authoritative commit: transitions reservation from reserved -> committed.
 * Idempotent: repeated calls safely return { committed: true, reason: "already_committed" }.
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
 * Server-Authoritative refund: reverts usage counters on the exact periodKey and transitions to refunded.
 */
export async function refundAIReservation(
    operationId: string,
    _reason: string = "stream_failed"
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
    const targetDb = getActiveDb();

    const executeRefund = async (client: typeof db): Promise<{ refunded: boolean; reason?: string }> => {
        const [updatedReservation] = await client
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
            const refreshed = await client.query.aiReservations.findFirst({
                where: eq(schema.aiReservations.id, reservation.id),
            });
            return { refunded: false, reason: refreshed?.status ? `already_${refreshed.status}` : "state_conflict" };
        }

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

        await client
            .update(schema.usage)
            .set(undoFields)
            .where(
                and(
                    eq(schema.usage.userId, reservation.userId),
                    eq(schema.usage.date, reservation.periodKey)
                )
            );

        return { refunded: true };
    };

    if (typeof targetDb.transaction === "function") {
        return await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<{ refunded: boolean; reason?: string }>) => Promise<{ refunded: boolean; reason?: string }>)(executeRefund);
    }

    return await executeRefund(db);
}

/**
 * Revert usage quota (unregistered legacy wrapper without reservation row).
 */
export async function refundUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number
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
 * Sweep and expire stale reservations that passed their TTL.
 */
export async function expireStaleReservations(): Promise<number> {
    const now = new Date();
    const staleReservations = await db.query.aiReservations.findMany({
        where: and(
            eq(schema.aiReservations.status, "reserved"),
            sql`expires_at <= ${now}`
        ),
        limit: 100,
    });

    let expiredCount = 0;
    const targetDb = getActiveDb();

    for (const res of staleReservations) {
        const unitsToRefund = res.reservedUnits;

        const executeExpireItem = async (client: typeof db): Promise<boolean> => {
            const [updated] = await client
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

                await client
                    .update(schema.usage)
                    .set(undoFields)
                    .where(
                        and(
                            eq(schema.usage.userId, res.userId),
                            eq(schema.usage.date, res.periodKey)
                        )
                    );

                return true;
            }
            return false;
        };

        const itemExpired = typeof targetDb.transaction === "function"
            ? await (targetDb.transaction as unknown as (cb: (tx: typeof db) => Promise<boolean>) => Promise<boolean>)(executeExpireItem)
            : await executeExpireItem(db);

        if (itemExpired) {
            expiredCount++;
        }
    }

    return expiredCount;
}

/**
 * Query an AI reservation lifecycle status by operationId (read-only).
 */
export async function getAIReservationStatus(
    operationId: string,
    userId?: string
): Promise<
    | {
          found: true;
          operationId: string;
          status: "reserved" | "committed" | "refunded" | "expired";
          operation: string;
          periodKey: string;
          reservedUnits: number;
          committedUnits: number;
          refundedUnits: number;
          expiresAt: string;
      }
    | { found: false; reason: "unauthorized" | "not_found" }
> {
    const whereConditions = [eq(schema.aiReservations.operationId, operationId)];
    if (userId) {
        whereConditions.push(eq(schema.aiReservations.userId, userId));
    }

    const reservation = await db.query.aiReservations.findFirst({
        where: and(...whereConditions),
    });

    if (!reservation) return { found: false, reason: "not_found" };

    return {
        found: true,
        operationId: reservation.operationId,
        status: reservation.status,
        operation: reservation.operation,
        periodKey: reservation.periodKey,
        reservedUnits: reservation.reservedUnits,
        committedUnits: reservation.committedUnits,
        refundedUnits: reservation.refundedUnits,
        expiresAt: reservation.expiresAt.toISOString(),
    };
}

/**
 * Convenient wrapper for reserving AI quota resolving user tier automatically.
 * Supports both 4-argument and 5-argument calls for backward compatibility.
 */
export async function reserveAndUpdateUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    tierOrOptions?: TierName | ReserveAIQuotaOptions,
    maybeOptions?: ReserveAIQuotaOptions
): Promise<ReserveAIQuotaResult> {
    let tier: TierName;
    let options: ReserveAIQuotaOptions | undefined;

    if (typeof tierOrOptions === "string") {
        tier = tierOrOptions as TierName;
        options = maybeOptions;
    } else {
        tier = await getUserTier(userId);
        options = tierOrOptions;
    }

    return reserveAIQuota(userId, operation, wordCount, tier, options);
}
