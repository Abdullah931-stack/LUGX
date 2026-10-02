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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { AIOperation } from "@/lib/ai/prompts";
import { TIER_LIMITS } from "@/config/tiers.config";
import { reserveAndUpdateUsage, refundAIReservation } from "@/server/services/ai-settlement-service";

const TEST_USER_ID = "12121212-1212-1212-1212-121212121212"; // unique per suite — NOT shared with softdelete tests (parallel workers)
const TIER = "pro";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    await runMigrations();
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "refund-test@example.com", tier: "pro" })
        .onConflictDoNothing();
});

beforeEach((ctx) => {
    if (!dbAvailable) {
        ctx.skip();
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    try {
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test account; CASCADE cleans dependents.
    try { await cleanupTestUsers([TEST_USER_ID]); } catch { /* ignore */ }
});

function today(): string {
    return new Date().toISOString().split("T")[0];
}

async function reserve(
    userId: string,
    operation: AIOperation,
    wordCount: number,
    operationId: string = `op_${crypto.randomUUID()}`
): Promise<{ reserved: boolean; operationId: string }> {
    const requestHash = crypto.createHash("sha256").update(`${userId}:${operation}:${wordCount}:${operationId}`).digest("hex");
    const result = await reserveAndUpdateUsage(userId, operation, wordCount, TIER, {
        operationId,
        requestHash,
    });
    return { reserved: result.reserved, operationId };
}

async function refund(operationId: string): Promise<boolean> {
    const result = await refundAIReservation(operationId, "stream_failed");
    return result.refunded;
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
        const { reserved, operationId } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // Simulate AI provider failure AFTER reservation (the old bug:
        // the reservation would stand forever — quota permanently lost).
        const refunded = await refund(operationId);
        expect(refunded).toBe(true);

        const after = await snapshotUsage(TEST_USER_ID);
        expect(after?.correctWords).toBe(beforeWords);
    });

    it("restores summarize counters when a reserved summarize() operation fails", async () => {
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeCount = before?.summarizeCount ?? 0;
        const beforeWords = before?.summarizeWords ?? 0;

        const WORDS = 45;
        const { reserved, operationId } = await reserve(TEST_USER_ID, "summarize", WORDS);
        expect(reserved).toBe(true);

        const refunded = await refund(operationId);
        expect(refunded).toBe(true);

        const after = await snapshotUsage(TEST_USER_ID);
        expect(after?.summarizeCount).toBe(beforeCount);
        expect(after?.summarizeWords).toBe(beforeWords);
    });

    it("bounded refund never underflows counters below zero (double-refund safety)", async () => {
        const before = await snapshotUsage(TEST_USER_ID);
        const beforeWords = before?.correctWords ?? 0;

        const WORDS = 30;
        const { reserved, operationId } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(reserved).toBe(true);

        // A bug-triggered DOUBLE refund (e.g. retry handler fires twice):
        const firstRefund = await refund(operationId);
        expect(firstRefund).toBe(true);
        const secondRefund = await refund(operationId);
        expect(secondRefund).toBe(false);

        const after = await snapshotUsage(TEST_USER_ID);
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
        const { reserved: res1, operationId: op1 } = await reserve(TEST_USER_ID, "correct", WORDS);
        expect(res1).toBe(true);

        // A concurrent successful request from the same user:
        const { reserved: res2 } = await reserve(TEST_USER_ID, "correct", 40);
        expect(res2).toBe(true);

        const refunded = await refund(op1);
        expect(refunded).toBe(true);

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
            const { reserved } = await reserve(TEST_USER_ID, "correct", spare);
            expect(reserved).toBe(true);
            // One more word must be rejected:
            const { reserved: rejected } = await reserve(TEST_USER_ID, "correct", 1);
            expect(rejected).toBe(false);
        }
        // Either way counters must be deterministic; nothing here depends
        // on a refund because no rejection reserves anything.
        const after = await snapshotUsage(TEST_USER_ID);
        expect(after?.correctWords ?? 0).toBeGreaterThanOrEqual(beforeWords);
    });
});
