/**
 * @vitest-environment jsdom
 *
 * AI Preview Explicit Decision Model Tests
 *
 * Validates the preview_ready decision flow introduced by the explicit-decision
 * refactor of `useAIStream`:
 *
 * 1. Stream completion parks the sanitized output in `preview_ready` WITHOUT
 *    committing anything (no server commit, no document mutation).
 * 2. `rejectPreview()` keeps the document pristine and SETTLES the reservation
 *    as consumed (`commitAIReservation`) — it must NEVER refund it.
 * 3. `commitPreview()` performs the server-first atomic commit then applies a
 *    single atomic local transaction.
 * 4. `retryPreview()` settles the old reservation as consumed and starts a new
 *    stream (fresh reservation), never refunding either.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CodeMirrorEditorAdapter, createEditorAdapter } from '@/components/editor/markdown/editor-adapter';
import { createMarkdownExtensions } from '@/components/editor/markdown/markdown-extensions';
import { useAIStream } from '@/hooks/use-ai-stream';

// Mock server actions
const mockCommitAIFileOperation = vi.fn();
const mockRefundAIReservation = vi.fn().mockResolvedValue({ refunded: true });
const mockCommitAIReservation = vi.fn().mockResolvedValue({ committed: true });

vi.mock('@/server/actions/ai-commit', () => ({
    commitAIFileOperation: (...args: unknown[]) => mockCommitAIFileOperation(...args),
    refundAIReservation: (...args: unknown[]) => mockRefundAIReservation(...args),
}));

vi.mock('@/server/actions/ai-ops', () => ({
    commitAIReservation: (...args: unknown[]) => mockCommitAIReservation(...args),
}));

// Mock the NDJSON stream consumer — tests drive its callbacks manually.
type ConsumeCallbacks = {
    onMeta?: (meta: { sessionId: string; operationId: string }) => void;
    onChunk?: (accumulated: string, latestChunk: string) => void;
    onComplete?: (finalRawText: string) => void | Promise<void>;
    onError?: (err: Error) => void;
};
const mockConsumeAIStream = vi.fn();
vi.mock('@/lib/ai/stream-handler', () => ({
    consumeAIStream: (...args: unknown[]) => mockConsumeAIStream(...args),
}));

describe('AI Preview Explicit Decision Model (preview_ready)', () => {
    let editor: CodeMirrorEditorAdapter;
    let view: EditorView;
    let container: HTMLElement;
    const initialContent = 'The quick brown fox jumps over the lazy dog.';

    const renderAIStream = () =>
        renderHook(() =>
            useAIStream({
                onCommitSuccess: vi.fn(),
                onConflict: vi.fn(),
                onError: vi.fn(),
                onProgrammaticTransaction: (fn) => fn(),
            })
        );

    const startDefaultStream = async (
        result: { current: ReturnType<typeof useAIStream> }
    ) => {
        await act(async () => {
            await result.current.startStream({
                editor,
                operation: 'improve',
                fileId: 'file-1',
                expectedVersion: 1,
                originalEtag: 'etag-v1',
                editorGeneration: 1,
            });
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();

        if (typeof Range.prototype.getClientRects !== 'function') {
            Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        }
        if (typeof Range.prototype.getBoundingClientRect !== 'function') {
            Range.prototype.getBoundingClientRect = () => ({
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
        }

        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            // Default successful stream: meta → chunk → done
            options.onMeta?.({ sessionId: 's', operationId: 'op' });
            options.onChunk?.('Better text', ' text');
            await options.onComplete?.('Better text');
        });

        container = document.createElement('div');
        document.body.appendChild(container);

        const state = EditorState.create({
            doc: initialContent,
            extensions: createMarkdownExtensions({ mode: 'live' }),
        });
        view = new EditorView({ state, parent: container });
        editor = new CodeMirrorEditorAdapter(view);
    });

    it('parks the result in preview_ready without any commit or document mutation', async () => {
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        // Nothing was committed anywhere
        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(mockCommitAIReservation).not.toHaveBeenCalled();

        // The document remains pristine; preview text is held for the decision
        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.previewText).toBe('Better text');
    });

    it('rejectPreview settles the reservation as consumed and NEVER refunds it', async () => {
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        act(() => {
            result.current.rejectPreview();
        });

        // Quota policy: user rejection consumes the reservation — no refunds
        expect(mockCommitAIReservation).toHaveBeenCalledTimes(1);
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();

        // Ghost dismantled, document untouched, session released
        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.previewText).toBe('');
    });

    it('commitPreview performs the server-first commit then applies one atomic local replace', async () => {
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        mockCommitAIFileOperation.mockResolvedValueOnce({
            success: true,
            status: 'committed',
            version: 2,
            etag: 'etag-v2',
            updatedAt: new Date().toISOString(),
        });

        await act(async () => {
            await result.current.commitPreview();
        });

        expect(mockCommitAIFileOperation).toHaveBeenCalledTimes(1);
        expect(mockRefundAIReservation).not.toHaveBeenCalled();

        expect(editor.getValue()).toContain('Better text');
        expect(result.current.status).toBe('committed');
        // The preview panel must disappear on acceptance (same as rejection)
        expect(result.current.previewText).toBe('');
    });

    it('retryPreview settles the old reservation as consumed and starts a fresh stream', async () => {
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        mockConsumeAIStream.mockClear();

        await act(async () => {
            await result.current.retryPreview();
        });

        // Old reservation settled as consumed (user decision cost)
        expect(mockCommitAIReservation).toHaveBeenCalledTimes(1);
        expect(mockRefundAIReservation).not.toHaveBeenCalled();

        // A brand-new stream session started (fresh quota reservation path)
        expect(mockConsumeAIStream).toHaveBeenCalledTimes(1);
    });

    it('stopStream mid-generation settles the reservation as consumed and never refunds', async () => {
        // Stream stays open (never completes) to simulate an active generation
        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            options.onMeta?.({ sessionId: 's', operationId: 'op' });
            options.onChunk?.('Partial ', 'Partial ');
        });
        const snapshotBefore = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('streaming'));

        await act(async () => {
            await result.current.stopStream();
        });

        // USER-INITIATED STOP POLICY: compute spent up to the stop is consumed —
        // settlement wins over the server-side disconnect refund.
        expect(mockCommitAIReservation).toHaveBeenCalledTimes(1);
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(editor.getValue()).toBe(snapshotBefore);
        expect(result.current.status).toBe('aborted');
    });

    describe('Markdown EditorAdapter & Dynamic Ghost Range Shifting', () => {
        it('should dynamically map ghost range forward when user edits document during stream and commit accurately', async () => {
            const initialText = 'Line 1: Prefix text.\nLine 2: TARGET_TO_IMPROVE.\nLine 3: Suffix text.';
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const state = EditorState.create({
                doc: initialText,
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            // Select "TARGET_TO_IMPROVE"
            const targetStart = initialText.indexOf('TARGET_TO_IMPROVE');
            const targetEnd = targetStart + 'TARGET_TO_IMPROVE'.length;
            adapter.setSelection(targetStart, targetEnd);

            const { result } = renderAIStream();

            // Start stream
            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    operation: 'improve',
                    fileId: 'file-cm-1',
                    expectedVersion: 1,
                    originalEtag: 'etag-v1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));

            // Ghost is currently active at [targetStart, targetEnd]
            const ghostRangeBefore = adapter.getGhostRange?.();
            expect(ghostRangeBefore).toEqual({ from: targetStart, to: targetEnd });

            // SIMULATE CONCURRENT USER EDIT: User types 20 characters at the very beginning of the document
            const prefixAddition = 'EXTRA_PREFIX_CHARS!!';
            testView.dispatch({
                changes: { from: 0, to: 0, insert: prefixAddition },
            });

            // Dynamic Shifting: StateField must have automatically shifted ghost range forward!
            const ghostRangeAfter = adapter.getGhostRange?.();
            expect(ghostRangeAfter).toEqual({
                from: targetStart + prefixAddition.length,
                to: targetEnd + prefixAddition.length,
            });

            mockCommitAIFileOperation.mockResolvedValueOnce({
                success: true,
                status: 'committed',
                version: 2,
                etag: 'etag-v2',
                updatedAt: new Date().toISOString(),
            });

            // Accept / Commit preview
            await act(async () => {
                await result.current.commitPreview();
            });

            expect(result.current.status).toBe('committed');
            expect(mockCommitAIFileOperation).toHaveBeenCalledTimes(1);

            // Verify that replacement happened at the dynamically shifted position without corruption
            const currentDoc = adapter.getValue();
            expect(currentDoc).toContain(prefixAddition);
            expect(currentDoc).toContain('Better text');
            expect(currentDoc).not.toContain('TARGET_TO_IMPROVE');

            testView.destroy();
            testContainer.remove();
        });

        it('should immediately abort stream and clear ghost when user edits directly inside the target range', async () => {
            const initialText = 'Line 1: Prefix text.\nLine 2: TARGET_TO_IMPROVE.\nLine 3: Suffix text.';
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const state = EditorState.create({
                doc: initialText,
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            // Select "TARGET_TO_IMPROVE"
            const targetStart = initialText.indexOf('TARGET_TO_IMPROVE');
            const targetEnd = targetStart + 'TARGET_TO_IMPROVE'.length;
            adapter.setSelection(targetStart, targetEnd);

            const { result } = renderAIStream();

            // Start stream
            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    operation: 'improve',
                    fileId: 'file-cm-2',
                    expectedVersion: 1,
                    originalEtag: 'etag-v1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));
            expect(adapter.getGhostRange?.()).toEqual({ from: targetStart, to: targetEnd });

            // SIMULATE DIRECT COLLIDING EDIT: User deletes or modifies characters INSIDE the target range
            testView.dispatch({
                changes: { from: targetStart + 2, to: targetStart + 8, insert: 'MODIFIED' },
            });

            // Ghost range must be invalidated / cleared immediately
            expect(adapter.getGhostRange?.()).toBeNull();

            // Stream should transition to aborted via onStop callback
            await waitFor(() => expect(result.current.status).toBe('aborted'));

            testView.destroy();
            testContainer.remove();
        });

        it('should render unified inline widget with interactive buttons and trigger actions on click', async () => {
            const testContainer = document.createElement('div');
            document.body.appendChild(testContainer);

            const state = EditorState.create({
                doc: 'Original text to translate',
                extensions: createMarkdownExtensions({ mode: 'live' }),
            });
            const testView = new EditorView({ state, parent: testContainer });
            const adapter = createEditorAdapter(testView);

            const { result } = renderAIStream();

            await act(async () => {
                await result.current.startStream({
                    editor: adapter,
                    operation: 'translate',
                    fileId: 'file-widget-1',
                    expectedVersion: 1,
                    originalEtag: 'etag-1',
                    editorGeneration: 1,
                });
            });

            await waitFor(() => expect(result.current.status).toBe('preview_ready'));

            // Verify widget DOM exists inside editor
            const widgetElement = testContainer.querySelector('.cm-ai-ghost-widget');
            expect(widgetElement).not.toBeNull();
            expect(widgetElement?.textContent).toContain('معاينة الذكاء الاصطناعي (translate)');

            // Find interactive buttons
            const buttons = widgetElement?.querySelectorAll('button');
            expect(buttons?.length).toBe(3);

            const applyBtn = Array.from(buttons || []).find((b) => b.textContent?.includes('تطبيق التعديل'));
            expect(applyBtn).toBeDefined();

            mockCommitAIFileOperation.mockResolvedValueOnce({
                success: true,
                status: 'committed',
                version: 2,
                etag: 'etag-v2',
                updatedAt: new Date().toISOString(),
            });

            // Click Apply button directly in DOM
            await act(async () => {
                applyBtn?.click();
            });

            await waitFor(() => expect(result.current.status).toBe('committed'));
            expect(mockCommitAIFileOperation).toHaveBeenCalledTimes(1);

            testView.destroy();
            testContainer.remove();
        });
    });
});
