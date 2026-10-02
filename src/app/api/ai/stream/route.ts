import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { db, schema } from "@/server/db";
import { eq, and, isNull } from "drizzle-orm";
import {
    getUserTier,
    reserveAIQuota,
    refundAIReservation,
    commitAIReservation,
    computeRequestHash,
} from "@/server/services/ai-settlement-service";
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
 * Route Handler: Stream AI text with NDJSON framing, Server-Authoritative Settlement, and Replay Defense.
 *
 * PHASE 11 SPECIFICATION COMPLIANCE:
 * 1. Emits canonical NDJSON frames: start, chunk, done, error, cancelled.
 * 2. Replay Attack Prevention: rejects reused operationIds with divergent request fingerprints via 409 Conflict.
 * 3. Server-Authoritative Settlement:
 *    - Pre-TTFT provider failure or client disconnect: autonomously refunds quota (refundAIReservation).
 *    - Post-TTFT client disconnect: autonomously commits quota (commitAIReservation) to account for spent provider compute.
 *    - Clean completion: commits quota BEFORE enqueuing `{ type: "done" }`.
 * 4. Zero client-side financial authority: clients cannot trigger refund or commit RPCs.
 */
export async function POST(req: NextRequest) {
    const correlationId = getOrGenerateCorrelationId(req);
    const reqStartTime = performance.now();
    let reservationDurationMs = 0;
    let ttftMs: number | null = null;
    let operationId: string | null = null;
    let reserved = false;
    let reservedWordCount = 0;

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

        // PHASE 10 / LUGX-085: Mandatory fileId validation to block unauthenticated / uninspected AI streaming
        if (fileId === undefined || fileId === null) {
            return withCorrelation(
                new NextResponse("MISSING_FILE_ID: fileId is required for AI stream operations", { status: 400 })
            );
        }
        if (typeof fileId !== "string" || !fileId.trim()) {
            return withCorrelation(
                new NextResponse("Invalid request: fileId must be a non-empty string (MISSING_FILE_ID)", { status: 400 })
            );
        }

        const cleanFileId = fileId.trim();
        const targetFile = await db.query.files.findFirst({
            where: and(
                eq(schema.files.id, cleanFileId),
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

        // 1. Get User Tier
        const tier = await getUserTier(user.id);

        // 2. Count words
        const wordCount = countWords(text);
        reservedWordCount = wordCount;

        // 3. Compute deterministic request fingerprint for Replay Attack Prevention
        const requestHash = computeRequestHash(user.id, operation, cleanFileId, text);

        // 4. Atomically reserve quota BEFORE starting the stream
        const resStart = performance.now();
        const reservation = await reserveAIQuota(
            user.id,
            operation as AIOperation,
            wordCount,
            tier,
            {
                operationId: operationId!,
                fileId: cleanFileId,
                requestHash,
            }
        );
        reservationDurationMs = performance.now() - resStart;

        if (!reservation.reserved) {
            if (reservation.isReplayConflict) {
                return withCorrelation(
                    new NextResponse(reservation.reason || "Replay conflict: operationId already used with different payload", {
                        status: 409,
                    })
                );
            }
            return withCorrelation(new NextResponse(reservation.reason || "Quota exceeded", { status: 403 }));
        }

        reserved = true;

        // 5. Start AI generation — incremental NDJSON streaming path or buffered fallback
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

        // 6. Construct resilient NDJSON output stream with Server-Authoritative Settlement
        const decoder = new TextDecoder("utf-8");

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

                    // PHASE 11: Server commits the reservation authoritatively BEFORE emitting done frame
                    if (operationId) {
                        try {
                            await commitAIReservation(operationId);
                        } catch (commitErr) {
                            console.error(`[AI Stream Route] Failed to commit reservation before done (${operationId}):`, commitErr);
                        }
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

                    // Automatic quota settlement on mid-stream failure:
                    // Pre-TTFT provider failure -> refund
                    // Post-TTFT failure -> commit consumed compute
                    try {
                        if (operationId) {
                            if (ttftMs === null) {
                                await refundAIReservation(operationId, "mid_stream_failure_pre_ttft");
                            } else {
                                await commitAIReservation(operationId);
                            }
                        }
                    } catch (refundErr) {
                        console.warn("[AI Stream Route] Quota settlement error on stream exception:", refundErr);
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
        if (reserved && operationId) {
            try {
                await refundAIReservation(operationId, "stream_startup_error");
            } catch (refundError) {
                console.error("[AI Stream Route] Failed to refund usage quota:", refundError);
            }
        }

        const isOverload =
            detail.includes("503") ||
            detail.includes("high demand") ||
            detail.includes("service unavailable") ||
            detail.includes("overloaded") ||
            detail.includes("Circuit Breaker is OPEN");

        const status = isOverload ? 503 : 500;
        const errorMessage = isOverload
            ? "The AI service is currently experiencing high demand. Spikes in demand are usually temporary. Please try again shortly."
            : "An unexpected error occurred while processing your request. Please try again.";

        const res = new NextResponse(errorMessage, { status });
        if (isOverload) {
            res.headers.set("Retry-After", "30");
        }
        addCorrelationHeader(res.headers, correlationId);
        return res;
    }
}
