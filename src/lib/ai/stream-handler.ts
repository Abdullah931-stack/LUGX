'use client';

export type AIOperationType = 'correct' | 'improve' | 'summarize' | 'translate' | 'toPrompt';

export interface StreamStartEvent {
    type: 'start' | 'meta' | 'metadata';
    sessionId: string;
    reservationId?: string;
    operationId: string;
}

export type StreamMetaEvent = StreamStartEvent;

export interface StreamChunkEvent {
    type: 'chunk' | 'delta';
    text: string;
}

export type StreamDeltaEvent = StreamChunkEvent;

export interface StreamDoneEvent {
    type: 'done';
    usage?: { outputTokens?: number };
}

export interface StreamErrorEvent {
    type: 'error';
    code?: string;
    message?: string;
    retryable?: boolean;
}

export interface StreamCancelledEvent {
    type: 'cancelled';
    reason?: string;
}

export type StreamEvent =
    | StreamStartEvent
    | StreamChunkEvent
    | StreamDoneEvent
    | StreamErrorEvent
    | StreamCancelledEvent
    | { type: string; [key: string]: unknown };

export interface StreamHandlerOptions {
    operation: AIOperationType;
    text: string;
    operationId?: string;
    fileId?: string;
    expectedVersion?: number;
    onMeta?: (meta: StreamMetaEvent) => void;
    onChunk: (accumulatedText: string, latestChunk: string) => void;
    onComplete: (finalText: string) => void;
    onError: (error: Error) => void;
    signal?: AbortSignal;
    /** Ops/test hook: override the first-chunk watchdog threshold (ms). */
    firstChunkTimeoutMs?: number;
    /** Ops/test hook: override the absolute stream-duration watchdog threshold (ms). */
    maxDurationMs?: number;
}

export const MAX_LINE_BUFFER_CHARS = 256 * 1024; // 256KB Line buffer safety ceiling

/**
 * Watchdog: maximum wait (ms) for the first streamed byte before failing the session.
 * A stalled provider connection must fail closed instead of hanging the editor forever.
 */
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;

/**
 * Watchdog: absolute ceiling (ms) for a single streaming session regardless of activity.
 */
export const MAX_STREAM_DURATION_MS = 120_000;

/**
 * Consumes the /api/ai/stream response stream with resilient NDJSON protocol support.
 *
 * PHASE 7 HARDENED SPECIFICATION COMPLIANCE:
 * 1. Line-buffered decoder for NDJSON frames preventing chunk/newline split corruption.
 * 2. Unbounded line buffer guard (ADV-01) preventing Client Heap Out-Of-Memory attacks.
 * 3. Single-terminal-callback guarantee (ADV-05) preventing duplicate onError/onComplete emissions.
 * 4. UTF-8 multi-byte chunk boundary preservation with TextDecoder({ stream: true }).
 * 5. Canonical NDJSON schema support: start/meta/metadata, chunk/delta, done, error, cancelled.
 * 6. Resilient edge-case handling:
 *    - Incomplete stream termination detected as 'failed_incomplete_stream'.
 *    - Duplicate 'done' events accepted once and subsequent duplicates ignored.
 *    - Unknown message types ignored safely without crash.
 *    - Empty chunks ignored without mutating state.
 *    - Corrupted JSON chunks trigger clean error teardown without commit.
 * 7. Immediate reader.cancel() on user cancellation or signal abort.
 */
