import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetUser = vi.hoisted(() => vi.fn());
const mockCommitAIReservation = vi.hoisted(() => vi.fn());
const mockRefundAIReservation = vi.hoisted(() => vi.fn());
const mockReserveAIQuota = vi.hoisted(() => vi.fn());
const mockStreamWithAI = vi.hoisted(() => vi.fn());

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

vi.mock("@/server/services/ai-settlement-service", () => ({
    getUserTier: vi.fn().mockResolvedValue("free"),
    reserveAIQuota: mockReserveAIQuota,
    commitAIReservation: mockCommitAIReservation,
    refundAIReservation: mockRefundAIReservation,
    computeRequestHash: vi.fn().mockReturnValue("hash_123"),
}));

vi.mock("@/lib/ai/client", () => ({
    streamWithAI: mockStreamWithAI,
    processWithAI: vi.fn(),
}));

import { POST as aiStreamRoute } from "@/app/api/ai/stream/route";

describe("Phase 11: Authoritative Server-Side Stream Settlement", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        mockGetUser.mockResolvedValue({ id: "user_test_1" });
        mockDb.query.users.findFirst.mockResolvedValue({ id: "user_test_1", tier: "free" });
        mockDb.query.files.findFirst.mockResolvedValue({
            id: "file_test_1",
            userId: "user_test_1",
            isEncrypted: false,
        });

        mockReserveAIQuota.mockResolvedValue({
            reserved: true,
            reservationId: "res_abc_123",
            wordCount: 15,
        });
        mockCommitAIReservation.mockResolvedValue({ committed: true });
        mockRefundAIReservation.mockResolvedValue({ refunded: true });
    });

    async function drainStream(res: Response): Promise<string[]> {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const frames: string[] = [];
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                if (line.trim()) frames.push(line.trim());
            }
        }
        if (buffer.trim()) frames.push(buffer.trim());
        return frames;
    }

    it("commits reservation server-side BEFORE the done frame on successful stream completion", async () => {
        const encoder = new TextEncoder();
        const fakeAiStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("Hello "));
                controller.enqueue(encoder.encode("world!"));
                controller.close();
            },
        });
        mockStreamWithAI.mockResolvedValue(fakeAiStream);

        const req = new NextRequest("http://localhost/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                operationId: "op_success_1",
                fileId: "file_test_1",
                operation: "correct",
                text: "Hello world test",
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainStream(res);
        expect(mockCommitAIReservation).toHaveBeenCalledWith("op_success_1");
        expect(mockRefundAIReservation).not.toHaveBeenCalled();

        // Ensure start, chunk, and done frames were emitted
        const parsed = frames.map(f => JSON.parse(f));
        expect(parsed[0].type).toBe("start");
        expect(parsed[parsed.length - 1].type).toBe("done");
    });

    it("refunds reservation when upstream AI fails pre-TTFT (before any tokens are produced)", async () => {
        const fakeAiStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.error(new Error("Upstream Gemini 500 error"));
            },
        });
        mockStreamWithAI.mockResolvedValue(fakeAiStream);

        const req = new NextRequest("http://localhost/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                operationId: "op_pre_ttft_fail",
                fileId: "file_test_1",
                operation: "improve",
                text: "Text to improve",
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainStream(res);
        expect(mockRefundAIReservation).toHaveBeenCalledWith("op_pre_ttft_fail", "mid_stream_failure_pre_ttft");
        expect(mockCommitAIReservation).not.toHaveBeenCalled();

        const parsed = frames.map(f => JSON.parse(f));
        const errorFrame = parsed.find(f => f.type === "error");
        expect(errorFrame).toBeDefined();
        expect(errorFrame.code).toBe("STREAM_INTERRUPTED");
    });

    it("commits reservation when upstream AI fails post-TTFT (after tokens were delivered to client)", async () => {
        const encoder = new TextEncoder();
        let pullCount = 0;
        const fakeAiStream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pullCount === 0) {
                    pullCount++;
                    controller.enqueue(encoder.encode("Partial tokens received"));
                } else {
                    controller.error(new Error("Connection reset by peer"));
                }
            },
        });
        mockStreamWithAI.mockResolvedValue(fakeAiStream);

        const req = new NextRequest("http://localhost/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                operationId: "op_post_ttft_fail",
                fileId: "file_test_1",
                operation: "improve",
                text: "Text to improve",
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);

        const frames = await drainStream(res);
        // Because TTFT was achieved (first chunk emitted), quota must be committed
        expect(mockCommitAIReservation).toHaveBeenCalledWith("op_post_ttft_fail");
        expect(mockRefundAIReservation).not.toHaveBeenCalled();

        const parsed = frames.map(f => JSON.parse(f));
        expect(parsed.some(f => f.type === "chunk")).toBe(true);
        expect(parsed.some(f => f.type === "error")).toBe(true);
    });

    it("executes autonomous refund when client cancels pre-TTFT via stream.cancel()", async () => {
        const fakeAiStream = new ReadableStream<Uint8Array>({
            start() {
                // Hang indefinitely without emitting any chunk
            },
        });
        mockStreamWithAI.mockResolvedValue(fakeAiStream);

        const req = new NextRequest("http://localhost/api/ai/stream", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                operationId: "op_cancel_pre_ttft",
                fileId: "file_test_1",
                operation: "translate",
                text: "Text to translate",
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);

        // Cancel the response body stream immediately (client disconnects pre-TTFT)
        await res.body!.cancel();

        expect(mockRefundAIReservation).toHaveBeenCalledWith(
            "op_cancel_pre_ttft",
            "disconnect_pre_generation_stream_cancelled"
        );
        expect(mockCommitAIReservation).not.toHaveBeenCalled();
    });
});
