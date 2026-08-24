/**
 * LIVE integration tests — AI quota reservation lifecycle (Phase 5 invariants).
 *
 * Runs the REAL production code paths from `@/server/actions/ai-ops` against
 * the isolated Neon test branch. No mocks. This is the live-evidence twin of
 * the fully-mocked contract suite `ai-quota-idempotency.test.ts`.
 *
 * Covered invariants:
 *  1. Reservation creates a row with UTC periodKey and increments usage once.
 *  2. Sequential replay with the same operationId is idempotent.
 *  3. CONCURRENT duplicate reservation (unique-constraint race) yields exactly
 *     ONE row and ONE deduction via speculative-increment reversal.
 *  4. reserved -> committed transition + already_committed replay; refund
 *     after commit refused.
 *  5. Refund restores usage counters exactly once; second refund no-ops.
 */
import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import {
    reserveAndUpdateUsage,
    commitAIReservation,
    refundAIReservation,
} from "@/server/actions/ai-ops";

// Placeholder-pattern UUID so guarded cleanup can never touch a real account.
const USER_ID = "55555555-5555-5555-5555-555555555555";

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function seed(): Promise<void> {
    await testDb
        .insert(schema.users)
        .values({ id: USER_ID, email: `${USER_ID}@live.test` })
        .onConflictDoNothing();
    // Fresh daily-usage slate regardless of prior runs.
    await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_ID));
}

async function getUsage() {
    const [row] = await testDb
        .select()
        .from(schema.usage)
        .where(
            and(
                eq(schema.usage.userId, USER_ID),
                eq(schema.usage.date, todayUtc())
            )
        );
    return row;
}

async function getReservations(operationId: string) {
    return testDb
        .select()
        .from(schema.aiReservations)
        .where(eq(schema.aiReservations.operationId, operationId));
}

afterAll(async () => {
    await cleanupTestUsers([USER_ID]);
});

describe("LIVE: AI quota reservation lifecycle on isolated branch", () => {
    it("reserves quota atomically: one row, one deduction, UTC periodKey", async () => {
        await seed();
        const res = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-1" }
        );

        expect(res.reserved).toBe(true);
        expect(res.periodKey).toBe(todayUtc());

        const rows = await getReservations("live-quota-1");
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe("reserved");
        expect(rows[0].reservedUnits).toBe(150);

        expect((await getUsage())?.improveWords).toBe(150);
    });

    it("sequential replay with same operationId is idempotent (no double deduction)", async () => {
        await seed();
        const first = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-replay" }
        );
        const replay = await reserveAndUpdateUsage(
            USER_ID,
            "improve",
            150,
            "pro",
            { operationId: "live-quota-replay" }
        );

        expect(first.reserved).toBe(true);
        expect(replay.reserved).toBe(true);
        expect(replay.reservationId).toBe(first.reservationId);
        expect(replay.periodKey).toBe(first.periodKey);

        expect(await getReservations("live-quota-replay")).toHaveLength(1);
        expect((await getUsage())?.improveWords).toBe(150);
    });

    it("CONCURRENT duplicate reservation: unique-constraint race → one row, ONE deduction", async () => {
        await seed();
        const results = await Promise.all([
            reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
                operationId: "live-quota-race",
            }),
            reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
                operationId: "live-quota-race",
            }),
        ]);

        // Exactly one reservation row survives the race.
        expect(await getReservations("live-quota-race")).toHaveLength(1);
        // The losing request's speculative increment must be reverted:
        // net deduction equals a single reservation only.
        expect((await getUsage())?.improveWords).toBe(150);
        // Both calls resolve without throwing (loser adopts winner's row).
        for (const r of results) {
            expect(r.reserved).toBe(true);
        }
    });

    it("commit transitions reserved->committed; replay is already_committed; post-commit refund refused", async () => {
        await seed();
        await reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
            operationId: "live-quota-commit",
        });

        const commit = await commitAIReservation("live-quota-commit");
        expect(commit.committed).toBe(true);

        const [row] = await getReservations("live-quota-commit");
        expect(row.status).toBe("committed");
        expect(row.committedUnits).toBe(150);

        const replay = await commitAIReservation("live-quota-commit");
        expect(replay.committed).toBe(true);
        expect(replay.reason).toBe("already_committed");

        const illegalRefund = await refundAIReservation(
            "live-quota-commit",
            "illegal_refund"
        );
        expect(illegalRefund.refunded).toBe(false);
        expect(illegalRefund.reason).toBe("already_committed");
        // Committed consumption must NOT be rolled back by a blind refund.
        expect((await getUsage())?.improveWords).toBe(150);
    });

    it("refund restores usage counters exactly once; second refund no-ops", async () => {
        await seed();
        await reserveAndUpdateUsage(USER_ID, "correct", 120, "pro", {
            operationId: "live-quota-refund",
        });
        expect((await getUsage())?.correctWords).toBe(120);

        const refund = await refundAIReservation("live-quota-refund");
        expect(refund.refunded).toBe(true);
        expect((await getUsage())?.correctWords).toBe(0);

        const [row] = await getReservations("live-quota-refund");
        expect(row.status).toBe("refunded");
        expect(row.refundedUnits).toBe(120);

        const second = await refundAIReservation("live-quota-refund");
        expect(second.refunded).toBe(false);
        expect(second.reason).toBe("already_refunded");
        expect((await getUsage())?.correctWords).toBe(0);
    });
});
