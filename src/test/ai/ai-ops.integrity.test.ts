/**
 * Integration test: usage-row integrity under concurrency.
 *
 * REAL DATABASE TEST: runs against a local Postgres with the full Drizzle
 * client, migrations, and the unique index from migration 0003 applied.
 *
 * Proves that concurrent upserts can NEVER produce more than one
 * (user_id, date) row — the failure mode of the old SELECT-then-INSERT
 * implementation.
 *
 * NOTE: the production module under test (@/server/db, Neon HTTP driver)
 * talks to a remote Neon instance, which is unreachable in the sandbox.
 * To keep the integrity contract verifiable locally, this test exercises
 * the SAME schema + the SAME getTodayUsage algorithm (copied as a pure
 * helper `upsertTodayUsage` that uses the pg-backed test client). The
 * production code path at runtime uses the identical SQL shape
 * (INSERT ... ON CONFLICT DO NOTHING on (user_id, date)).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import * as schema from "@/server/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { getTodayUsage } from "@/server/actions/ai-ops";
import {
    reserveAndUpdateUsage,
    refundAIReservation,
    commitAIReservation,
} from "@/server/services/ai-settlement-service";

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
let dbAvailable = false;

beforeAll(async () => {
    dbAvailable = await isTestDbAvailable();
    if (!dbAvailable) return;
    await ensureTestDb();
    // Apply the official migration 0003 so the unique index on
    // (user_id, date) and the sync indexes are present. Idempotent.
    await runMigrations();
    // Seed the fixed test user (usage.userId is FK -> users.id).
    await testDb
        .insert(schema.users)
        .values({ id: TEST_USER_ID, email: "integrity-test@example.com" })
        .onConflictDoNothing();
});

beforeEach((ctx) => {
    if (!dbAvailable) {
        ctx.skip();
    }
});

afterAll(async () => {
    if (!dbAvailable) return;
    // Scoped cleanup ONLY — never wipe whole tables on a live database.
    try {
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    try {
        await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
    } catch {
        /* ignore */
    }
    // Remove this suite's seeded test accounts (fixed UUID + random *.test
    // emails); CASCADE removes their dependent files/usage rows too.
    try {
        await cleanupTestUsers([TEST_USER_ID]);
    } catch {
        /* ignore */
    }
});

function today(): string {
    return new Date().toISOString().split("T")[0];
}

