import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import {
    getUserTier,
    reserveAndUpdateUsage,
    refundAIReservation,
    refundUsage,
} from "@/server/actions/ai-ops";
import { streamWithAI, Tier } from "@/lib/ai/client";
import { countWords } from "@/lib/utils";
import { AIOperation } from "@/lib/ai/prompts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Route Handler: Stream AI text with NDJSON framing, quota reservation, and resilient error recovery.
 *
 * ARCHITECTURAL SPECIFICATION COMPLIANCE:
 * 1. Tracks deterministic operationId & sessionId.
 * 2. Emits structured NDJSON events: meta, delta, done, error.
 * 3. Gracefully encapsulates mid-stream errors into NDJSON error frames rather than abrupt TCP resets.
 * 4. Automatic quota refund on failures or user abort.
 * 5. Zero sensitive text leakage in server logs.
 */
export async function POST(req: NextRequest) {
    let operationId: string | null = null;
    let reserved = false;
    let reservedUserId: string | null = null;
    let reservedOperation: AIOperation | null = null;
    let reservedWordCount = 0;
    let userTier: any = "free";

    try {
        const user = await getUser();
        if (!user) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json();
        const { text, operation, fileId } = body;
        operationId = body.operationId || `op_${crypto.randomUUID()}`;
        const sessionId = `session_${crypto.randomUUID()}`;

        if (!text || !operation) {
            return new NextResponse("Missing required fields", { status: 400 });
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

        // 3. Start AI Stream with Multi-Key Failover and Handshake Verification
        const aiStream = await streamWithAI(
            operation as AIOperation,
            text,
            tier as Tier,
            req.signal
        );

        // 4. Construct resilient NDJSON output stream
        const encoder = new TextEncoder();
        const decoder = new TextDecoder("utf-8");

        const wrappedStream = new ReadableStream<Uint8Array>({
            async start(controller) {
                // Emit initial meta frame
                const metaFrame = JSON.stringify({
                    type: "meta",
                    sessionId,
                    reservationId: reservation.reservationId || operationId,
                    operationId,
                }) + "\n";
                controller.enqueue(encoder.encode(metaFrame));

                const reader = aiStream.getReader();

                try {
                    while (true) {
                        if (req.signal.aborted) {
                            await reader.cancel("Client aborted");
                            if (operationId) {
                                refundAIReservation(operationId, "client_aborted").catch(() => {});
                            }
                            controller.close();
                            return;
                        }

                        const { done, value } = await reader.read();
                        if (done) break;

                        const chunkText = decoder.decode(value, { stream: true });
                        if (chunkText) {
                            const deltaFrame = JSON.stringify({
                                type: "delta",
                                text: chunkText,
                            }) + "\n";
                            controller.enqueue(encoder.encode(deltaFrame));
                        }
                    }

                    // Emit clean done frame
                    const doneFrame = JSON.stringify({ type: "done" }) + "\n";
                    controller.enqueue(encoder.encode(doneFrame));
                    controller.close();

                } catch (streamError: any) {
                    console.error(`[AI Stream Route] Mid-stream exception (op: ${operationId}):`, streamError?.message || streamError);

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

                    controller.enqueue(encoder.encode(errorFrame));
                    controller.close();

                } finally {
                    try {
                        reader.releaseLock();
                    } catch {
                        // Ignore lock release error
                    }
                }
            },
            cancel(reason) {
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

    } catch (error: any) {
        console.error(`[AI Stream Route] Startup error (operationId: ${operationId || "none"}):`, error?.message || error);

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

        return new NextResponse(error?.message || "Internal Server Error", { status: 500 });
    }
}
