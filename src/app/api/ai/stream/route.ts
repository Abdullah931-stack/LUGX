import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { db, schema } from "@/lib/db";
import { eq, and, isNull } from "drizzle-orm";
import {
    getUserTier,
    reserveAndUpdateUsage,
    refundAIReservation,
    commitAIReservation,
    refundUsage,
} from "@/server/actions/ai-ops";
import { streamWithAI, processWithAI, Tier } from "@/lib/ai/client";
import { countWords } from "@/lib/utils";
import { AIOperation } from "@/lib/ai/prompts";
import { FEATURES } from "@/config/features.config";
import { aiStreamRateLimiter, addRateLimitHeaders, rateLimitExceededResponse } from "@/lib/rate-limit";
import { getOrGenerateCorrelationId, addCorrelationHeader } from "@/lib/utils/correlation";

import { sanitizeLogMessage } from "@/lib/sync/log-sanitizer";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Route Handler: Stream AI text with NDJSON framing, quota reservation, and resilient error recovery.
 *
 * PHASE 7 & PHASE 17 SPECIFICATION COMPLIANCE:
 * 1. Emits canonical NDJSON frames: start (with non-sensitive identifiers & correlationId), chunk, done, error, cancelled.
 * 2. Strict isolation: zero sensitive user prompt leakage in stream headers or framing metadata.
 * 3. Gracefully encapsulates mid-stream errors into NDJSON error frames without abrupt TCP resets.
 * 4. Automatic idempotent quota refund on startup errors, mid-stream failures, or client disconnects.
 * 5. Supports buffered fallback header for clients requesting non-streaming responses.
 * 6. Rate-limited via sliding window counter with fail-open fallback and end-to-end correlation ID tracking.
 */
