import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeRequestHash, reserveAIQuota } from "@/server/services/ai-settlement-service";
import { NextRequest } from "next/server";
import { POST as aiStreamRoute } from "@/app/api/ai/stream/route";

const mockGetUser = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
    query: {
        users: { findFirst: vi.fn() },
        files: { findFirst: vi.fn() },
        usage: { findFirst: vi.fn() },
        aiReservations: { findFirst: vi.fn() },
        userVaultProfiles: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({
        values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => Promise.resolve()),
            returning: vi.fn(() => Promise.resolve([{ id: "res-new" }])),
        })),
    })),
    update: vi.fn(() => ({
        set: vi.fn(() => ({
            where: vi.fn(() => ({
                returning: vi.fn(() => Promise.resolve([{ id: "usage-1" }])),
            })),
        })),
    })),
}));

vi.mock("@/lib/supabase/server", () => ({
    getUser: mockGetUser,
}));

vi.mock("@/server/db", () => ({
    db: mockDb,
    schema: {
        users: { id: "id" },
        files: { id: "id", userId: "user_id", isEncrypted: "is_encrypted", deletedAt: "deleted_at" },
        usage: { id: "id", userId: "user_id", date: "date" },
        aiReservations: { id: "id", operationId: "operation_id", userId: "user_id", status: "status" },
        userVaultProfiles: { userId: "user_id" },
    },
}));

vi.mock("@/server/db/transactional", () => ({
    txDb: null,
}));

vi.mock("@/lib/rate-limit", () => ({
    aiStreamRateLimiter: {
        limit: vi.fn().mockResolvedValue({ success: true, remaining: 10, reset: 60 }),
    },
    addRateLimitHeaders: vi.fn(),
    rateLimitExceededResponse: vi.fn(),
}));

vi.mock("@/lib/ai/client", () => ({
    streamWithAI: vi.fn().mockResolvedValue(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("Hello"));
                controller.close();
            },
        })
    ),
    processWithAI: vi.fn().mockResolvedValue("Hello"),
}));

describe("Phase 11: Replay Attack Defense & Request Fingerprint Validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("computes deterministic SHA-256 fingerprint from (userId, operation, fileId, text)", () => {
        const hash1 = computeRequestHash("u1", "correct", "f1", "Hello World");
        const hash2 = computeRequestHash("u1", "correct", "f1", "Hello World");
        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64);

        // Divergent prompt produces distinct hash
        const hashDivergent = computeRequestHash("u1", "correct", "f1", "Hello Divergent");
        expect(hash1).not.toBe(hashDivergent);

        // Divergent user produces distinct hash
        const hashUser = computeRequestHash("u2", "correct", "f1", "Hello World");
        expect(hash1).not.toBe(hashUser);

        // Divergent operation produces distinct hash
        const hashOp = computeRequestHash("u1", "improve", "f1", "Hello World");
        expect(hash1).not.toBe(hashOp);
    });

    it("rejects reservation when operationId is reused with a divergent requestHash", async () => {
        const operationId = "op-replay-1";
        const legitimateHash = computeRequestHash("u1", "correct", "f1", "Original Text");
        const maliciousHash = computeRequestHash("u1", "correct", "f1", "Tampered Text");

        // Existing reservation has legitimateHash
        mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({
            id: "res-1",
            operationId,
            userId: "u1",
            fileId: "f1",
            requestHash: legitimateHash,
            status: "reserved",
            periodKey: "2026-10-02",
        });

        const result = await reserveAIQuota("u1", "correct", 10, "free", {
            operationId,
            fileId: "f1",
            requestHash: maliciousHash,
        });

        expect(result.reserved).toBe(false);
        expect(result.isReplayConflict).toBe(true);
        expect(result.reason).toContain("Replay attack detected");
    });

    it("returns HTTP 409 Conflict when client submits conflicting operationId in stream route", async () => {
        mockGetUser.mockResolvedValueOnce({ id: "user_test_replay" });
        mockDb.query.files.findFirst.mockResolvedValueOnce({
            id: "f_test",
            userId: "user_test_replay",
            isEncrypted: false,
        });

        // Simulate existing reservation with different requestHash
        mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({
            id: "res-exist",
            operationId: "op_fixed_123",
            userId: "user_test_replay",
            fileId: "f_test",
            requestHash: "different_hash_from_past_request",
            status: "reserved",
        });

        const req = new NextRequest("http://localhost/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                operationId: "op_fixed_123",
                fileId: "f_test",
                operation: "correct",
                text: "Attacker payload trying to reuse operationId",
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(409);
        const resText = await res.text();
        expect(resText).toContain("Replay attack detected");
    });
});
