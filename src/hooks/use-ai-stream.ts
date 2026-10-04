'use client';

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import type { EditorAdapter } from '@/components/editor/markdown/types';
import {
    AIStreamSession,
    AIStreamStatus,
    createStreamSession,
    transitionSession,
    assertSessionIntegrity,
    isTerminalStatus,
} from '@/lib/ai/stream-session';
import { previewBuffer } from '@/lib/ai/preview-buffer';
import { consumeAIStream, AIOperationType } from '@/lib/ai/stream-handler';
import { validateStreamMarkdownOutput } from '@/lib/parsers/stream-markdown';
import { commitAIFileOperation } from '@/server/actions/ai-commit';
import {
    trackPendingAIOperation,
    updatePendingAIOperationPhase,
    clearPendingAIOperation,
    listPendingAIOperations,
} from '@/lib/ai/pending-operation-store';
import type { FileEncryptionMetadata } from '@/types/storage-payload';

export interface UseAIStreamOptions {
    onStreamStart?: () => void;
    onCommitSuccess?: (result: { version: number; etag: string; committedContent?: string; encryptionMetadata?: FileEncryptionMetadata | null }) => void;
    onConflict?: (serverVersion?: { version?: number | null; etag?: string | null }) => void;
    onError?: (error: Error) => void;
    getLatestVersion?: () => number;
    getLatestETag?: () => string | null;
    /**
     * Wraps every programmatic document mutation (atomic AI commit, conflict rollback,
     * exception rollback) so the orchestrator can raise its `isProgrammaticUpdate`
     * guard and never misclassify these transactions as manual user edits.
     */
    onProgrammaticTransaction?: (fn: () => void) => void;
    /**
     * Optional pre-commit hook (e.g. for Zero-Knowledge client-side encryption).
     * Transforms the raw Markdown into the persisted payload (ciphertext + metadata).
     */
    transformCommitPayload?: (finalContent: string) => Promise<{
        content: string;
        encryptionMetadata?: FileEncryptionMetadata | null;
    }>;
}

export type EditorInstance = EditorAdapter;

export interface StartStreamParams {
    editor: EditorInstance;
    operation: AIOperationType;
    fileId: string;
    expectedVersion: number;
    originalEtag: string | null;
    editorGeneration: number;
}

/**
 * Sanitized AI output parked while the session rests in `preview_ready`,
 * awaiting an explicit user decision (Accept / Reject / Retry).
 */
interface PendingPreview {
    sessionId: string;
    operationId: string;
    fileId: string;
    expectedVersion: number;
    originalEtag: string | null;
    editorGeneration: number;
    selectionStart: number;
    selectionEnd: number;
    resultMarkdown: string;
}

/**
 * useAIStream: Client-side AI streaming hook.
 *
 * PHASE 11 COMPLIANCE:
 * 1. Zero client-side financial authority: no refund or commit RPC calls originate from the client.
 * 2. Settlement is strictly Server-Authoritative: the /api/ai/stream route manages commit/refund.
 * 3. Reject/Retry/Stop dismantle local ephemeral preview decorations cleanly without financial side-effects.
 * 4. Document persistence on Accept executes via commitAIFileOperation with optimistic concurrency control.
 */