export async function POST(req: NextRequest) {
    const correlationId = getOrGenerateCorrelationId(req);
    const reqStartTime = performance.now();
    let reservationDurationMs = 0;
    let ttftMs: number | null = null;
    let operationId: string | null = null;
    let reserved = false;
    let reservedUserId: string | null = null;
    let reservedOperation: AIOperation | null = null;
    let reservedWordCount = 0;
    let userTier: Tier = "free";

    try {
        const user = await getUser();
        if (!user) {
            const res = new NextResponse("Unauthorized", { status: 401 });
            addCorrelationHeader(res.headers, correlationId);
            return res;
        }

        const rateLimitResult = await aiStreamRateLimiter.limit(user.id);
        if (!rateLimitResult.success) {
            const res = rateLimitExceededResponse(rateLimitResult);
            addCorrelationHeader(res.headers, correlationId);
            return res;
        }

        const withCorrelation = (res: NextResponse): NextResponse => {
            addCorrelationHeader(res.headers, correlationId);
            addRateLimitHeaders(res.headers, rateLimitResult);
            return res;
        };

        const body = await req.json();
        const { text, operation, fileId } = body;
        operationId = body.operationId || `op_${crypto.randomUUID()}`;
        const sessionId = `session_${crypto.randomUUID()}`;

        // ADV2-01 Payload Type & Size Validation Guard
        if (typeof text !== "string" || typeof operation !== "string" || !text.trim() || !operation.trim()) {
            return withCorrelation(new NextResponse("Invalid request: text and operation must be non-empty strings", { status: 400 }));
        }

        const MAX_INPUT_CHARS = 100_000;
        if (text.length > MAX_INPUT_CHARS) {
            return withCorrelation(new NextResponse(`Payload too large: text exceeds ${MAX_INPUT_CHARS} characters limit`, { status: 400 }));
        }

        // File ownership verification if fileId is supplied
        if (fileId !== undefined && fileId !== null) {
            if (typeof fileId !== "string" || !fileId.trim()) {
                return withCorrelation(new NextResponse("Invalid request: fileId must be a non-empty string", { status: 400 }));
            }

            const targetFile = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, fileId.trim()),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });
            if (!targetFile) {
                return withCorrelation(new NextResponse("File not found", { status: 404 }));
            }

            // Zero-Knowledge AI Gatekeeper: prohibit AI on encrypted files unless user explicitly opted in
            if (targetFile.isEncrypted) {
                const vaultProfile = await db.query.userVaultProfiles.findFirst({
                    where: eq(schema.userVaultProfiles.userId, user.id),
                });
                if (!vaultProfile?.allowAIOnEncryptedFiles) {
                    return withCorrelation(new NextResponse("AI_PROHIBITED_ON_ENCRYPTED_FILES", { status: 403 }));
                }
            }
        }

        // 1. Get User Tier
        const tier = await getUserTier(user.id);
        userTier = tier;
        reservedUserId = user.id;
        reservedOperation = operation as AIOperation;

        // 2. Atomically reserve quota BEFORE starting the stream
        const wordCount = countWords(text);
        reservedWordCount = wordCount;

        const resStart = performance.now();
        const reservation = await reserveAndUpdateUsage(
            user.id,
            operation as AIOperation,
            wordCount,
            tier,
            {
                operationId: operationId!,
                fileId: fileId || null,
            }
        );
        reservationDurationMs = performance.now() - resStart;

        if (!reservation.reserved) {
            return withCorrelation(new NextResponse(reservation.reason || "Quota exceeded", { status: 403 }));
        }

        reserved = true;

        // 3. Start AI generation — incremental NDJSON streaming path (feature-flag
        // gated, G10) or the safe buffered accumulator fallback. Both paths honor the
        // request abort signal and multi-key failover inside the AI client.
        const encoder = new TextEncoder();

        let aiStream: ReadableStream<Uint8Array>;
        if (FEATURES.AI_STREAMING_ENABLED) {
            aiStream = await streamWithAI(
                operation as AIOperation,
                text,
                tier as Tier,
                req.signal
            );
        } else {
            const bufferedText = await processWithAI(
                operation as AIOperation,
                text,
                tier as Tier,
                req.signal
            );
            aiStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(bufferedText));
                    controller.close();
                },
            });
        }

        // 4. Construct resilient NDJSON output stream
        const decoder = new TextDecoder("utf-8");

        // Canonical TD-05 Resolution: Unified Disconnect Handler.
        // If the client disconnects pre-TTFT (before any tokens were streamed),
        // it is refunded as an unfulfilled / early-aborted request.
        // Once tokens start streaming (post-TTFT), compute was consumed by the provider.
        // Under the Explicit Settlement Policy (§4-D), the server autonomously commits
        // the reservation, eliminating client-side settlement round-trip wait times and race conditions.
        const handleClientDisconnect = async (reason: string) => {
            if (!operationId) return;
            try {
                if (ttftMs === null) {
                    await refundAIReservation(operationId, `disconnect_pre_generation_${reason}`);
                } else {
                    await commitAIReservation(operationId);
                }
            } catch (err) {
                console.warn(`[AI Stream Route] Disconnect settlement error (${operationId}):`, err);
            }
        };

        const wrappedStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                // Emit initial canonical start frame with non-sensitive identifiers & correlationId
                const startFrame = JSON.stringify({
                    type: "start",
                    sessionId,
                    reservationId: reservation.reservationId || operationId,
                    operationId,
                    correlationId,
                }) + "\n";
                controller.enqueue(encoder.encode(startFrame));

                const reader = aiStream.getReader();

                try {
                    while (true) {
                        if (req.signal.aborted) {
                            await reader.cancel("Client aborted");
                            await handleClientDisconnect("signal_aborted");
                            try {
                                const cancelFrame = JSON.stringify({
                                    type: "cancelled",
                                    reason: "Client aborted connection",
                                    correlationId,
                                }) + "\n";
                                controller.enqueue(encoder.encode(cancelFrame));
                            } catch {
                                // Ignore controller enqueue error if stream already closed
                            }
                            controller.close();
                            console.info(JSON.stringify({
                                event: "ai_stream_aborted_by_client",
                                operationId,
                                correlationId,
                                operation,
                                wordCount: reservedWordCount,
                                reservationLatencyMs: Math.round(reservationDurationMs),
                                ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
                                durationMs: Math.round(performance.now() - reqStartTime),
                            }));
                            return;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

                        if (ttftMs === null) {
                            ttftMs = performance.now() - reqStartTime;
                        }

                        const chunkText = decoder.decode(value, { stream: true });
                        if (chunkText) {
                            const chunkFrame = JSON.stringify({
                                type: "chunk",
                                text: chunkText,
                            }) + "\n";
                            controller.enqueue(encoder.encode(chunkFrame));
                        }
                    }

                    // Flush any remaining decoder bytes
                    const flushed = decoder.decode();
                    if (flushed) {
                        const finalChunkFrame = JSON.stringify({
                            type: "chunk",
                            text: flushed,
                        }) + "\n";
                        controller.enqueue(encoder.encode(finalChunkFrame));
                    }

                    // Emit clean done frame
                    const doneFrame = JSON.stringify({ type: "done" }) + "\n";
                    controller.enqueue(encoder.encode(doneFrame));
                    controller.close();

                    // Zero-allocation structured telemetry emission
                    console.info(JSON.stringify({
                        event: "ai_stream_completed",
                        operationId,
                        correlationId,
                        operation,
                        wordCount: reservedWordCount,
                        reservationLatencyMs: Math.round(reservationDurationMs),
                        ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
                        durationMs: Math.round(performance.now() - reqStartTime),
                    }));

                } catch (streamError) {
                    const detail = streamError instanceof Error
                        ? streamError.message
                        : String(streamError);
                    console.error(`[AI Stream Route] Mid-stream exception (op: ${operationId}, corr: ${correlationId}):`, detail);

                    // Trigger automatic quota refund
                    try {
                        if (operationId) {
                            await refundAIReservation(operationId, "mid_stream_failure");
                        }
                    } catch (refundErr) {
                        console.warn("[AI Stream Route] Quota refund error:", refundErr);
                    }

                    // Emit graceful NDJSON error frame instead of breaking the connection
                    const errorFrame = JSON.stringify({
                        type: "error",
                        code: "STREAM_INTERRUPTED",
                        message: "The AI service encountered a temporary issue. Please try again.",
                        retryable: true,
                        operationId,
                        correlationId,
                    }) + "\n";

                    try {
                        controller.enqueue(encoder.encode(errorFrame));
                    } catch {
                        // Ignore enqueue error if controller is already closing
                    }
                    controller.close();

                    console.info(JSON.stringify({
                        event: "ai_stream_failed",
                        operationId,
                        correlationId,
                        operation,
                        error: sanitizeLogMessage(detail),
                        reservationLatencyMs: Math.round(reservationDurationMs),
                        ttftMs: ttftMs !== null ? Math.round(ttftMs) : null,
                        durationMs: Math.round(performance.now() - reqStartTime),
                    }));

                } finally {
                    try {
                        reader.releaseLock();
                    } catch {
                        // Ignore lock release error
                    }
                }
            },
            cancel() {
                // Downstream cancel handler: autonomously commit if post-TTFT or refund if pre-TTFT
                void handleClientDisconnect("stream_cancelled");
            }
        });

        const responseHeaders = new Headers({
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform, no-store, must-revalidate",
            "Connection": "keep-alive",
            "X-Content-Type-Options": "nosniff",
            "X-Accel-Buffering": "no",
        });
        addRateLimitHeaders(responseHeaders, rateLimitResult);
        addCorrelationHeader(responseHeaders, correlationId);

        return new NextResponse(wrappedStream, {
            headers: responseHeaders,
        });

    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[AI Stream Route] Startup error (operationId: ${operationId || "none"}, corr: ${correlationId}):`, sanitizeLogMessage(detail));

        // Auto-refund quota if reserved before stream failed or aborted
        if (reserved) {
            try {
                if (operationId) {
                    await refundAIReservation(operationId, "stream_startup_error");
                } else if (reservedUserId && reservedOperation) {
                    await refundUsage(reservedUserId, reservedOperation, reservedWordCount, userTier);
                }
            } catch (refundError) {
                console.error("[AI Stream Route] Failed to refund usage quota:", refundError);
            }
        }

        const res = new NextResponse("An unexpected error occurred while processing your request. Please try again.", { status: 500 });
        addCorrelationHeader(res.headers, correlationId);
        return res;
    }
}

