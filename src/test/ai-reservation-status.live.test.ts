/**
 * LIVE integration tests - getAIReservationStatus ownership and lifecycle reads
 * (Phase 11 closure evidence) against the ISOLATED Neon test branch. No mocks
 * except the Supabase session user (the only mocked boundary, matching the
 * established live-suite convention).
 *
 * Covered invariants:
 * 1. Reserved operation: full authoritative snapshot for its owner.
 * 2. After commitAIReservation: status reflects the committed transition.
 * 3. Cross-user denial: another session user gets not_found (no leakage).
 * 4. Unknown operationId: not_found.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import {
    reserveAndUpdateUsage,
    commitAIReservation,
    getAIReservationStatus,
} from "@/server/actions/ai-ops";
import { getUser } from "@/lib/supabase/server";

const { USER_ID, OTHER_USER_ID } = vi.hoisted(() => ({
    USER_ID: "66666666-6666-6666-6666-666666666666",
    OTHER_USER_ID: "77777777-7777-7777-7777-777777777777",
}));

vi.mock("@/lib/supabase/server", () => ({
    getUser: vi.fn(),
}));

const OPERATION_ID = "live-res-status-1";
const todayUtc = () => new Date().toISOString().slice(0, 10);

async function seed(): Promise<void> {
    await testDb
        .insert(schema.users)
        .values([
            { id: USER_ID, email: USER_ID + "@live.test" },
            { id: OTHER_USER_ID, email: OTHER_USER_ID + "@live.test" },
        ])
        .onConflictDoNothing();
}

beforeEach(async () => {
    vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
});

afterAll(async () => {
    await cleanupTestUsers([USER_ID, OTHER_USER_ID]);
});

describe("LIVE: getAIReservationStatus on isolated branch (Phase 11)", () => {
    it("returns the full authoritative snapshot of a reserved operation to its owner", async () => {
        await seed();
        const reserved = await reserveAndUpdateUsage(USER_ID, "improve", 150, "pro", {
            operationId: OPERATION_ID,
        });
        expect(reserved.reserved).toBe(true);

        const status = await getAIReservationStatus(OPERATION_ID);
        expect(status.found).toBe(true);
        if (!status.found) throw new Error("expected found=true");
        expect(status.status).toBe("reserved");
        expect(status.operation).toBe("improve");
        expect(status.reservedUnits).toBe(150);
        expect(status.committedUnits).toBe(0);
        expect(status.refundedUnits).toBe(0);
        expect(status.periodKey).toBe(todayUtc());
    });

    it("reflects the committed transition after commitAIReservation", async () => {
        await seed();
        const commit = await commitAIReservation(OPERATION_ID);
        expect(commit.committed).toBe(true);

        const status = await getAIReservationStatus(OPERATION_ID);
        expect(status.found).toBe(true);
        if (!status.found) throw new Error("expected found=true");
        expect(status.status).toBe("committed");
        expect(status.committedUnits).toBe(150);
    });

    it("denies a cross-user read: another session user gets not_found", async () => {
        await seed();
        vi.mocked(getUser).mockResolvedValueOnce({ id: OTHER_USER_ID } as never);

        const status = await getAIReservationStatus(OPERATION_ID);
        expect(status).toEqual({ found: false, reason: "not_found" });
    });

    it("returns not_found for an unknown operationId", async () => {
        const status = await getAIReservationStatus("live-res-status-does-not-exist");
        expect(status).toEqual({ found: false, reason: "not_found" });
    });
});
