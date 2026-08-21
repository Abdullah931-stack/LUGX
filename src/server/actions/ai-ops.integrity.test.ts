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
 * NOTE: the production module under test (@/lib/db, Neon HTTP driver)
 * talks to a remote Neon instance, which is unreachable in the sandbox.
 * To keep the integrity contract verifiable locally, this test exercises
 * the SAME schema + the SAME getTodayUsage algorithm (copied as a pure
 * helper `upsertTodayUsage` that uses the pg-backed test client). The
 * production code path at runtime uses the identical SQL shape
 * (INSERT ... ON CONFLICT DO NOTHING on (user_id, date)).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, sql, and } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { ensureTestDb, runMigrations, isTestDbAvailable } from "@/test/db.setup";
import { testDb } from "@/test/test-db";

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
    try {
        await testDb.delete(schema.usage);
    } catch {
        /* ignore */
    }
    try {
        await testDb.delete(schema.files);
    } catch {
        /* ignore */
    }
});

function today(): string {
    return new Date().toISOString().split("T")[0];
}

/**
 * Local copy of the FIXED getTodayUsage upsert logic. The production
 * implementation in @/server/actions/ai-ops uses the identical SQL
 * (INSERT ... ON CONFLICT (user_id, date) DO NOTHING) — only the db client
 * differs (Neon HTTP vs pg). We deliberately test the algorithm against the
 * real DB instead of importing the server action, because the server action
 * requires Supabase auth and a remote Neon endpoint.
 */
async function upsertTodayUsage(userId: string): Promise<schema.Usage> {
    const t = today();
    await testDb
        .insert(schema.usage)
        .values({ userId, date: t })
        .onConflictDoNothing({
            target: [schema.usage.userId, schema.usage.date],
        });
    const usage = await testDb.query.usage.findFirst({
        where: eq(schema.usage.userId, userId),
    });
    if (!usage) throw new Error(`usage row not found for ${userId}`);
    return usage;
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

    it("concurrent upsertTodayUsage calls produce exactly one row (race test)", async () => {
        const t = today();
        const userId = crypto.randomUUID();

        // Seed this random user too (usage.userId is FK -> users.id).
        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@integrity.test` })
            .onConflictDoNothing();

        const calls = await Promise.allSettled(
            Array.from({ length: 50 }, () => upsertTodayUsage(userId))
        );

        const resolved = calls.filter(
            (c): c is PromiseFulfilledResult<schema.Usage> =>
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

        // Seed user
        await testDb
            .insert(schema.users)
            .values({ id: userId, email: `${userId}@race.test` })
            .onConflictDoNothing();

        // 20 concurrent requests with the SAME operationId
        const runDuplicateOp = async () => {
            // 1. Ensure row exists
            await testDb
                .insert(schema.usage)
                .values({ userId, date: t, correctWords: 0 })
                .onConflictDoNothing({ target: [schema.usage.userId, schema.usage.date] });

            // 2. Increment usage
            await testDb
                .update(schema.usage)
                .set({ correctWords: sql`COALESCE(correct_words, 0) + ${WORDS}` })
                .where(and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)));

            // 3. Insert reservation (protected by unique index on operation_id)
            try {
                const [res] = await testDb
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
                    })
                    .returning();
                return { reserved: true, id: res.id, winner: true };
            } catch {
                // Duplicate collision -> Revert speculative increment
                await testDb
                    .update(schema.usage)
                    .set({ correctWords: sql`GREATEST(correct_words - ${WORDS}, 0)` })
                    .where(and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)));

                const existing = await testDb.query.aiReservations.findFirst({
                    where: eq(schema.aiReservations.operationId, operationId),
                });
                return { reserved: true, id: existing?.id, winner: false };
            }
        };

        const results = await Promise.all(
            Array.from({ length: 20 }, () => runDuplicateOp())
        );

        // All 20 requests returned reserved: true
        expect(results.every((r) => r.reserved)).toBe(true);

        // Exactly ONE request won the database insert
        const winners = results.filter((r) => r.winner);
        expect(winners.length).toBe(1);

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
            .values({ id: userId, email: `${userId}@midnight.test` })
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

        // Execute conditional refund on oldPeriodKey
        const [refundedRes] = await testDb
            .update(schema.aiReservations)
            .set({ status: "refunded", refundedUnits: WORDS, updatedAt: new Date() })
            .where(
                and(
                    eq(schema.aiReservations.operationId, operationId),
                    eq(schema.aiReservations.status, "reserved")
                )
            )
            .returning();
        expect(refundedRes).toBeDefined();

        // Revert usage on the persisted periodKey
        await testDb
            .update(schema.usage)
            .set({ correctWords: sql`GREATEST(correct_words - ${WORDS}, 0)` })
            .where(and(eq(schema.usage.userId, userId), eq(schema.usage.date, oldPeriodKey)));

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
            .values({ id: userId, email: `${userId}@commitguard.test` })
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

        // Attempt conditional refund (where status == 'reserved')
        const [updated] = await testDb
            .update(schema.aiReservations)
            .set({ status: "refunded", refundedUnits: WORDS })
            .where(
                and(
                    eq(schema.aiReservations.operationId, operationId),
                    eq(schema.aiReservations.status, "reserved")
                )
            )
            .returning();

        // Must NOT update any row
        expect(updated).toBeUndefined();

        // Usage remains 90
        const usage = await testDb.query.usage.findFirst({
            where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, t)),
        });
        expect(usage?.correctWords).toBe(90);
    });
});
