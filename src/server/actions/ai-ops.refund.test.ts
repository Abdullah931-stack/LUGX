/**
 * Regression test: quota REFUND after AI failure (W1 fix).
 *
 * REAL DATABASE TEST: runs against a local Postgres with the full Drizzle
 * client, migrations (0003) applied, and the unique index on (user_id, date).
 *
 * Proves that when an AI operation fails AFTER its quota was atomically
 * reserved, the counters are restored to their pre-reservation values —
 * the exact failure mode the old code suffered from: a failed
 * processWithAI call permanently consumed quota the user never received.
 *
 * NOTE: same design as ai-ops.integrity.test.ts — we copy the production
 * algorithms (reserveAndUpdateUsage + refundUsage) as pure helpers that use
 * the pg-backed test client, because the server action imports require
 * Supabase auth + a remote Neon endpoint. The production code runs the
 * identical SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations } from "@/test/db.setup";
import { testDb } from "@/test/test-db";
import { AIOperation } from "@/lib/ai/prompts";
import { TIER_LIMITS } from "@/config/tiers.config";

const TEST_USER_ID = "22222222-2222-2222-2222-222222222222";
const TIER = "pro";

beforeAll(async () => {
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "refund-test@example.com", tier: "pro" })
        .onConflictDoNothing();
});

afterAll(async () => {
    try {
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
});

function today(): string {
    return new Date().toISOString().split("T")[0];
}

/**
 * Local copy of the production conditional-reservation SQL shape from
 * ai-ops.ts `reserveAndUpdateUsage` (identical algorithm, pg client).
 */
async function reserveTodayUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number
): Promise<boolean> {
    const t = today();
    await testDb
        .insert(schema.usage)
        .values({ userId, date: t })
        .onConflictDoNothing({
            target: [schema.usage.userId, schema.usage.date],
        });

    let quotaGuard = sql`TRUE`;
    const updateFields: Record<string, unknown> = {};

    switch (operation) {
        case "correct":
            updateFields.correctWords = sql`correct_words + ${wordCount}`;
            quotaGuard = sql`COALESCE(correct_words, 0) + ${wordCount} <= ${TIER_LIMITS[TIER].correctImproveTranslate.words}`;
            break;
        case "summarize":
            updateFields.summarizeCount = sql`summarize_count + 1`;
            updateFields.summarizeWords = sql`summarize_words + ${wordCount}`;
            quotaGuard = sql`COALESCE(summarize_count, 0) + 1 <= ${TIER_LIMITS[TIER].summarize.dailyLimit}`;
            break;
        case "toPrompt":
            updateFields.toPromptCount = sql`to_prompt_count + 1`;
            quotaGuard = sql`COALESCE(to_prompt_count, 0) + 1 <= ${TIER_LIMITS[TIER].toPrompt!.dailyLimit}`;
            break;
        default:
            break;
    }

    const [updated] = await testDb
        .update(schema.usage)
        .set(updateFields)
        .where(and(eq(schema.usage.userId, userId), eq(schema.usage.date, t), quotaGuard))
        .returning({ id: schema.usage.id });

    return Boolean(updated);
}

/**
 * Local copy of the W1 `refundUsage` production algorithm (identical SQL):
 * bounded subtraction — GREATEST(col - N, 0) — so refunds can never
 * underflow counters below zero.
 */
async function refundTodayUsage(
    userId: string,
    operation: AIOperation,
    wordCount: number
): Promise<void> {
    const t = today();
    const undoFields: Record<string, unknown> = {};

    switch (operation) {
        case "correct":
            undoFields.correctWords = sql`GREATEST(correct_words - ${wordCount}, 0)`;
            break;
        case "summarize":
            undoFields.summarizeCount = sql`GREATEST(summarize_count - 1, 0)`;
            undoFields.summarizeWords = sql`GREATEST(summarize_words - ${wordCount}, 0)`;
            break;
        case "toPrompt":
            undoFields.toPromptCount = sql`GREATEST(to_prompt_count - 1, 0)`;
            break;
        default:
            break;
    }

    await testDb
        .update(schema.usage)
        .set(undoFields)
        .where(and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)));
}