export function useAIStream(options: UseAIStreamOptions = {}) {
    const [status, setStatus] = useState<AIStreamStatus>('idle');
    const [previewText, setPreviewText] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isConflict, setIsConflict] = useState<boolean>(false);

    const activeSessionRef = useRef<AIStreamSession | null>(null);
    const editorRef = useRef<EditorInstance | null>(null);
    /** Sanitized result awaiting the user's Accept / Reject / Retry decision. */
    const pendingPreviewRef = useRef<PendingPreview | null>(null);
    /** Params of the most recent stream, enabling "Retry" with identical inputs. */
    const lastParamsRef = useRef<StartStreamParams | null>(null);

    // Callbacks refs for inline widget actions
    const commitPreviewRef = useRef<(() => Promise<void>) | null>(null);
    const rejectPreviewRef = useRef<(() => void) | null>(null);
    const retryPreviewRef = useRef<(() => Promise<void>) | null>(null);
    const stopStreamRef = useRef<(() => Promise<void>) | null>(null);

    // Helper to safely invoke ghost methods on EditorAdapter
    const clearGhostDecoration = useCallback((editor: EditorInstance | null): void => {
        if (!editor) return;
        if (typeof editor.clearStreamingGhost === 'function') {
            editor.clearStreamingGhost();
        }
    }, []);

    // Clean up on unmount: abort stream and clear client state (server handles settlement autonomously)
    useEffect(() => {
        return () => {
            if (activeSessionRef.current) {
                const session = activeSessionRef.current;
                session.abortController.abort();
                previewBuffer.close(session.sessionId);
                clearPendingAIOperation(session.operationId);
                pendingPreviewRef.current = null;
            }
        };
    }, []);

    // Clean up orphaned tab-scoped pending operation records
    useEffect(() => {
        const orphans = listPendingAIOperations();
        if (orphans.length === 0) return;
        for (const record of orphans) {
            clearPendingAIOperation(record.operationId);
        }
    }, []);

    /**
     * Routes every document mutation through the orchestrator's programmatic-update
     * guard so editor "update" events are never misclassified as manual edits.
     */
    const runAsProgrammaticTransaction = useCallback((fn: () => void): void => {
        if (options.onProgrammaticTransaction) {
            options.onProgrammaticTransaction(fn);
        } else {
            fn();
        }
    }, [options]);

    /**
     * Reject the completed preview: dismantle the ghost decoration and keep the document pristine.
     * The server already committed the compute spent during streaming.
     */
    const rejectPreview = useCallback((): void => {
        const session = activeSessionRef.current;
        if (!session || session.status !== 'preview_ready') return;

        try {
            session.abortController.abort();
            transitionSession(session, 'aborting');
            transitionSession(session, 'aborted');
            setStatus('aborted');

            if (editorRef.current) {
                runAsProgrammaticTransaction(() => {
                    clearGhostDecoration(editorRef.current);
                });
            }
        } catch (err) {
            console.error('[useAIStream] Error rejecting preview:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            clearPendingAIOperation(session.operationId);
            pendingPreviewRef.current = null;
            setPreviewText('');
            activeSessionRef.current = null;
        }
    }, [clearGhostDecoration, runAsProgrammaticTransaction]);

    /**
     * Stop / Abort the active AI streaming session immediately (< 15ms).
     * Server route disconnect handler autonomously commits post-TTFT or refunds pre-TTFT.
     */
    const stopStream = useCallback(async () => {
        const session = activeSessionRef.current;
        if (!session) return;

        if (isTerminalStatus(session.status)) {
            activeSessionRef.current = null;
            return;
        }

        if (session.status === 'committing') {
            console.warn('[useAIStream] Session is actively committing changes to database. Abort is suppressed.');
            return;
        }

        if (session.status === 'aborting') {
            return;
        }

        if (session.status === 'preview_ready') {
            rejectPreview();
            return;
        }

        try {
            // Immediately abort the fetch stream socket (0ms latency)
            session.abortController.abort();
            transitionSession(session, 'aborted');
            setStatus('aborted');

            // Dismantle ghost preview in editor immediately
            if (editorRef.current) {
                clearGhostDecoration(editorRef.current);
            }
        } catch (err) {
            console.error('[useAIStream] Error stopping stream:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            setPreviewText('');
            clearPendingAIOperation(session.operationId);
            activeSessionRef.current = null;
        }
    }, [clearGhostDecoration, rejectPreview]);

    /**
     * Initiate an AI streaming operation with Ephemeral Preview
     */
    const startStream = useCallback(async ({
        editor,
        operation,
        fileId,
        expectedVersion,
        originalEtag,
        editorGeneration,
    }: StartStreamParams): Promise<void> => {
        if (!editor) return;

        // IN-FLIGHT MUTEX: Prevent duplicate triggering while a stream is actively running
        if (activeSessionRef.current && !isTerminalStatus(activeSessionRef.current.status)) {
            console.warn('[useAIStream] An active AI streaming session is already in progress. Ignoring duplicate trigger.');
            return;
        }

        lastParamsRef.current = { editor, operation, fileId, expectedVersion, originalEtag, editorGeneration };

        editorRef.current = editor;
        setError(null);
        setIsConflict(false);
        setPreviewText('');

        const selection = typeof editor.getSelection === 'function'
            ? editor.getSelection()
            : { from: 0, to: 0 };
        const from = selection.from ?? 0;
        const to = selection.to ?? 0;
        const hasSelection = from !== to;
        const docSize = typeof editor.getCharCount === 'function'
            ? editor.getCharCount()
            : (typeof editor.getValue === 'function' ? editor.getValue().length : 0);
        const selectionStart = hasSelection ? from : 0;
        const selectionEnd = hasSelection ? to : docSize;

        const textToProcess = hasSelection
            ? (typeof editor.getSelectedText === 'function'
                ? editor.getSelectedText()
                : '')
            : (typeof editor.getValue === 'function'
                ? editor.getValue()
                : '');

        if (!textToProcess.trim()) {
            setError('Please enter some text first');
            return;
        }

        const sessionId = `session_${crypto.randomUUID()}`;
        const operationId = `op_${crypto.randomUUID()}`;
        const abortController = new AbortController();

        const originalContent = typeof editor.getValue === 'function'
            ? editor.getValue()
            : '';

        const session = createStreamSession({
            sessionId,
            operationId,
            fileId,
            operation,
            originalMarkdown: originalContent,
            originalText: textToProcess,
            selection: { from: selectionStart, to: selectionEnd },
            expectedVersion,
            originalEtag,
            editorGeneration,
            abortController,
        });

        activeSessionRef.current = session;
        trackPendingAIOperation(operationId, fileId, 'generating');

        previewBuffer.open(sessionId);
        transitionSession(session, 'reserved');
        setStatus('reserved');
        options.onStreamStart?.();

        // Start ghost decoration layer in editor (zero doc mutation)
        if (typeof editor.startStreamingGhost === 'function') {
            editor.startStreamingGhost({
                from: selectionStart,
                to: selectionEnd,
                text: '',
                operation,
                isStreaming: true,
                onApply: () => { void commitPreviewRef.current?.(); },
                onReject: () => { rejectPreviewRef.current?.(); },
                onRetry: () => { void retryPreviewRef.current?.(); },
                onStop: () => { void stopStreamRef.current?.(); },
            });
        }

        try {
            await consumeAIStream({
                operation,
                text: textToProcess,
                operationId,
                fileId,
                expectedVersion,
                signal: abortController.signal,
                onMeta: (meta) => {
                    if (activeSessionRef.current?.sessionId === sessionId) {
                        session.reservationId = meta.reservationId;
                        transitionSession(session, 'streaming');
                        setStatus('streaming');
                    }
                },
                onChunk: (accumulated, latestChunk) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    previewBuffer.append(sessionId, latestChunk);
                    setPreviewText(accumulated);

                    if (editor) {
                        if (typeof editor.updateStreamingGhost === 'function') {
                            editor.updateStreamingGhost(accumulated, true);
                        }
                    }
                },
                onComplete: async (finalRawText) => {
                    if (
                        activeSessionRef.current?.sessionId !== sessionId ||
                        session.abortController.signal.aborted ||
                        isTerminalStatus(session.status)
                    ) {
                        return;
                    }

                    transitionSession(session, 'preview_ready');
                    setStatus('preview_ready');
                    updatePendingAIOperationPhase(operationId, 'preview_ready');

                    const { markdown: validatedMarkdown, isEmpty } = validateStreamMarkdownOutput(finalRawText);
                    if (isEmpty) {
                        throw new Error('AI produced an empty or invalid response');
                    }

                    const integrity = assertSessionIntegrity(session, editorGeneration, expectedVersion);
                    if (!integrity.valid) {
                        throw new Error(`Integrity error: ${integrity.reason}`);
                    }

                    if (session.abortController.signal.aborted || activeSessionRef.current?.sessionId !== sessionId) {
                        return;
                    }

                    if (editor) {
                        if (typeof editor.updateStreamingGhost === 'function') {
                            editor.updateStreamingGhost(validatedMarkdown, false);
                        }
                    }

                    pendingPreviewRef.current = {
                        sessionId,
                        operationId,
                        fileId,
                        expectedVersion,
                        originalEtag,
                        editorGeneration,
                        selectionStart,
                        selectionEnd,
                        resultMarkdown: validatedMarkdown,
                    };
                },
                onError: (err) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    if (editor) {
                        clearGhostDecoration(editor);
                    }

                    if (err.name === 'AbortError') {
                        setStatus('aborted');
                        activeSessionRef.current = null;
                        return;
                    }

                    setError(err.message || 'Stream processing failed');
                    transitionSession(session, 'failed', err.message);
                    setStatus('failed');
                    activeSessionRef.current = null;
                    clearPendingAIOperation(operationId);
                    options.onError?.(err);
                },
            });

        } catch (err) {
            const detailMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
            console.error('[useAIStream] Exception during execution:', err);
            if (activeSessionRef.current?.sessionId === sessionId) {
                if (editor) {
                    runAsProgrammaticTransaction(() => {
                        clearGhostDecoration(editor);
                        if (editorGeneration === session.editorGeneration && session.originalMarkdown) {
                            if (typeof editor.setValue === 'function' && editor.getValue() !== session.originalMarkdown) {
                                editor.setValue(session.originalMarkdown);
                            }
                        }
                    });
                }

                setError(detailMessage || 'An unexpected error occurred');
                transitionSession(session, 'failed', detailMessage);
                setStatus('failed');
                clearPendingAIOperation(operationId);
                activeSessionRef.current = null;
            }
        } finally {
            if (activeSessionRef.current?.sessionId === sessionId) {
                previewBuffer.close(sessionId);
            }
        }
    }, [clearGhostDecoration, options, runAsProgrammaticTransaction]);

    /**
     * Accept the completed preview: persists changes to database via commitAIFileOperation
     * and updates the local editor state atomically.
     */
    const commitPreview = useCallback(async (): Promise<void> => {
        const session = activeSessionRef.current;
        const pending = pendingPreviewRef.current;

        if (!session || !pending || session.status !== 'preview_ready' || session.sessionId !== pending.sessionId) {
            return;
        }

        const editor = editorRef.current;
        const {
            operationId,
            fileId,
            expectedVersion,
            originalEtag,
            editorGeneration,
            selectionStart,
            selectionEnd,
            resultMarkdown,
        } = pending;

        transitionSession(session, 'committing');
        setStatus('committing');

        try {
            const ghostRange = typeof editor?.getGhostRange === 'function'
                ? editor.getGhostRange()
                : null;
            const currentDocLength = typeof editor?.getCharCount === 'function'
                ? editor.getCharCount()
                : (typeof editor?.getValue === 'function' ? editor.getValue().length : 0);

            const targetFrom = ghostRange ? ghostRange.from : Math.max(0, Math.min(selectionStart, currentDocLength));
            const targetTo = ghostRange ? ghostRange.to : Math.max(targetFrom, Math.min(selectionEnd, currentDocLength));

            let finalDocumentMarkdown: string;
            if (typeof editor?.getValue === 'function') {
                const currentFullContent = editor.getValue();
                const isFullDoc = targetFrom === 0 && targetTo >= currentFullContent.length;
                finalDocumentMarkdown = isFullDoc
                    ? resultMarkdown
                    : currentFullContent.slice(0, targetFrom) + resultMarkdown + currentFullContent.slice(targetTo);
            } else {
                finalDocumentMarkdown = resultMarkdown;
            }

            const effectiveExpectedVersion = typeof options.getLatestVersion === 'function'
                ? options.getLatestVersion()
                : expectedVersion;
            const effectiveExpectedETag = typeof options.getLatestETag === 'function'
                ? options.getLatestETag()
                : originalEtag;

            let contentToCommit = finalDocumentMarkdown;
            let encryptionMetadataToCommit: FileEncryptionMetadata | null | undefined = undefined;

            if (typeof options.transformCommitPayload === 'function') {
                const transformed = await options.transformCommitPayload(finalDocumentMarkdown);
                contentToCommit = transformed.content;
                encryptionMetadataToCommit = transformed.encryptionMetadata;
            }

            const commitResult = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion: effectiveExpectedVersion,
                expectedETag: effectiveExpectedETag || undefined,
                resultContent: contentToCommit,
                encryptionMetadata: encryptionMetadataToCommit,
                originalContent: session.originalMarkdown || undefined,
            });

            if (session.abortController.signal.aborted || activeSessionRef.current?.sessionId !== session.sessionId) {
                return;
            }

            if (commitResult.status === 'conflict') {
                setIsConflict(true);
                setError(commitResult.error);
                transitionSession(session, 'conflict');
                setStatus('conflict');

                if (editor) {
                    runAsProgrammaticTransaction(() => {
                        clearGhostDecoration(editor);
                        if (editorGeneration === session.editorGeneration && session.originalMarkdown) {
                            if (typeof editor.setValue === 'function' && editor.getValue() !== session.originalMarkdown) {
                                editor.setValue(session.originalMarkdown);
                            }
                        }
                    });
                }

                clearPendingAIOperation(operationId);
                activeSessionRef.current = null;
                pendingPreviewRef.current = null;
                options.onConflict?.(commitResult.serverVersion);
                return;
            }

            if (!commitResult.success || (commitResult.status !== 'committed' && commitResult.status !== 'already_committed')) {
                const errMessage = ('error' in commitResult && typeof commitResult.error === 'string')
                    ? commitResult.error
                    : 'Server commit failed';
                throw new Error(errMessage);
            }

            // Local Atomic Commit: apply replacement to editor
            if (editor) {
                runAsProgrammaticTransaction(() => {
                    if (typeof editor.replaceRange === 'function') {
                        const latestGhost = typeof editor.getGhostRange === 'function' ? editor.getGhostRange() : null;
                        const docLen = typeof editor.getCharCount === 'function'
                            ? editor.getCharCount()
                            : (typeof editor.getValue === 'function' ? editor.getValue().length : 0);
                        const actualFrom = latestGhost ? latestGhost.from : Math.max(0, Math.min(targetFrom, docLen));
                        const actualTo = latestGhost ? latestGhost.to : Math.max(actualFrom, Math.min(targetTo, docLen));

                        editor.replaceRange(actualFrom, actualTo, resultMarkdown);
                    }

                    clearGhostDecoration(editor);
                });
            }

            transitionSession(session, 'committed');
            setStatus('committed');
            clearPendingAIOperation(operationId);
            activeSessionRef.current = null;
            pendingPreviewRef.current = null;
            setPreviewText('');
            options.onCommitSuccess?.({
                version: commitResult.version ?? expectedVersion,
                etag: commitResult.etag ?? (originalEtag || ''),
                committedContent: contentToCommit,
                encryptionMetadata: encryptionMetadataToCommit,
            });
        } catch (err) {
            const detailMessage = err instanceof Error ? err.message : 'Preview commit failed';
            console.error('[useAIStream] Preview commit error:', err);

            if (editor) {
                runAsProgrammaticTransaction(() => {
                    clearGhostDecoration(editor);
                });
            }

            setError(detailMessage);
            transitionSession(session, 'failed', detailMessage);
            setStatus('failed');
            activeSessionRef.current = null;
            pendingPreviewRef.current = null;
            clearPendingAIOperation(operationId);
            options.onError?.(err instanceof Error ? err : new Error(detailMessage));
        }
    }, [clearGhostDecoration, options, runAsProgrammaticTransaction]);

    /**
     * Retry the last AI operation with the same feature and original text.
     */
    const retryPreview = useCallback(async (): Promise<void> => {
        const params = lastParamsRef.current;
        if (!params) return;

        rejectPreview();
        await startStream(params);
    }, [rejectPreview, startStream]);

    const reset = useCallback(async () => {
        await stopStream();
        setStatus('idle');
        setError(null);
        setIsConflict(false);
        setPreviewText('');
    }, [stopStream]);

    // Sync callback refs with latest closures
    useLayoutEffect(() => {
        commitPreviewRef.current = commitPreview;
        rejectPreviewRef.current = rejectPreview;
        retryPreviewRef.current = retryPreview;
        stopStreamRef.current = stopStream;
    }, [commitPreview, rejectPreview, retryPreview, stopStream]);

    return {
        status,
        previewText,
        error,
        isConflict,
        isLoading: status === 'reserved' || status === 'streaming' || status === 'committing',
        isStreaming: status === 'streaming',
        isCommitting: status === 'committing',
        isPreviewReady: status === 'preview_ready',
        startStream,
        stopStream,
        reset,
        commitPreview,
        rejectPreview,
        retryPreview,
    };
}
