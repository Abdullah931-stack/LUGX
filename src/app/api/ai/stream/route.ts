import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { db, schema } from "@/lib/db";
import { eq, and, isNull } from "drizzle-orm";
import {
    getUserTier,
    reserveAndUpdateUsage,
    refundAIReservation,
    refundUsage,
} from "@/server/actions/ai-ops";
import { streamWithAI, processWithAI, Tier } from "@/lib/ai/client";
import { countWords } from "@/lib/utils";
import { AIOperation } from "@/lib/ai/prompts";
import { FEATURES } from "@/config/features.config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Route Handler: Stream AI text with NDJSON framing, quota reservation, and resilient error recovery.
 *
 * PHASE 7 SPECIFICATION COMPLIANCE:
 * 1. Emits canonical NDJSON frames: start (with non-sensitive identifiers), chunk, done, error, cancelled.
 * 2. Strict isolation: zero sensitive user prompt leakage in stream headers or framing metadata.
 * 3. Gracefully encapsulates mid-stream errors into NDJSON error frames without abrupt TCP resets.
 * 4. Automatic idempotent quota refund on startup errors, mid-stream failures, or client disconnects.
 * 5. Supports buffered fallback header for clients requesting non-streaming responses.
 */
export async function POST(req: NextRequest) {
    let operationId: string | null = null;
    let reserved = false;
    let reservedUserId: string | null = null;
    let reservedOperation: AIOperation | null = null;
    let reservedWordCount = 0;
    let userTier: Tier = "free";

    try {
        const user = await getUser();
        if (!user) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json();
        const { text, operation, fileId } = body;
        operationId = body.operationId || `op_${crypto.randomUUID()}`;
        const sessionId = `session_${crypto.randomUUID()}`;

        // ADV2-01 Payload Type & Size Validation Guard
        if (typeof text !== "string" || typeof operation !== "string" || !text.trim() || !operation.trim()) {
            return new NextResponse("Invalid request: text and operation must be non-empty strings", { status: 400 });
        }

        const MAX_INPUT_CHARS = 100_000;
        if (text.length > MAX_INPUT_CHARS) {
            return new NextResponse(`Payload too large: text exceeds ${MAX_INPUT_CHARS} characters limit`, { status: 400 });
        }

        // File ownership verification if fileId is supplied
        if (fileId !== undefined && fileId !== null) {
            if (typeof fileId !== "string" || !fileId.trim()) {
                return new NextResponse("Invalid request: fileId must be a non-empty string", { status: 400 });
            }

            const targetFile = await db.query.files.findFirst({
                where: and(
                    eq(schema.files.id, fileId.trim()),
                    eq(schema.files.userId, user.id),
                    isNull(schema.files.deletedAt)
                ),
            });
            if (!targetFile) {
                return new NextResponse("File not found", { status: 404 });
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

        if (!reservation.reserved) {
            return new NextResponse(reservation.reason || "Quota exceeded", { status: 403 });
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

        const wrappedStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                // Emit initial canonical start frame with non-sensitive identifiers
                const startFrame = JSON.stringify({
                    type: "start",
                    sessionId,
                    reservationId: reservation.reservationId || operationId,
                    operationId,
                }) + "\n";
                controller.enqueue(encoder.encode(startFrame));

                const reader = aiStream.getReader();

                try {
                    while (true) {
                        if (req.signal.aborted) {
                            await reader.cancel("Client aborted");
                            if (operationId) {
                                refundAIReservation(operationId, "client_aborted").catch(() => {});
                            }
                            try {
                                const cancelFrame = JSON.stringify({
                                    type: "cancelled",
                                    reason: "Client aborted connection",
                                }) + "\n";
                                controller.enqueue(encoder.encode(cancelFrame));
                            } catch {
                                // Ignore controller enqueue error if stream already closed
                            }
                            controller.close();
                            return;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

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

                } catch (streamError) {
                    const detail = streamError instanceof Error
                        ? streamError.message
                        : String(streamError);
                    console.error(`[AI Stream Route] Mid-stream exception (op: ${operationId}):`, detail);

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
                    }) + "\n";

                    try {
                        controller.enqueue(encoder.encode(errorFrame));
                    } catch {
                        // Ignore enqueue error if controller is already closing
                    }
                    controller.close();

                } finally {
                    try {
                        reader.releaseLock();
                    } catch {
                        // Ignore lock release error
                    }
                }
            },
            cancel() {
                // Downstream cancel handler - ensure quota is refunded if client disconnects abruptly
                if (operationId) {
                    refundAIReservation(operationId, "stream_cancelled_by_client").catch(() => {});
                }
            }
        });

        return new NextResponse(wrappedStream, {
            headers: {
                "Content-Type": "application/x-ndjson; charset=utf-8",
                "Cache-Control": "no-cache, no-transform, no-store, must-revalidate",
                "Connection": "keep-alive",
                "X-Content-Type-Options": "nosniff",
                "X-Accel-Buffering": "no",
            },
        });

    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[AI Stream Route] Startup error (operationId: ${operationId || "none"}):`, detail);

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

        return new NextResponse(detail || "Internal Server Error", { status: 500 });
    }
}

