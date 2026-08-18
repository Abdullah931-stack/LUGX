import { describe, it, expect, vi } from 'vitest';
import { consumeAIStream } from '@/lib/ai/stream-handler';
import { formatStreamOutputToHTML, sanitizePreviewChunk } from '@/lib/parsers/stream-markdown';

describe('AI Stream Parser & Sanitizer (Gate G8)', () => {
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
        it('should correctly parse NDJSON events split across arbitrary chunk boundaries', async () => {
            const chunks = [
                '{"type":"meta","sessionI',
                'd":"s1","operationId":"op1"}\n{"type":"delta","text":"Hel',
                'lo, "}\n{"type":"delta","text":"world!"}\n{"type":"done"}\n',
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

            // Mock global fetch returning our stream
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
                type: 'meta',
                sessionId: 's1',
                operationId: 'op1',
            });
            expect(completedText).toBe('Hello, world!');
            expect(receivedDeltas).toEqual(['Hello, ', 'world!']);

            vi.unstubAllGlobals();
        });

        it('should handle multi-byte UTF-8 characters split across chunk boundaries without corruption', async () => {
            // Arabic text: "مرحبا بالعالم" (multi-byte UTF-8 characters)
            const fullText = 'مرحبا بالعالم';
            const encoded = new TextEncoder().encode(fullText);

            // Intentionally slice the byte array mid-character
            const slice1 = encoded.slice(0, 5); // Splits a multi-byte Arabic character
            const slice2 = encoded.slice(5);

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

            expect(output).toBe('مرحبا بالعالم');
            vi.unstubAllGlobals();
        });

        it('should abort stream and call reader.cancel when AbortSignal fires', async () => {
            const abortController = new AbortController();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"type":"delta","text":"Start..."}\n'));
                },
            });

            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

            let errorEmitted: any = null;
            const promise = consumeAIStream({
                operation: 'summarize',
                text: 'input',
                signal: abortController.signal,
                onChunk: () => {
                    // Abort on first chunk
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
    });
});