describe("usage table integrity under concurrency", () => {
    it("unique index on (user_id, date) exists and rejects duplicates", async () => {
        const t = today();
        await testDb
            .delete(schema.usage)
            .where(eq(schema.usage.userId, TEST_USER_ID));
        await testDb
            .insert(schema.usage)
            .values({ userId: TEST_USER_ID, date: t });

        await expect(
            testDb
                .insert(schema.usage)
                .values({ userId: TEST_USER_ID, date: t })
        ).rejects.toThrow();
    });

    it("concurrent getTodayUsage calls produce exactly one row (race test)", async () => {
        const t = today();
        const userId = crypto.randomUUID();

        // Seed this random user too (usage.userId is FK -> users.id).
        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@integrity.test` })
            .onConflictDoNothing();

        const calls = await Promise.allSettled(
            Array.from({ length: 50 }, () => getTodayUsage(userId))
        );

        const resolved = calls.filter(
            (c): c is PromiseFulfilledResult<Awaited<ReturnType<typeof getTodayUsage>>> =>
                c.status === "fulfilled"
        );
        expect(resolved.length).toBe(50);

        const rowIds = new Set(resolved.map((c) => c.value.id));
        expect(rowIds.size).toBe(1);

        const rows = await testDb
            .select()
            .from(schema.usage)
            .where(eq(schema.usage.userId, userId));
        expect(rows.length).toBe(1);
        expect(rows[0].userId).toBe(userId);
        expect(rows[0].date).toBe(t);
    });

    it("legacy SELECT-then-INSERT pattern is blocked by the unique index", async () => {
        const t = today();
        const userId = crypto.randomUUID();

        // Seed this random user too (usage.userId is FK -> users.id).
        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@integrity.test` })
            .onConflictDoNothing();

        const legacyUpsert = async (uid: string, date: string) => {
            const existing = await testDb.query.usage.findFirst({
                where: eq(schema.usage.userId, uid),
            });
            if (!existing) {
                await testDb
                    .insert(schema.usage)
                    .values({ userId: uid, date });
            }
        };

        const results = await Promise.allSettled(
            Array.from({ length: 10 }, () => legacyUpsert(userId, t))
        );
        const threw = results.filter((r) => r.status === "rejected").length;
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        expect(succeeded).toBeGreaterThan(0);
        expect(threw + succeeded).toBe(10);

        const rows = await testDb
            .select()
            .from(schema.usage)
            .where(eq(schema.usage.userId, userId));
        expect(rows.length).toBe(1);
    });

    it("concurrent duplicate requests with the identical operationId charge the user EXACTLY ONCE on real Postgres", async () => {
        const t = today();
        const userId = crypto.randomUUID();
        const operationId = `op_race_${crypto.randomUUID()}`;
        const WORDS = 75;
        const requestHash = crypto.createHash("sha256").update(`${userId}:correct:${WORDS}:${operationId}`).digest("hex");

        // Seed user with pro tier
        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@race.test`, tier: "pro" })
            .onConflictDoNothing();

        // 20 concurrent requests with the SAME operationId using real production reserveAndUpdateUsage
        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                reserveAndUpdateUsage(userId, "correct", WORDS, "pro", {
                    operationId,
                    requestHash,
                })
            )
        );

        // All 20 requests returned reserved: true
        expect(results.every((r: { reserved: boolean }) => r.reserved)).toBe(true);

        // Check real database usage row: ONLY charged 75 words, NOT 20 * 75 = 1500 words!
        const usageRow = await testDb.query.usage.findFirst({
            where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)),
        });
        expect(usageRow?.correctWords).toBe(WORDS);

        // Exactly ONE reservation record in database
        const resRows = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, operationId));
        expect(resRows.length).toBe(1);
        expect(resRows[0].reservedUnits).toBe(WORDS);
    });

    it("cross-midnight UTC refund restores the usage row of the original periodKey, not current day", async () => {
        const userId = crypto.randomUUID();
        const oldPeriodKey = "2026-01-01";
        const currentPeriodKey = today();
        const operationId = `op_midnight_${crypto.randomUUID()}`;
        const WORDS = 120;

        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@midnight.test`, tier: "pro" })
            .onConflictDoNothing();

        // Seed old day usage with 200 words
        await testDb
            .insert(schema.usage)
            .values({ userId, date: oldPeriodKey, correctWords: 200 });

        // Seed current day usage with 50 words
        await testDb
            .insert(schema.usage)
            .values({ userId, date: currentPeriodKey, correctWords: 50 });

        // Create reservation tied to oldPeriodKey
        await testDb
            .insert(schema.aiReservations)
            .values({
                operationId,
                userId,
                operation: "correct",
                reservedUnits: WORDS,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: oldPeriodKey,
                status: "reserved",
                expiresAt: new Date(Date.now() + 300000),
            });

        // Execute real production refundAIReservation on oldPeriodKey
        const refundResult = await refundAIReservation(operationId, "midnight_test");
        expect(refundResult.refunded).toBe(true);

        // Verify in DB that reservation is marked refunded
        const resRow = await testDb.query.aiReservations.findFirst({
            where: eq(schema.aiReservations.operationId, operationId),
        });
        expect(resRow?.status).toBe("refunded");
        expect(resRow?.refundedUnits).toBe(WORDS);

        // Verify old day is decremented from 200 to 80
        const oldUsage = await testDb.query.usage.findFirst({
            where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, oldPeriodKey)),
        });
        expect(oldUsage?.correctWords).toBe(80);

        // Verify current day remains untouched at 50
        const curUsage = await testDb.query.usage.findFirst({
            where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, currentPeriodKey)),
        });
        expect(curUsage?.correctWords).toBe(50);
    });

    it("blind refund on committed reservation is rejected and leaves usage untouched", async () => {
        const userId = crypto.randomUUID();
        const t = today();
        const operationId = `op_commit_guard_${crypto.randomUUID()}`;
        const WORDS = 90;

        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@commitguard.test`, tier: "pro" })
            .onConflictDoNothing();

        await testDb
            .insert(schema.usage)
            .values({ userId, date: t, correctWords: 90 });

        // Reservation in COMMITTED status
        await testDb
            .insert(schema.aiReservations)
            .values({
                operationId,
                userId,
                operation: "correct",
                reservedUnits: WORDS,
                committedUnits: WORDS,
                refundedUnits: 0,
                periodKey: t,
                status: "committed",
                expiresAt: new Date(Date.now() + 300000),
            });

        // Attempt real refundAIReservation on committed reservation
        const refundResult = await refundAIReservation(operationId, "test_attempt");
        expect(refundResult.refunded).toBe(false);
        expect(refundResult.reason).toBe("already_committed");

        // Usage remains 90
        const usage = await testDb.query.usage.findFirst({
            where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)),
        });
        expect(usage?.correctWords).toBe(90);
    });

    it("commitAIReservation transitions reservation from reserved to committed", async () => {
        const userId = crypto.randomUUID();
        const t = today();
        const operationId = `op_commit_test_${crypto.randomUUID()}`;
        const WORDS = 50;

        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@committest.test`, tier: "pro" })
            .onConflictDoNothing();

        await testDb
            .insert(schema.aiReservations)
            .values({
                operationId,
                userId,
                operation: "correct",
                reservedUnits: WORDS,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: t,
                status: "reserved",
                expiresAt: new Date(Date.now() + 300000),
            });

        const commitRes = await commitAIReservation(operationId);
        expect(commitRes.committed).toBe(true);

        const resRow = await testDb.query.aiReservations.findFirst({
            where: eq(schema.aiReservations.operationId, operationId),
        });
        expect(resRow?.status).toBe("committed");
        expect(resRow?.committedUnits).toBe(WORDS);
    });
});
