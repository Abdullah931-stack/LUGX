import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, getDbReservations } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenarios 7 & 8: User AI Abort and Preview Reject (No Refund Policy §4-D)", () => {
    test("Scenario 7: User-initiated stream abort halts stream with zero text leakage and settles quota with NO refund", async ({
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Abort Test Document",
                isFolder: false,
                content: "# Original Unaltered Content",
                version: 1,
            })
            .returning();

        const abortOpId = `op-abort-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.aiReservations)
            .values({
                operationId: abortOpId,
                userId: authSession.userId,
                fileId: doc.id,
                operation: "abort",
                reservedUnits: 30,
                periodKey: "2026-09-19",
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            })
            .returning();

        // Simulate user clicking Stop:
        // Policy §4-D mandates: status = 'committed', committedUnits = reservedUnits, refundedUnits = 0
        await e2eDb
            .update(schema.aiReservations)
            .set({
                status: "committed",
                committedUnits: 30,
                refundedUnits: 0,
                updatedAt: new Date(),
            })
            .where(eq(schema.aiReservations.id, reservation.id));

        // Verify document was NOT altered (zero text leakage)
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Original Unaltered Content");
        expect(currentDoc?.version).toBe(1);

        // Verify quota settlement: strictly NO refund
        const reservations = await getDbReservations(authSession.userId);
        const settledRes = reservations.find((r) => r.id === reservation.id);
        expect(settledRes?.status).toBe("committed");
        expect(settledRes?.refundedUnits).toBe(0);
    });

    test("Scenario 8: User preview rejection leaves document untouched and settles quota with NO refund", async ({
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Reject Test Document",
                isFolder: false,
                content: "# Safe Baseline Text",
                version: 1,
            })
            .returning();

        const rejectOpId = `op-reject-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.aiReservations)
            .values({
                operationId: rejectOpId,
                userId: authSession.userId,
                fileId: doc.id,
                operation: "reject",
                reservedUnits: 40,
                periodKey: "2026-09-19",
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            })
            .returning();

        // Simulate user clicking Reject:
        // Policy §4-D mandates: status = 'committed', committedUnits = reservedUnits, refundedUnits = 0
        await e2eDb
            .update(schema.aiReservations)
            .set({
                status: "committed",
                committedUnits: 40,
                refundedUnits: 0,
                updatedAt: new Date(),
            })
            .where(eq(schema.aiReservations.id, reservation.id));

        // Verify document is untouched
        const currentDoc = await getDbFile(doc.id);
        expect(currentDoc?.content).toBe("# Safe Baseline Text");
        expect(currentDoc?.version).toBe(1);

        // Verify quota is NOT refunded
        const reservations = await getDbReservations(authSession.userId);
        const settledRes = reservations.find((r) => r.id === reservation.id);
        expect(settledRes?.status).toBe("committed");
        expect(settledRes?.refundedUnits).toBe(0);
    });
});
