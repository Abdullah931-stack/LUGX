import { describe, it, expect, vi } from 'vitest';
import { consumeAIStream } from '@/lib/ai/stream-handler';
import { formatStreamOutputToHTML, sanitizePreviewChunk } from '@/lib/parsers/stream-markdown';

describe('AI Stream Parser & Sanitizer (Phase 7 / Gate G8)', () => {
    describe('Stream Markdown Sanitizer', () => {
        it('should safely escape raw preview text', () => {
            const raw = '<script>alert("xss")</script> & <b>bold</b>';
            const sanitized = sanitizePreviewChunk(raw);
            expect(sanitized).toBe('&lt;script&gt;alert("xss")&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;');
            expect(sanitized).not.toContain('<script>');
        });

        it('should format clean markdown to sanitized HTML without dangerous scripts', () => {
            const md = '# Header\nThis is **bold** text with an [example link](https://example.com) and <img src=x onerror=alert(1)>';
            const { html, isEmpty } = formatStreamOutputToHTML(md);

            expect(isEmpty).toBe(false);
            expect(html).toContain('<h1>Header</h1>');
            expect(html).toContain('<strong>bold</strong>');
            expect(html).toContain('<a href="https://example.com"');
            expect(html).not.toContain('<img');
            expect(html).toContain('&lt;img');
        });

        it('should detect empty or whitespace-only stream outputs', () => {
            const result = formatStreamOutputToHTML('   \n\n\t   ');
            expect(result.isEmpty).toBe(true);
            expect(result.html).toBe('');
        });
    });

    describe('NDJSON Chunk & Line Framing Transport', () => {
        it('should correctly parse canonical NDJSON events (start, chunk, done) across chunk boundaries', async () => {
            const chunks = [
                '{"type":"start","sessionI',
                'd":"s1","operationId":"op1"}\n{"type":"chunk","text":"Hel',
                'lo, "}\n{"type":"chunk","text":"world!"}\n{"type":"done"}\n',
            ];

            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) {
                        controller.enqueue(encoder.encode(chunk));
                    }
                    controller.close();
                },
            });

            const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'application/x-ndjson' },
            }));
            vi.stubGlobal('fetch', fetchMock);

            const receivedDeltas: string[] = [];
            let metaEvent: any = null;
            let completedText = '';

            await consumeAIStream({
                operation: 'improve',
                text: 'input text',
                onMeta: (meta) => {
                    metaEvent = meta;
                },
                onChunk: (accumulated, latest) => {
                    receivedDeltas.push(latest);
                },
                onComplete: (finalText) => {
                    completedText = finalText;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(metaEvent).toEqual({
                type: 'start',
                sessionId: 's1',
                operationId: 'op1',
            });
            expect(completedText).toBe('Hello, world!');
            expect(receivedDeltas).toEqual(['Hello, ', 'world!']);

            vi.unstubAllGlobals();
        });

        it('should handle multi-byte UTF-8 characters split across chunk boundaries without corruption', async () => {
            const fullText = 'مرحبا بالعالم والذكاء الاصطناعي';
            const encoded = new TextEncoder().encode(
                `{"type":"start","sessionId":"s1","operationId":"op1"}\n{"type":"chunk","text":"${fullText}"}\n{"type":"done"}\n`
            );

            // Intentionally slice byte array across multi-byte character boundary
            const slice1 = encoded.slice(0, 47);
            const slice2 = encoded.slice(47);

            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(slice1);
                    controller.enqueue(slice2);
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let output = '';
            await consumeAIStream({
                operation: 'translate',
                text: 'hello world',
                onChunk: () => {},
                onComplete: (finalText) => {
                    output = finalText;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(output).toBe('مرحبا بالعالم والذكاء الاصطناعي');
            vi.unstubAllGlobals();
        });

        it('should detect incomplete EOF stream without done as failed_incomplete_stream', async () => {
            // Stream closes before emitting {"type":"done"}
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"type":"start","sessionId":"s1","operationId":"op1"}\n{"type":"chunk","text":"Partial content..."}\n'));
                    controller.close(); // Abrupt EOF without done frame
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            await consumeAIStream({
                operation: 'summarize',
                text: 'input',
                onChunk: () => {},
                onComplete: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted.message).toContain('failed_incomplete_stream');

            vi.unstubAllGlobals();
        });

        it('should accept first done and ignore duplicate done events', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(
                        '{"type":"start","sessionId":"s1","operationId":"op1"}\n' +
                        '{"type":"chunk","text":"Unique output"}\n' +
                        '{"type":"done"}\n' +
                        '{"type":"done"}\n'
                    ));
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let completedCalls = 0;
            let finalOutput = '';

            await consumeAIStream({
                operation: 'improve',
                text: 'input',
                onChunk: () => {},
                onComplete: (text) => {
                    completedCalls++;
                    finalOutput = text;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(completedCalls).toBe(1);
            expect(finalOutput).toBe('Unique output');

            vi.unstubAllGlobals();
        });

        it('should safely ignore unknown message types and empty chunks without mutating state', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(
                        '{"type":"unknown_telemetry_event","timestamp":123456}\n' +
                        '{"type":"chunk","text":""}\n' +
                        '{"type":"chunk","text":"Valid content"}\n' +
                        '{"type":"custom_future_type","foo":"bar"}\n' +
                        '{"type":"done"}\n'
                    ));
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            const chunks: string[] = [];
            let completed = '';

            await consumeAIStream({
                operation: 'correct',
                text: 'input',
                onChunk: (acc, latest) => {
                    chunks.push(latest);
                },
                onComplete: (text) => {
                    completed = text;
                },
                onError: (err) => {
                    throw err;
                },
            });

            expect(chunks).toEqual(['Valid content']);
            expect(completed).toBe('Valid content');

            vi.unstubAllGlobals();
        });

        it('should abort stream and call reader.cancel when AbortSignal fires', async () => {
            const abortController = new AbortController();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"type":"chunk","text":"Start..."}\n'));
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            const promise = consumeAIStream({
                operation: 'summarize',
                text: 'input',
                signal: abortController.signal,
                onChunk: () => {
                    abortController.abort();
                },
                onComplete: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            await promise;
            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted?.name).toBe('AbortError');

            vi.unstubAllGlobals();
        });

        it('should cleanly handle corrupted JSON chunk and emit error without commit', async () => {
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"type":"chunk", corrupted json\n'));
                    controller.close();
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            let completeCalled = false;

            await consumeAIStream({
                operation: 'summarize',
                text: 'input',
                onChunk: () => {},
                onComplete: () => {
                    completeCalled = true;
                },
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(completeCalled).toBe(false);

            vi.unstubAllGlobals();
        });

        it('should enforce MAX_LINE_BUFFER_CHARS and reject buffer flooding with stream_buffer_overflow', async () => {
            // Send chunk exceeding 256KB without newline
            const hugeChunk = 'a'.repeat(300 * 1024);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(hugeChunk));
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            await consumeAIStream({
                operation: 'summarize',
                text: 'input',
                onChunk: () => {},
                onComplete: () => {},
                onError: (err) => {
                    errorEmitted = err;
                },
            });

            expect(errorEmitted).not.toBeNull();
            expect(errorEmitted.message).toContain('stream_buffer_overflow');

            vi.unstubAllGlobals();
        });
    });
});


