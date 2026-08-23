/**
 * Abort Signal Propagation Test
 *
 * Runtime remediation for the "infinite hang / invisible ghost preview" defect:
 * verifies that `streamWithAI` forwards the downstream AbortSignal into the Gemini
 * SDK request options so user cancellation and client disconnects terminate the
 * upstream provider socket instead of leaving the server pinned until the model
 * finishes generating on its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
    let capturedRequestOptions: unknown;
    const generateContentStream = vi.fn(async (_request: unknown, requestOptions?: unknown) => {
        capturedRequestOptions = requestOptions;
        async function* singleChunk(): AsyncGenerator<{ text: () => string }> {
            yield { text: () => "chunk-1" };
        }
        return {
            stream: singleChunk(),
            response: Promise.resolve({}),
        };
    });

    return {
        generateContentStream,
        get lastRequestOptions() {
            return capturedRequestOptions;
        },
    };
});

vi.mock("@google/generative-ai", () => ({
    // Regular function (not arrow) so `new GoogleGenerativeAI(key)` is constructable.
    GoogleGenerativeAI: vi.fn(function () {
        return {
            getGenerativeModel: () => ({
                generateContentStream: mocks.generateContentStream,
            }),
        };
    }),
}));

vi.mock("../lib/ai/key-rotation", () => ({
    getApiKeyForRequest: vi.fn(async () => ({ key: "test-key", index: 0, status: "healthy" })),
    getApiKeys: vi.fn(() => ["test-key"]),
    confirmApiKeyUsage: vi.fn(async () => {}),
    forceKeyRotationAndGetKey: vi.fn(async () => ({ key: "test-key", index: 0, status: "healthy" })),
    shouldRotateOnError: vi.fn(() => false),
    is503OrOverloadError: vi.fn(() => false),
    isModelCircuitOpen: vi.fn(async () => false),
    getModelCircuitState: vi.fn(async () => "closed"),
    tryAcquireHalfOpenProbe: vi.fn(async () => false),
    releaseProbeLock: vi.fn(async () => {}),
    recordModelSuccess: vi.fn(async () => {}),
    recordModelFailure: vi.fn(async () => {}),
    classifyGeminiError: vi.fn(() => ({ category: "transient", retryableWithKey: false, reason: "mock" })),
    extractErrorCode: vi.fn(() => null),
    maskApiKey: vi.fn((key: string) => `${key.slice(0, 4)}...`),
    sanitizeErrorMessage: vi.fn((msg: string) => msg),
    ROTATION_ERROR_CODES: [],
    CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {},
}));

import { streamWithAI } from "../lib/ai/client";
import { AI_PROMPTS } from "../lib/ai/prompts";

describe("Abort Signal Propagation to Gemini Provider", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("forwards the downstream AbortSignal into generateContentStream request options", async () => {
        const controller = new AbortController();

        const stream = await streamWithAI("correct", "input text", "free", controller.signal);

        // Drain the stream to completion.
        const reader = stream.getReader();
        while (!(await reader.read()).done) {
            /* drain */
        }

        expect(mocks.generateContentStream).toHaveBeenCalledTimes(1);
        expect(mocks.lastRequestOptions).toEqual({ signal: controller.signal });
        void AI_PROMPTS;
    });
});