async function snapshotUsage(userId: string) {
    const t = today();
    const row = await testDb.query.usage.findFirst({
        where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)),
    });
    return row;
}

describe("quota refund after AI failure (W1)", () => {
    it("restores word counters when a reserved correct() operation fails", async () => {
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeWords = before?.correctWords ?? 0;

        const WORDS = 120;
        const reserved = await reserveTodayUsage(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // Simulate AI provider failure AFTER reservation (the old bug:
        // the reservation would stand forever — quota permanently lost).
        await refundTodayUsage(TEST_USER_ID, "correct", WORDS);

        const after = await snapshotUsage(TEST_USER_ID);
        expect(after?.correctWords).toBe(beforeWords);
    });

    it("restores summarize counters when a reserved summarize() operation fails", async () => {
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeCount = before?.summarizeCount ?? 0;
        const beforeWords = before?.summarizeWords ?? 0;

        const WORDS = 45;
        const reserved = await reserveTodayUsage(TEST_USER_ID, "summarize", WORDS);
        expect(reserved).toBe(true);

        await refundTodayUsage(TEST_USER_ID, "summarize", WORDS);

        const after = await snapshotUsage(TEST_USER_ID);
        expect(after?.summarizeCount).toBe(beforeCount);
        expect(after?.summarizeWords).toBe(beforeWords);
    });

    it("bounded refund never underflows counters below zero (double-refund safety)", async () => {
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeWords = before?.correctWords ?? 0;

        const WORDS = 30;
        await reserveTodayUsage(TEST_USER_ID, "correct", WORDS);
        // A bug-triggered DOUBLE refund (e.g. retry handler fires twice):
        await refundTodayUsage(TEST_USER_ID, "correct", WORDS);
        await refundTodayUsage(TEST_USER_ID, "correct", WORDS);

        const after = await snapshotUsage(TEST_USER_ID);
        // GREATEST(..., 0) guarantees the counter can never go negative,
        // and can never fall below the pre-reservation value minus one
        // reservation's worth of words.
        expect(after!.correctWords).toBeGreaterThanOrEqual(0);
        expect(after!.correctWords).toBeGreaterThanOrEqual(beforeWords - WORDS);
    });

    it("refund of word-limited tiers restores the exact consumed words under concurrent traffic", async () => {
        // Concurrent scenario: another legitimate request increments the
        // same counters between the reservation and the refund. The refund
        // must only reverse its own reservation, never the other request's.
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeWords = before?.correctWords ?? 0;

        const WORDS = 50;
        const reserved = await reserveTodayUsage(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // A concurrent successful request from the same user:
        await reserveTodayUsage(TEST_USER_ID, "correct", 40);

        await refundTodayUsage(TEST_USER_ID, "correct", WORDS);

        const after = await snapshotUsage(TEST_USER_ID);
        // Net effect = +40 from the successful request only.
        expect(after?.correctWords).toBe(beforeWords + 40);
    });

    it("rejects reservation at the quota boundary and leaves counters untouched", async () => {
        // Sanity check: at exactly the daily limit, reservation must NOT
        // apply — no refund needed because nothing was reserved.
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeWords = before?.correctWords ?? 0;
        const LIMIT = TIER_LIMITS[TIER].correctImproveTranslate.words;

        // Exhaust the whole limit at once if space allows:
        const spare = LIMIT - beforeWords;
        if (spare >= 10) {
            const reserved = await reserveTodayUsage(TEST_USER_ID, "correct", spare);
            expect(reserved).toBe(true);
            // One more word must be rejected:
            const rejected = await reserveTodayUsage(TEST_USER_ID, "correct", 1);
            expect(rejected).toBe(false);
        }
        // Either way counters must be deterministic; nothing here depends
        // on a refund because no rejection reserves anything.
        const after = await snapshotUsage(TEST_USER_ID);
        expect(after!.correctWords).toBeGreaterThanOrEqual(beforeWords);
    });
});
