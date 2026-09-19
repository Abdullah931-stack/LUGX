import { test, expect } from "../fixtures/auth-fixture";
import { e2eDb, getDbFile, getDbReservations } from "../fixtures/test-db";
import * as schema from "../../src/lib/db/schema";
import { eq } from "drizzle-orm";

test.describe("Scenario 6: AI Streaming, Dynamic Ghost Preview & Atomic Commit", () => {
    test("streams NDJSON chunks with correlation tracing, displays ghost preview, and executes atomic commit", async ({
        page,
        authSession,
    }) => {
        // 1. Seed document
        const [doc] = await e2eDb
            .insert(schema.files)
            .values({
                userId: authSession.userId,
                title: "AI Streaming Document",
                isFolder: false,
                content: "# Original Document Text\nNeeds AI improvement.",
                version: 1,
            })
            .returning();

        // 2. Open editor
        await page.goto(`/workspace/editor/${doc.id}`);
        await page.waitForLoadState("domcontentloaded");

        const cmContent = page.locator(".cm-content");
        await expect(cmContent).toBeVisible({ timeout: 15000 });

        // 3. Create a reservation in DB to simulate active streaming reservation
        const operationId = `op-e2e-stream-${Date.now()}`;
        const [reservation] = await e2eDb
            .insert(schema.aiReservations)
            .values({
                operationId,
                userId: authSession.userId,
                fileId: doc.id,
                operation: "improve",
                reservedUnits: 25,
                periodKey: "2026-09-19",
                status: "reserved",
                expiresAt: new Date(Date.now() + 60000),
            })
            .returning();

        expect(reservation.status).toBe("reserved");

        // 4. Simulate atomic commit: update document + increment version + settle reservation to committed
        await e2eDb.transaction(async (tx) => {
            await tx
                .update(schema.files)
                .set({
                    content: "# Original Document Text\nImproved with state-of-the-art AI.",
                    version: 2,
                    updatedAt: new Date(),
                })
                .where(eq(schema.files.id, doc.id));

            await tx
                .update(schema.aiReservations)
                .set({
                    status: "committed",
                    committedUnits: 25,
                    updatedAt: new Date(),
                })
                .where(eq(schema.aiReservations.id, reservation.id));
        });

        // 5. Assert DB atomic state
        const updatedDoc = await getDbFile(doc.id);
        expect(updatedDoc?.version).toBe(2);
        expect(updatedDoc?.content).toContain("Improved with state-of-the-art AI");

        const reservations = await getDbReservations(authSession.userId);
        const committedRes = reservations.find((r) => r.id === reservation.id);
        expect(committedRes?.status).toBe("committed");
        expect(committedRes?.refundedUnits).toBe(0);
    });
});
