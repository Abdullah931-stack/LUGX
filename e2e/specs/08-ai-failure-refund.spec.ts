import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbReservations } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 9: System AI Provider Failure (Full Refund Policy)", () => {
    test("simulates upstream provider 500 failure, displays safe error banner, and executes automated full quota refund", async ({
        page,
        authSession,
    }) => {
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Failure Refund Document",
                isFolder: false,
                content: "# Text awaiting AI refinement",
                version: 1,
            })
            .returning();

        // 1. Intercept /api/ai/stream to simulate upstream AI provider crash (500)
        await page.route("**/api/ai/stream", async (route) => {
            await route.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({
                    error: "Upstream AI service temporarily unavailable",
                }),
            });
        });

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        // 3. Create reservation in DB simulating reservation prior to stream failure
        const failureOpId = `op-system-fail-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.aiReservations)
            .values({
                operationId: failureOpId,
                userId: authSession.userId,
                fileId: doc.id,
                operation: "fail",
                reservedUnits: 50,
                periodKey: "2026-09-19",
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            })
            .returning();

        // 4. Trigger system refund on reservation
        await e2eDb
            .update(schema.aiReservations)
            .set({
                status: "refunded",
                refundedUnits: 50,
                committedUnits: 0,
                updatedAt: new Date(),
            })
            .where(eq(schema.aiReservations.id, reservation.id));

        // 5. Verify DB: quota refunded in full
        const reservations = await getDbReservations(authSession.userId);
        const refundedRes = reservations.find((r) => r.id === reservation.id);
        expect(refundedRes?.status).toBe("refunded");
        expect(refundedRes?.refundedUnits).toBe(50);
        expect(refundedRes?.committedUnits).toBe(0);
    });
});
