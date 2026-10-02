/**
 * Phase 7: PostgreSQL Schema, Migrations & Atomic Transactions Suite (LIVE).
 *
 * Remediates: LUGX-025, LUGX-026, LUGX-027, LUGX-030, LUGX-031, LUGX-068, LUGX-069, LUGX-141, LUGX-143.
 *
 * Real Verification:
 * 1. Composite Unique Constraint: Rejection of duplicate reservations with same (user_id, operation_id).
 * 2. 1:N Subscriptions: Single user can hold multiple subscription records keyed by stripe_subscription_id.
 * 3. Stripe Subscription ID Uniqueness: Prevents duplicate stripe_subscription_id across users.
 * 4. Zero Partial Writes (Atomic Rollback): Simulated mid-transaction failure rolls back usage updates completely.
 * 5. Atomic Quota Reservation & Request Hash: Persistence of SHA-256 request_hash and idempotent replay.
 * 6. Atomic Quota Refund: Simultaneous status transition and usage counter restoration within transactions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import * as schema from "@/server/db/schema";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import { txDb } from "@/server/db/transactional";
import { runMigrations } from "@/test/db.setup";
import { reserveAndUpdateUsage, refundAIReservation } from "@/server/services/ai-settlement-service";
import { upsertSubscription } from "@/server/actions/subscription-actions";

const USER_A_ID = "71717171-7171-7171-7171-717171717171";
const USER_B_ID = "72727272-7272-7272-7272-727272727272";

describe("Phase 7: PostgreSQL Schema & Atomic Transactions (Live)", () => {
    beforeAll(async () => {
        await runMigrations();
        await cleanupTestUsers([USER_A_ID, USER_B_ID]);

        // Seed test users
        await testDb.insert(schema.users).values([
            {
                id: USER_A_ID,
                email: "user_a_phase7@example.test",
                tier: "pro",
                stripeCustomerId: "cus_test_p7_a",
            },
            {
                id: USER_B_ID,
                email: "user_b_phase7@example.test",
                tier: "free",
                stripeCustomerId: "cus_test_p7_b",
            },
        ]);
    });

    afterAll(async () => {
        await cleanupTestUsers([USER_A_ID, USER_B_ID]);
    });

    beforeEach(async () => {
        // Clean dependent rows before each test
        await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_A_ID));
        await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_B_ID));
        await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_A_ID));
        await testDb.delete(schema.subscriptions).where(eq(schema.subscriptions.userId, USER_B_ID));
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_A_ID));
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_B_ID));
    });

    it("enforces composite unique constraint (user_id, operation_id) on ai_reservations (remediates LUGX-030)", async () => {
        const opId = "op_p7_race_check_1";
        const today = new Date().toISOString().split("T")[0];

        // First insertion should succeed
        await testDb.insert(schema.aiReservations).values({
            operationId: opId,
            userId: USER_A_ID,
            operation: "improve",
            reservedUnits: 150,
            committedUnits: 0,
            refundedUnits: 0,
            periodKey: today,
            status: "reserved",
            expiresAt: new Date(Date.now() + 60000),
            requestHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });

        // Second insertion with identical (user_id, operation_id) must be rejected by PostgreSQL constraint
        let insertErr: any;
        try {
            await testDb.insert(schema.aiReservations).values({
                operationId: opId,
                userId: USER_A_ID,
                operation: "improve",
                reservedUnits: 150,
                committedUnits: 0,
                refundedUnits: 0,
                periodKey: today,
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
                requestHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            });
        } catch (e) {
            insertErr = e;
        }

        expect(insertErr).toBeDefined();
        // Check for PG unique_violation error code 23505 or duplicate key message
        const fullErrMsg = `${insertErr.message} ${insertErr.cause?.message || ""} ${insertErr.code || insertErr.cause?.code || ""}`;
        expect(fullErrMsg).toMatch(/unique|duplicate key|23505|idx_ai_reservations_user_op/i);
    });

    it("allows 1:N multi-subscriptions per user and enforces stripe_subscription_id uniqueness (remediates LUGX-027)", async () => {
        const now = new Date();
        const end = new Date(Date.now() + 30 * 24 * 3600 * 1000);

        // 1. Insert first subscription for User A (e.g. canceled past tier)
        const res1 = await upsertSubscription(USER_A_ID, {
            stripeSubscriptionId: "sub_p7_hist_1",
            tier: "pro",
            status: "canceled",
            currentPeriodStart: now,
            currentPeriodEnd: end,
        });
        expect(res1.success).toBe(true);

        // 2. Insert second subscription for User A (active upgraded tier)
        const res2 = await upsertSubscription(USER_A_ID, {
            stripeSubscriptionId: "sub_p7_active_2",
            tier: "ultra",
            status: "active",
            currentPeriodStart: now,
            currentPeriodEnd: end,
        });
        expect(res2.success).toBe(true);

        // Verify user A now holds both subscription records (1:N allowed)
        const userSubs = await testDb
            .select()
            .from(schema.subscriptions)
            .where(eq(schema.subscriptions.userId, USER_A_ID));
        expect(userSubs).toHaveLength(2);

        // 3. Attempting to assign duplicate stripeSubscriptionId to User B must fail uniqueness
        let dupSubErr: any;
        try {
            await testDb.insert(schema.subscriptions).values({
                userId: USER_B_ID,
                stripeSubscriptionId: "sub_p7_active_2", // collision with User A
                tier: "ultra",
                status: "active",
                currentPeriodStart: now,
                currentPeriodEnd: end,
            });
        } catch (e) {
            dupSubErr = e;
        }

        expect(dupSubErr).toBeDefined();
        const fullDupMsg = `${dupSubErr.message} ${dupSubErr.cause?.message || ""} ${dupSubErr.code || dupSubErr.cause?.code || ""}`;
        expect(fullDupMsg).toMatch(/unique|duplicate key|23505|idx_subscriptions_stripe_id_unique/i);
    });

    it("executes interactive atomic rollback with zero partial writes upon transaction failure (remediates LUGX-030)", async () => {
        const today = new Date().toISOString().split("T")[0];

        // Seed initial usage row
        await testDb.insert(schema.usage).values({
            userId: USER_A_ID,
            date: today,
            improveWords: 50,
        });

        // Execute a transaction that mutates usage then throws an artificial mid-transaction exception
        const transactionAttempt = txDb.transaction(async (tx) => {
            // Step 1: deduct quota in usage
            await tx
                .update(schema.usage)
                .set({ improveWords: 200 })
                .where(and(eq(schema.usage.userId, USER_A_ID), eq(schema.usage.date, today)));

            // Step 2: insert reservation
            await tx.insert(schema.aiReservations).values({
                operationId: "op_p7_rollback_test",
                userId: USER_A_ID,
                operation: "improve",
                reservedUnits: 150,
                periodKey: today,
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
                requestHash: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
            });

            // Step 3: Trigger intentional error before commit
            throw new Error("Simulated mid-transaction failure for atomic rollback verification");
        });

        await expect(transactionAttempt).rejects.toThrow("Simulated mid-transaction failure");

        // Verify zero partial writes in usage: improveWords must STILL be 50
        const [usageRow] = await testDb
            .select()
            .from(schema.usage)
            .where(and(eq(schema.usage.userId, USER_A_ID), eq(schema.usage.date, today)));
        expect(usageRow.improveWords).toBe(50);

        // Verify reservation was NOT persisted
        const [resRow] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, "op_p7_rollback_test"));
        expect(resRow).toBeUndefined();
    });

    it("atomically reserves quota, persists request_hash, and supports idempotent replay (remediates LUGX-030, LUGX-031)", async () => {
        const opId = "op_p7_atomic_reserve_1";

        const reserveResult = await reserveAndUpdateUsage(USER_A_ID, "improve", 120, "pro", {
            operationId: opId,
        });

        expect(reserveResult.reserved).toBe(true);
        expect(reserveResult.operationId).toBe(opId);

        // Verify reservation record in database contains generated request_hash
        const [storedRes] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, opId));
        expect(storedRes).toBeDefined();
        expect(storedRes.reservedUnits).toBe(120);
        expect(storedRes.status).toBe("reserved");
        expect(storedRes.requestHash).toHaveLength(64); // Valid SHA-256

        // Replay with identical operationId should be idempotent without double-deduction
        const replayResult = await reserveAndUpdateUsage(USER_A_ID, "improve", 120, "pro", {
            operationId: opId,
        });
        expect(replayResult.reserved).toBe(true);
        expect(replayResult.reservationId).toBe(storedRes.id);

        const today = new Date().toISOString().split("T")[0];
        const [usageRow] = await testDb
            .select()
            .from(schema.usage)
            .where(and(eq(schema.usage.userId, USER_A_ID), eq(schema.usage.date, today)));
        expect(usageRow.improveWords).toBe(120); // Not 240!
    });

    it("atomically refunds quota and updates reservation status (remediates LUGX-030)", async () => {
        const opId = "op_p7_atomic_refund_1";

        await reserveAndUpdateUsage(USER_A_ID, "improve", 100, "pro", {
            operationId: opId,
        });

        const refundResult = await refundAIReservation(opId, "client_canceled");
        expect(refundResult.refunded).toBe(true);

        // Verify reservation status is refunded
        const [storedRes] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, opId));
        expect(storedRes.status).toBe("refunded");
        expect(storedRes.refundedUnits).toBe(100);

        // Verify usage counter was restored to 0
        const today = new Date().toISOString().split("T")[0];
        const [usageRow] = await testDb
            .select()
            .from(schema.usage)
            .where(and(eq(schema.usage.userId, USER_A_ID), eq(schema.usage.date, today)));
        expect(usageRow.improveWords).toBe(0);
    });
});
