'use client';

export type AIOperationType = 'correct' | 'improve' | 'summarize' | 'translate' | 'toPrompt';

export interface StreamMetaEvent {
    type: 'meta';
    sessionId: string;
    reservationId?: string;
    operationId: string;
}

export interface StreamDeltaEvent {
    type: 'delta';
    text: string;
}

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

export type StreamEvent =
    | StreamMetaEvent
    | StreamDeltaEvent
    | StreamDoneEvent
    | StreamErrorEvent;

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
}

/**
 * Consumes the /api/ai/stream response stream with NDJSON protocol support.
 *
 * G3 & G8 COMPLIANCE:
 * 1. Line-buffered decoder for NDJSON frames preventing chunk split corruption.
 * 2. UTF-8 multi-byte chunk boundary preservation with TextDecoder({ stream: true }).
 * 3. Immediate reader.cancel() on user cancellation or signal abort.
 * 4. Backward compatibility with raw text streams.
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
}: StreamHandlerOptions): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

        const decoder = new TextDecoder('utf-8');
        let accumulatedText = '';
        let lineBuffer = '';

        try {
            while (true) {
                if (signal?.aborted) {
                    await reader.cancel('Aborted by client');
                    const abortErr = new Error('Operation cancelled by user');
                    abortErr.name = 'AbortError';
                    onError(abortErr);
                    return;
                }

                const { done, value } = await reader.read();
                if (done) break;

                const decoded = decoder.decode(value, { stream: true });
                if (!decoded) continue;

                // Process NDJSON line buffering
                lineBuffer += decoded;
                const lines = lineBuffer.split('\n');

                // Keep the trailing uncompleted line fragment in lineBuffer
                lineBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    // Detect NDJSON structured frame
                    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                        try {
                            const event: StreamEvent = JSON.parse(trimmed);

                            if (event.type === 'meta') {
                                onMeta?.(event);
                            } else if (event.type === 'delta') {
                                accumulatedText += event.text;
                                onChunk(accumulatedText, event.text);
                            } else if (event.type === 'error') {
                                throw new Error(event.message || event.code || 'Stream error occurred');
                            } else if (event.type === 'done') {
                                // Clean EOF marker
                            }
                            continue;
                        } catch (parseErr) {
                            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
                                throw parseErr;
                            }
                        }
                    }

                    // Fallback for SSE / Raw text lines
                    if (trimmed.startsWith('data:')) {
                        const payload = trimmed.slice(5).trim();
                        if (payload === '[DONE]') continue;
                        accumulatedText += payload;
                        onChunk(accumulatedText, payload);
                    } else {
                        // Raw text line fallback
                        accumulatedText += trimmed;
                        onChunk(accumulatedText, trimmed);
                    }
                }
            }

            // Flush any remaining text in lineBuffer
            if (lineBuffer.trim()) {
                const trimmed = lineBuffer.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const event: StreamEvent = JSON.parse(trimmed);
                        if (event.type === 'delta') {
                            accumulatedText += event.text;
                            onChunk(accumulatedText, event.text);
                        } else if (event.type === 'error') {
                            throw new Error(event.message || event.code || 'Stream error');
                        }
                    } catch {
                        accumulatedText += trimmed;
                        onChunk(accumulatedText, trimmed);
                    }
                } else {
                    accumulatedText += trimmed;
                    onChunk(accumulatedText, trimmed);
                }
            }

        } finally {
            try {
                reader.releaseLock();
            } catch {
                // Ignore lock release error on completed reader
            }
        }

        if (!accumulatedText.trim()) {
            throw new Error('AI returned an empty response');
        }

        onComplete(accumulatedText);

    } catch (err: any) {
        if (signal?.aborted || err?.name === 'AbortError') {
            const abortErr = new Error('Operation cancelled by user');
            abortErr.name = 'AbortError';
            onError(abortErr);
            return;
        }

        console.error('[AI Stream Handler] Error during streaming:', err);
        const isNetworkError =
            err?.name === 'TypeError' ||
            err?.message?.includes('Failed to fetch') ||
            err?.message?.includes('network error');

        const errorToEmit = isNetworkError
            ? new Error('Connection interrupted. Original content preserved.')
            : (err instanceof Error ? err : new Error(String(err) || 'Unexpected streaming error'));

        onError(errorToEmit);
    }
}
