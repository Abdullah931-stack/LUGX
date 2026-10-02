/**
 * Cron Overlap & Concurrency Protection Test Suite (Phase 13)
 *
 * Verifies:
 * 1. Mutual exclusion between concurrent executions of /api/cron/expire-reservations.
 * 2. Mutual exclusion between concurrent executions of /api/cron/purge-deleted.
 * 3. Graceful degradation: blocked execution returns HTTP 200 with { skipped: true }.
 * 4. Lock release: subsequent executions succeed after prior holder releases.
 * 5. Strict CRON_SECRET authorization gating (401 on invalid/missing bearer token).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as expireReservationsGET } from "@/app/api/cron/expire-reservations/route";
import { GET as purgeDeletedGET, POST as purgeDeletedPOST } from "@/app/api/cron/purge-deleted/route";
import * as aiSettlement from "@/server/services/ai-settlement-service";
import { db } from "@/server/db";
import { acquireCronLock } from "@/lib/cron/lock";

vi.mock("@/server/services/ai-settlement-service", () => ({
    expireStaleReservations: vi.fn(),
}));

vi.mock("@/server/db", () => ({
    db: {
        execute: vi.fn(),
    },
}));

describe("Cron Overlap & Distributed Lock Protection Suite (Phase 13)", () => {
    const CRON_SECRET = "test-cron-secret-phase-13";
    const originalEnv = process.env.CRON_SECRET;

    beforeEach(() => {
        process.env.CRON_SECRET = CRON_SECRET;
        vi.clearAllMocks();
    });

    afterEach(() => {
        process.env.CRON_SECRET = originalEnv;
    });

    describe("acquireCronLock unit contract", () => {
        it("should acquire lock and prevent second holder for the same job until released", async () => {
            const jobName = `test-job-${Date.now()}`;
            const lock1 = await acquireCronLock(jobName, 60);
            expect(lock1.acquired).toBe(true);

            // Second attempt while lock1 is held
            const lock2 = await acquireCronLock(jobName, 60);
            expect(lock2.acquired).toBe(false);

            // Release lock1
            await lock1.release();

            // Third attempt after release must succeed
            const lock3 = await acquireCronLock(jobName, 60);
            expect(lock3.acquired).toBe(true);
            await lock3.release();
        });
    });

    describe("/api/cron/expire-reservations concurrency", () => {
        it("should allow only one execution when two requests arrive simultaneously and safely skip the second", async () => {
            // Simulate a task that takes 50ms to finish
            vi.mocked(aiSettlement.expireStaleReservations).mockImplementation(
                () => new Promise((resolve) => setTimeout(() => resolve(2), 50))
            );

            const req1 = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
                method: "GET",
                headers: { Authorization: `Bearer ${CRON_SECRET}` },
            });
            const req2 = new NextRequest("http://localhost:3000/api/cron/expire-reservations", {
                method: "GET",
                headers: { Authorization: `Bearer ${CRON_SECRET}` },
            });

            const [res1, res2] = await Promise.all([
                expireReservationsGET(req1),
                expireReservationsGET(req2),
            ]);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);

            const data1 = await res1.json();
            const data2 = await res2.json();

            const oneExecuted = (data1.expiredCount === 2 && data2.skipped === true) ||
                                (data2.expiredCount === 2 && data1.skipped === true);
            expect(oneExecuted).toBe(true);

            // aiSettlement.expireStaleReservations should be called exactly once
            expect(aiSettlement.expireStaleReservations).toHaveBeenCalledTimes(1);
        });
    });

    describe("/api/cron/purge-deleted concurrency & auth", () => {
        it("should reject unauthorized requests with HTTP 401 on both GET and POST", async () => {
            const noAuthReq = new NextRequest("http://localhost:3000/api/cron/purge-deleted", {
                method: "POST",
            });
            const wrongAuthReq = new NextRequest("http://localhost:3000/api/cron/purge-deleted", {
                method: "GET",
                headers: { Authorization: "Bearer bad-token" },
            });

            const res1 = await purgeDeletedPOST(noAuthReq);
            const res2 = await purgeDeletedGET(wrongAuthReq);

            expect(res1.status).toBe(401);
            expect(res2.status).toBe(401);
        });

        it("should allow only one execution when two purge requests arrive simultaneously", async () => {
            vi.mocked(db.execute).mockImplementation(
                (() => new Promise((resolve) => setTimeout(() => resolve({ rowCount: 15 }), 50))) as never
            );

            const req1 = new NextRequest("http://localhost:3000/api/cron/purge-deleted", {
                method: "POST",
                headers: { Authorization: `Bearer ${CRON_SECRET}` },
            });
            const req2 = new NextRequest("http://localhost:3000/api/cron/purge-deleted", {
                method: "POST",
                headers: { Authorization: `Bearer ${CRON_SECRET}` },
            });

            const [res1, res2] = await Promise.all([
                purgeDeletedPOST(req1),
                purgeDeletedPOST(req2),
            ]);

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);

            const data1 = await res1.json();
            const data2 = await res2.json();

            const oneExecuted = (data1.deleted === 15 && data2.skipped === true) ||
                                (data2.deleted === 15 && data1.skipped === true);
            expect(oneExecuted).toBe(true);

            expect(db.execute).toHaveBeenCalledTimes(1);
        });
    });
});