export async function consumeAIStream({
    operation,
    text,
    operationId,
    fileId,
    expectedVersion,
    onMeta,
    onChunk,
    onComplete,
    onError,
    signal,
    firstChunkTimeoutMs: firstChunkTimeoutMsOverride,
    maxDurationMs: maxDurationMsOverride,
}: StreamHandlerOptions): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let isTerminalCallbackEmitted = false;

    // Runtime watchdog state. Guarantees the session always reaches a terminal
    // callback even if the provider stalls before the first byte or mid-stream.
    const firstChunkTimeoutMs = firstChunkTimeoutMsOverride ?? FIRST_CHUNK_TIMEOUT_MS;
    const maxDurationMs = maxDurationMsOverride ?? MAX_STREAM_DURATION_MS;
    let receivedFirstChunk = false;
    let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
    let durationTimer: ReturnType<typeof setTimeout> | null = null;

    const clearWatchdogTimers = (): void => {
        if (firstChunkTimer) {
            clearTimeout(firstChunkTimer);
            firstChunkTimer = null;
        }
        if (durationTimer) {
            clearTimeout(durationTimer);
            durationTimer = null;
        }
    };

    /**
     * FIX (runtime remediation): the completion callback performs the whole atomic
     * commit pipeline asynchronously. An exception thrown inside it previously became
     * an unhandled promise rejection, leaving the session stuck in a non-terminal
     * state — ghost never cleared, quota never refunded, and the in-flight mutex
     * permanently locked so every subsequent trigger was silently dropped.
     * Rejections are now deterministically routed into onError so exactly one
     * terminal callback is always emitted.
     */
    const emitComplete = (finalText: string) => {
        if (isTerminalCallbackEmitted) return;
        clearWatchdogTimers();
        isTerminalCallbackEmitted = true;

        Promise.resolve()
            .then(() => onComplete(finalText))
            .catch((completionErr: unknown) => {
                isTerminalCallbackEmitted = false;
                emitError(
                    completionErr instanceof Error
                        ? completionErr
                        : new Error(String(completionErr) || 'Stream completion pipeline failed')
                );
            });
    };

    const emitError = (err: Error) => {
        clearWatchdogTimers();
        if (isTerminalCallbackEmitted) return;
        isTerminalCallbackEmitted = true;
        onError(err);
    };

    const fireWatchdogTimeout = (code: string, detail: string): void => {
        try {
            reader?.cancel(code);
        } catch {
            // Reader already released or locked elsewhere; error path proceeds.
        }
        emitError(new Error(`${code}: ${detail}`));
    };

    try {
        const response = await fetch('/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                operation,
                operationId,
                fileId,
                expectedVersion,
            }),
            signal,
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText || response.statusText || `HTTP Error ${response.status}`);
        }

        reader = response.body?.getReader() || null;
        if (!reader) {
            throw new Error('No readable stream available in response');
        }

        // Arm runtime watchdogs (see constants above).
        firstChunkTimer = setTimeout(() => {
            if (!receivedFirstChunk) {
                fireWatchdogTimeout(
                    'AI_STREAM_FIRST_CHUNK_TIMEOUT',
                    `no data received from AI provider within ${firstChunkTimeoutMs}ms`
                );
            }
        }, firstChunkTimeoutMs);
        durationTimer = setTimeout(() => {
            fireWatchdogTimeout(
                'AI_STREAM_DURATION_EXCEEDED',
                `stream exceeded maximum allowed duration of ${maxDurationMs}ms`
            );
        }, maxDurationMs);

        const decoder = new TextDecoder('utf-8');
        let accumulatedText = '';
        let lineBuffer = '';
        let isDoneReceived = false;
        let isCancelledReceived = false;

        const processLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            // Detect NDJSON structured frame
            if (trimmed.startsWith('{')) {
                let event: StreamEvent;
                try {
                    event = JSON.parse(trimmed);
                } catch {
                    throw new Error('Invalid JSON stream chunk received');
                }

                if (event.type === 'meta' || event.type === 'start' || event.type === 'metadata') {
                    onMeta?.(event as StreamMetaEvent);
                } else if (event.type === 'delta' || event.type === 'chunk') {
                    const chunkText = (event as StreamChunkEvent).text;
                    if (chunkText && chunkText.length > 0) {
                        accumulatedText += chunkText;
                        onChunk(accumulatedText, chunkText);
                    }
                } else if (event.type === 'error') {
                    const errEvt = event as StreamErrorEvent;
                    throw new Error(errEvt.message || errEvt.code || 'Stream error occurred');
                } else if (event.type === 'cancelled') {
                    isCancelledReceived = true;
                    const cancelErr = new Error((event as StreamCancelledEvent).reason || 'Stream cancelled');
                    cancelErr.name = 'AbortError';
                    throw cancelErr;
                } else if (event.type === 'done') {
                    if (!isDoneReceived) {
                        isDoneReceived = true;
                    }
                } else {
                    // Unknown message type: safely ignore
                }
                return;
            }

            // Fallback for SSE / Raw text lines
            if (trimmed.startsWith('data:')) {
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') {
                    isDoneReceived = true;
                    return;
                }
                if (payload.length > 0) {
                    accumulatedText += payload;
                    onChunk(accumulatedText, payload);
                }
            } else {
                // Raw text line fallback
                accumulatedText += trimmed;
                onChunk(accumulatedText, trimmed);
                // In raw mode, receipt of line constitutes completion on stream end
                isDoneReceived = true;
            }
        };

        try {
            while (true) {
                if (signal?.aborted) {
                    try {
                        await reader.cancel('Aborted by client');
                    } catch {
                        // Suppress lock error on cancel
                    }
                    const abortErr = new Error('Operation cancelled by user');
                    abortErr.name = 'AbortError';
                    emitError(abortErr);
                    return;
                }

                const { done, value } = await reader.read();
                if (done) break;

                const decoded = decoder.decode(value, { stream: true });
                if (!decoded) continue;

                // First-byte latch: disarm the time-to-first-token watchdog.
                if (!receivedFirstChunk) {
                    receivedFirstChunk = true;
                    if (firstChunkTimer) {
                        clearTimeout(firstChunkTimer);
                        firstChunkTimer = null;
                    }
                }

                // Process NDJSON line buffering
                lineBuffer += decoded;

                // ADV-01 Guard: Prevent unbounded line buffer growth if stream lacks newlines
                if (lineBuffer.length > MAX_LINE_BUFFER_CHARS) {
                    throw new Error('stream_buffer_overflow');
                }

                const lines = lineBuffer.split('\n');

                // Keep the trailing uncompleted line fragment in lineBuffer
                lineBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    processLine(line);
                }
            }

            // Flush decoder for any residual multi-byte characters
            const flushed = decoder.decode();
            if (flushed) {
                lineBuffer += flushed;
            }

            // Flush any remaining text in lineBuffer
            if (lineBuffer.trim()) {
                processLine(lineBuffer);
            }

        } finally {
            try {
                reader.releaseLock();
            } catch {
                // Ignore lock release error on completed reader
            }
        }

        if (signal?.aborted || isCancelledReceived) {
            const abortErr = new Error('Operation cancelled by user');
            abortErr.name = 'AbortError';
            emitError(abortErr);
            return;
        }

        // Verify stream completeness: response ended without a terminal 'done'
        if (!isDoneReceived) {
            throw new Error('failed_incomplete_stream');
        }

        if (!accumulatedText.trim()) {
            throw new Error('AI returned an empty response');
        }

        emitComplete(accumulatedText);

    } catch (err) {
        clearWatchdogTimers();

        const errName = err instanceof Error ? err.name : "";
        const errMessage = err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "";

        if (signal?.aborted || errName === 'AbortError') {
            const abortErr = new Error('Operation cancelled by user');
            abortErr.name = 'AbortError';
            emitError(abortErr);
            return;
        }

        console.error('[AI Stream Handler] Error during streaming:', err);
        const isNetworkError =
            errName === 'TypeError' ||
            errMessage.includes('Failed to fetch') ||
            errMessage.includes('network error');

        const errorToEmit = isNetworkError
            ? new Error('Connection interrupted. Original content preserved.')
            : (err instanceof Error ? err : new Error(errMessage || 'Unexpected streaming error'));

        emitError(errorToEmit);
    }
}


