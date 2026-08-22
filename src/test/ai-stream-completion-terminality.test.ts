/**
 * Runtime Remediation Tests: AI Stream Terminality Guarantees
 *
 * Verifies the two classes of "stuck session / infinite loop" defects fixed in
 * `stream-handler.ts`:
 *
 * 1. Detached async completion: the completion callback performs the whole atomic
 *    commit pipeline asynchronously. A rejection inside it MUST be routed into
 *    onError (exactly one terminal callback) instead of becoming an unhandled
 *    promise rejection that leaves the session mutex permanently locked.
 *
 * 2. Provider stall watchdogs: a connection that never delivers a first byte must
 *    fail closed within the watchdog budget instead of hanging the editor session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { consumeAIStream, FIRST_CHUNK_TIMEOUT_MS } from "../lib/ai/stream-handler";

function ndjsonResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame + "\n"));
            }
            controller.close();
        },
    });
    return new Response(stream, { status: 200 });
}

function stalledResponse(): Response {
    // Never enqueues and never closes: simulates a provider socket that connects
    // but streams nothing (the historical cause of the invisible ghost preview).
    return new Response(
        new ReadableStream<Uint8Array>({ start() { /* intentionally idle */ } }),
        { status: 200 }
    );
}

describe("AI Stream Completion Terminality", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("routes async onComplete rejections into onError with a single terminal callback", async () => {
        const onComplete = vi.fn(async () => {
            throw new Error("commit pipeline failure");
        });
        const onError = vi.fn();
        const onChunk = vi.fn();

        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                ndjsonResponse([
                    JSON.stringify({ type: "start", sessionId: "s1", operationId: "op1" }),
                    JSON.stringify({ type: "chunk", text: "hello " }),
                    JSON.stringify({ type: "chunk", text: "world" }),
                    JSON.stringify({ type: "done" }),
                ])
            )
        );

        await consumeAIStream({
            operation: "improve",
            text: "input",
            onChunk,
            onComplete,
            onError,
        });

        // The completion pipeline runs a few microtasks after the consumer resolves;
        // wait on the ERROR side to guarantee the rejection chain has fully settled.
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(onComplete).toHaveBeenCalledWith("hello world");
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "commit pipeline failure" }));
    });

    it("emits no error when the async commit pipeline resolves cleanly", async () => {
        const onComplete = vi.fn(async () => {
            /* simulated successful server commit */
        });
        const onError = vi.fn();

        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                ndjsonResponse([JSON.stringify({ type: "chunk", text: "ok" }), JSON.stringify({ type: "done" })])
            )
        );

        await consumeAIStream({
            operation: "improve",
            text: "input",
            onChunk: () => {},
            onComplete,
            onError,
        });

        expect(onComplete).toHaveBeenCalledTimes(1);
        // Flush the deferred completion chain before asserting terminal silence.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).not.toHaveBeenCalled();
    });

    it("fails closed via the first-chunk watchdog when the provider stalls", async () => {
        vi.useFakeTimers();

        const onError = vi.fn();
        const onComplete = vi.fn();

        vi.stubGlobal("fetch", vi.fn(async () => stalledResponse()));

        const pending = consumeAIStream({
            operation: "improve",
            text: "input",
            onChunk: () => {},
            onComplete,
            onError,
        });

        await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS + 5);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining("AI_STREAM_FIRST_CHUNK_TIMEOUT") })
        );
        expect(onComplete).not.toHaveBeenCalled();

        // The consumer promise must settle without throwing.
        await expect(pending).resolves.toBeUndefined();
    });
});
