/**
 * LIVE integration tests — Sweeper cron route for stale AI reservations (TD-02)
 * against the isolated Neon test branch.
 *
 * Real boundaries:
 * 1. REAL PostgreSQL database tables (`ai_reservations`, `usage`, `users`).
 * 2. REAL authorization validation using process.env.CRON_SECRET.
 * 3. REAL batch expiration and refund calculation on the isolated branch.
 * 4. REAL idempotency verification (re-sweeping causes zero extra mutation).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { GET, POST } from "@/app/api/cron/expire-reservations/route";
import { randomUUID } from "node:crypto";

const USER_ID = "31313131-3131-3131-3131-313131313131";
const CRON_SECRET = "live-test-cron-secret-12345";

function today(): string {
    return new Date().toISOString().split("T")[0];
}

describe("LIVE: Cron sweeper for stale AI reservations on isolated branch", () => {
    const originalEnv = process.env.CRON_SECRET;

    beforeAll(async () => {
        process.env.CRON_SECRET = CRON_SECRET;
        await testDb
            .insert(schema.users)
            .values({ id: USER_ID, email: `${USER_ID}@live.test`, tier: "pro" })
            .onConflictDoNothing();
    });

    afterAll(async () => {
        process.env.CRON_SECRET = originalEnv;
        try {
            await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_ID));
            await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_ID));
        } catch {
            /* ignore */
        }
        await cleanupTestUsers([USER_ID]);
    });

    beforeEach(async () => {
        // Clear any previous reservations and usage for this clean test run
        await testDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, USER_ID));
        await testDb.delete(schema.usage).where(eq(schema.usage.userId, USER_ID));
    });

    it("rejects unauthorized calls with HTTP 401 when Authorization header is missing or wrong", async () => {
        const noAuthReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
        });
        const res1 = await GET(noAuthReq);
        expect(res1.status).toBe(401);
        const body1 = await res1.json();
        expect(body1.success).toBe(false);
        expect(body1.error).toBe("Unauthorized");

        const wrongAuthReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
            headers: {
                Authorization: "Bearer wrong-secret-token",
            },
        });
        const res2 = await GET(wrongAuthReq);
        expect(res2.status).toBe(401);
    });

    it("expires stale reservations past their TTL and refunds consumed quota in real DB", async () => {
        const periodKey = today();
        const operationId = randomUUID();
        const fileId = randomUUID();

        // 1. Seed user file
        await testDb.insert(schema.files).values({
            id: fileId,
            userId: USER_ID,
            title: "Cron Sweeper File",
            content: "<p>Original content</p>",
            etag: "etag-cron-1",
        });

        // 2. Seed initial usage: 100 correct words used today
        await testDb.insert(schema.usage).values({
            userId: USER_ID,
            date: periodKey,
            correctWords: 100,
            improveWords: 0,
            translateWords: 0,
            summarizeCount: 0,
            summarizeWords: 0,
            toPromptCount: 0,
        });

        // 3. Seed an expired reservation: 40 units, expired 5 minutes ago
        const pastExpiresAt = new Date(Date.now() - 5 * 60 * 1000);
        await testDb.insert(schema.aiReservations).values({
            id: randomUUID(),
            userId: USER_ID,
            fileId,
            operationId,
            operation: "correct",
            status: "reserved",
            reservedUnits: 40,
            refundedUnits: 0,
            periodKey,
            expiresAt: pastExpiresAt,
        });

        // 4. Invoke cron route via GET with valid Bearer token
        const req = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${CRON_SECRET}`,
            },
        });

        const res = await GET(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.expiredCount).toBeGreaterThanOrEqual(1);

        // 5. Assert database row state in ai_reservations
        const [reservationRow] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, operationId));
        expect(reservationRow.status).toBe("expired");
        expect(reservationRow.refundedUnits).toBe(40);

        // 6. Assert usage table refunded: 100 - 40 = 60 correct words
        const [usageRow] = await testDb
            .select()
            .from(schema.usage)
            .where(
                and(
                    eq(schema.usage.userId, USER_ID),
                    eq(schema.usage.date, periodKey)
                )
            );
        expect(usageRow.correctWords).toBe(60);

        // 7. Idempotency test: Immediate second run finds zero stale reservations for this op
        const resRepeat = await GET(req);
        expect(resRepeat.status).toBe(200);
        const [usageRowAfter] = await testDb
            .select()
            .from(schema.usage)
            .where(
                and(
                    eq(schema.usage.userId, USER_ID),
                    eq(schema.usage.date, periodKey)
                )
            );
        expect(usageRowAfter.correctWords).toBe(60); // Zero additional refund or mutation
    });

    it("POST handler is identical to GET handler and functions identically", async () => {
        const postReq = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${CRON_SECRET}`,
            },
        });

        const res = await POST(postReq);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
    });
});
