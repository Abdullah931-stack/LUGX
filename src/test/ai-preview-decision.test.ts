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
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { StreamingGhostExtension } from '@/lib/extensions/streaming-ghost-extension';
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
    let editor: Editor;
    let capturedCallbacks: ConsumeCallbacks;
    const initialContent = '<p>The quick brown fox jumps over the lazy dog.</p>';

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

        capturedCallbacks = {} as ConsumeCallbacks;
        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            capturedCallbacks = options;
            // Default successful stream: meta → chunk → done
            options.onMeta?.({ sessionId: 's', operationId: 'op' });
            options.onChunk?.('Better text', ' text');
            await options.onComplete?.('Better text');
        });

        editor = new Editor({
            extensions: [StarterKit, StreamingGhostExtension],
            content: initialContent,
        });
    });
    it('parks the result in preview_ready without any commit or document mutation', async () => {
        const snapshotBefore = editor.getHTML();
        const { result } = renderAIStream();

        await startDefaultStream(result);
        await waitFor(() => expect(result.current.status).toBe('preview_ready'));

        // Nothing was committed anywhere
        expect(mockCommitAIFileOperation).not.toHaveBeenCalled();
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(mockCommitAIReservation).not.toHaveBeenCalled();

        // The document remains pristine; preview text is held for the decision
        expect(editor.getHTML()).toBe(snapshotBefore);
        expect(result.current.previewText).toBe('Better text');
    });

    it('rejectPreview settles the reservation as consumed and NEVER refunds it', async () => {
        const snapshotBefore = editor.getHTML();
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
        expect(editor.getHTML()).toBe(snapshotBefore);
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

        expect(editor.getHTML()).toContain('Better text');
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
            capturedCallbacks = options;
            options.onMeta?.({ sessionId: 's', operationId: 'op' });
            options.onChunk?.('Partial ', 'Partial ');
        });
        const snapshotBefore = editor.getHTML();
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
        expect(editor.getHTML()).toBe(snapshotBefore);
        expect(result.current.status).toBe('aborted');
    });
});
