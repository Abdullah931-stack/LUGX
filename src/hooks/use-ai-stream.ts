'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Editor } from '@tiptap/react';
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
import { formatStreamOutputToHTML } from '@/lib/parsers/stream-markdown';
import { commitAIFileOperation, refundAIReservation } from '@/server/actions/ai-commit';
import { commitAIReservation } from '@/server/actions/ai-ops';
import { streamingGhostPluginKey } from '@/lib/extensions/streaming-ghost-extension';

export interface UseAIStreamOptions {
    onStreamStart?: () => void;
    onCommitSuccess?: (result: { version: number; etag: string }) => void;
    onConflict?: (serverVersion?: { version?: number | null; etag?: string | null }) => void;
    onError?: (error: Error) => void;
    /**
     * Wraps every programmatic document mutation (atomic AI commit, conflict rollback,
     * exception rollback) so the orchestrator can raise its `isProgrammaticUpdate`
     * guard and never misclassify these transactions as manual user edits.
     */
    onProgrammaticTransaction?: (fn: () => void) => void;
}

export interface StartStreamParams {
    editor: Editor;
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
    safeHtml: string;
}

export function useAIStream(options: UseAIStreamOptions = {}) {
    const [status, setStatus] = useState<AIStreamStatus>('idle');
    const [previewText, setPreviewText] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isConflict, setIsConflict] = useState<boolean>(false);

    const activeSessionRef = useRef<AIStreamSession | null>(null);
    const editorRef = useRef<Editor | null>(null);
    /** Sanitized result awaiting the user's Accept / Reject / Retry decision. */
    const pendingPreviewRef = useRef<PendingPreview | null>(null);
    /** Params of the most recent stream, enabling "Retry" with identical inputs. */
    const lastParamsRef = useRef<StartStreamParams | null>(null);

    // Clean up on unmount
    useEffect(() => {
        return () => {
            if (activeSessionRef.current) {
                const session = activeSessionRef.current;
                session.abortController.abort();
                previewBuffer.close(session.sessionId);
                if (session.status === 'streaming' || session.status === 'reserved') {
                    refundAIReservation(session.operationId, 'unmount_cleanup').catch(() => {});
                } else if (session.status === 'preview_ready') {
                    // Explicit Settlement Policy: generation completed successfully, so the
                    // compute cost is consumed even if the user never decided. Finalize the
                    // reservation as committed (idempotent, no document write) so a future
                    // TTL sweeper can never refund a fully generated result.
                    commitAIReservation(session.operationId).catch(() => {});
                }
                pendingPreviewRef.current = null;
            }
        };
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
     * Explicit Settlement helper (quota policy):
     * A user-decided rejection / retry / undecided teardown of a COMPLETED
     * generation must consume the reservation — never refund it. Marking the
     * reservation `committed` (idempotent, document untouched) pins the
     * speculative deduction so no TTL sweeper or stray refund can reverse it.
     */
    const settleReservationAsConsumed = useCallback((operationId: string): void => {
        commitAIReservation(operationId).catch(() => {});
    }, []);

    /**
     * Reject the completed preview: dismantle the ghost, keep the document
     * pristine, and settle the reservation as consumed (user decision cost).
     */
    const rejectPreview = useCallback((): void => {
        const session = activeSessionRef.current;
        if (!session || session.status !== 'preview_ready') return;

        try {
            session.abortController.abort();
            transitionSession(session, 'aborting');
            transitionSession(session, 'aborted');
            setStatus('aborted');

            if (editorRef.current && !editorRef.current.isDestroyed) {
                runAsProgrammaticTransaction(() => {
                    editorRef.current?.commands.clearStreamingGhost();
                });
            }

            settleReservationAsConsumed(session.operationId);
        } catch (err) {
            console.error('[useAIStream] Error rejecting preview:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            pendingPreviewRef.current = null;
            setPreviewText('');
            activeSessionRef.current = null;
        }
    }, [runAsProgrammaticTransaction, settleReservationAsConsumed]);

    /**
     * Stop / Abort the active AI streaming session.
     *
     * USER-INITIATED STOP POLICY (quota): stopping a running generation is the
     * user's decision — the compute spent up to that point is consumed and is
     * NEVER refunded. The reservation is therefore settled as committed BEFORE
     * the abort fires, guaranteeing the server-side disconnect refund handler
     * (`cancel()` in /api/ai/stream) no-ops with `already_committed` instead of
     * winning the race and reversing the charge. Genuine system failures
     * (mid-stream errors, startup errors, 412 conflicts) still refund.
     */
    const stopStream = useCallback(async () => {
        const session = activeSessionRef.current;
        if (!session) return;

        // If the session has already transitioned to a terminal status, release ref and skip aborting
        if (isTerminalStatus(session.status)) {
            activeSessionRef.current = null;
            return;
        }

        // ADV2-02 Inconsistency Guard: Committing state is atomic & in-flight on server, cannot be aborted
        if (session.status === 'committing') {
            console.warn('[useAIStream] Session is actively committing changes to database. Abort is suppressed.');
            return;
        }

        // Re-entry guard: a settlement round-trip is already in flight
        if (session.status === 'aborting') {
            return;
        }

        // A completed-but-undecided preview is a REJECTION, not a mid-generation
        // cancellation: settle the reservation as consumed instead of refunding it.
        if (session.status === 'preview_ready') {
            rejectPreview();
            return;
        }

        try {
            transitionSession(session, 'aborting');

            // Settle FIRST (await the round-trip), THEN tear down the stream —
            // this ordering guarantees the server-side disconnect refund can
            // never win the race against the explicit settlement.
            await commitAIReservation(session.operationId).catch(() => {});

            session.abortController.abort();
            transitionSession(session, 'aborted');
            setStatus('aborted');

            // Dismantle ghost preview in editor
            if (editorRef.current && !editorRef.current.isDestroyed) {
                editorRef.current.commands.clearStreamingGhost();
            }
        } catch (err) {
            console.error('[useAIStream] Error stopping stream:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            setPreviewText('');
            activeSessionRef.current = null;
        }
    }, [rejectPreview]);

    /**
     * Initiate an AI streaming operation with Ephemeral Preview & Atomic Commit
     */
    const startStream = useCallback(async ({
        editor,
        operation,
        fileId,
        expectedVersion,
        originalEtag,
        editorGeneration,
    }: StartStreamParams): Promise<void> => {
        if (!editor || editor.isDestroyed) return;

        // IN-FLIGHT MUTEX: Prevent duplicate / double-click triggering while a stream is actively running
        if (activeSessionRef.current && !isTerminalStatus(activeSessionRef.current.status)) {
            console.warn('[useAIStream] An active AI streaming session is already in progress. Ignoring duplicate trigger.');
            return;
        }

        lastParamsRef.current = { editor, operation, fileId, expectedVersion, originalEtag, editorGeneration };

        editorRef.current = editor;
        setError(null);
        setIsConflict(false);
        setPreviewText('');

        const { from, to } = editor.state.selection;
        const hasSelection = from !== to;
        const selectionStart = hasSelection ? from : 0;
        const selectionEnd = hasSelection ? to : editor.state.doc.content.size;

        const textToProcess = hasSelection
            ? editor.state.doc.textBetween(from, to)
            : editor.getText();

        if (!textToProcess.trim()) {
            setError('Please enter some text first');
            return;
        }

        const sessionId = `session_${crypto.randomUUID()}`;
        const operationId = `op_${crypto.randomUUID()}`;
        const abortController = new AbortController();

        const session = createStreamSession({
            sessionId,
            operationId,
            fileId,
            operation,
            originalHtml: editor.getHTML(),
            originalText: textToProcess,
            selection: { from: selectionStart, to: selectionEnd },
            expectedVersion,
            originalEtag,
            editorGeneration,
            abortController,
        });

        activeSessionRef.current = session;

        previewBuffer.open(sessionId);
        transitionSession(session, 'reserved');
        setStatus('reserved');
        options.onStreamStart?.();

        // Start ghost decoration layer in TipTap (zero doc node mutation)
        editor.commands.startStreamingGhost({
            from: selectionStart,
            to: selectionEnd,
            text: '',
            operation,
        });

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

                    // Append only the latest delta. Appending the accumulated text here
                    // would duplicate the buffer quadratically (O(n^2)) and corrupt
                    // previewBuffer.getText().
                    previewBuffer.append(sessionId, latestChunk);
                    setPreviewText(accumulated);

                    if (editor && !editor.isDestroyed) {
                        editor.commands.updateStreamingGhost(accumulated);
                    }
                },
                onComplete: async (finalRawText) => {
                    // Double Decision & Session Integrity Guard
                    if (
                        activeSessionRef.current?.sessionId !== sessionId ||
                        session.abortController.signal.aborted ||
                        isTerminalStatus(session.status)
                    ) {
                        return;
                    }

                    transitionSession(session, 'preview_ready');
                    setStatus('preview_ready');

                    // Format and sanitize final AI output
                    const { html: safeHtml, isEmpty } = formatStreamOutputToHTML(finalRawText);
                    if (isEmpty) {
                        throw new Error('AI produced an empty or invalid response');
                    }

                    // Check session integrity before commit
                    const integrity = assertSessionIntegrity(session, editorGeneration, expectedVersion);
                    if (!integrity.valid) {
                        throw new Error(`Integrity error: ${integrity.reason}`);
                    }

                    // Check again in case of user abort during format
                    if (session.abortController.signal.aborted || activeSessionRef.current?.sessionId !== sessionId) {
                        return;
                    }

                    // EXPLICIT DECISION MODEL: park the sanitized result and wait for the
                    // user's Accept / Reject / Retry decision. Neither the document, nor the
                    // server version, nor the quota reservation is touched until then.
                    pendingPreviewRef.current = {
                        sessionId,
                        operationId,
                        fileId,
                        expectedVersion,
                        originalEtag,
                        editorGeneration,
                        selectionStart,
                        selectionEnd,
                        safeHtml,
                    };
                },
                onError: (err) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    if (editor && !editor.isDestroyed) {
                        editor.commands.clearStreamingGhost();
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

                    // Auto-refund on failure
                    refundAIReservation(operationId, 'stream_error').catch(() => {});
                    options.onError?.(err);
                },
            });

        } catch (err) {
            const detailMessage = err instanceof Error ? err.message : "An unexpected error occurred";
            console.error('[useAIStream] Exception during execution:', err);
            if (activeSessionRef.current?.sessionId === sessionId) {
                if (editor && !editor.isDestroyed) {
                    runAsProgrammaticTransaction(() => {
                        editor.commands.clearStreamingGhost();
                        // USER DATA PROTECTION (AUD-02): Never overwrite user's manual edits
                        if (editorGeneration === session.editorGeneration && session.originalHtml && editor.getHTML() !== session.originalHtml) {
                            editor.chain().setContent(session.originalHtml).run();
                        }
                    });
                }

                setError(detailMessage || 'An unexpected error occurred');
                transitionSession(session, 'failed', detailMessage);
                setStatus('failed');
                refundAIReservation(operationId, 'exception_caught').catch(() => {});
                activeSessionRef.current = null;
            }
        } finally {
            if (activeSessionRef.current?.sessionId === sessionId) {
                previewBuffer.close(sessionId);
            }
        }
    }, [options, runAsProgrammaticTransaction]);

    /**
     * Accept the completed preview: server-first atomic commit, then a single
     * atomic ProseMirror transaction replacing [from, to]. Only this action —
     * not stream completion — mutates the document and finalizes the operation.
     */
    const commitPreview = useCallback(async (): Promise<void> => {
        const session = activeSessionRef.current;
        const pending = pendingPreviewRef.current;

        if (!session || !pending || session.status !== 'preview_ready' || session.sessionId !== pending.sessionId) {
            return;
        }

        const editor = editorRef.current;
        const { operationId, fileId, expectedVersion, originalEtag, editorGeneration, selectionStart, selectionEnd, safeHtml } = pending;

        transitionSession(session, 'committing');
        setStatus('committing');

        try {
            // STEP 1: Server Atomic Commit
            const commitResult = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion,
                expectedETag: originalEtag,
                resultContent: safeHtml,
            });

            // Check if session was aborted during network commit
            if (session.abortController.signal.aborted || activeSessionRef.current?.sessionId !== session.sessionId) {
                return;
            }

            // Handle Version Conflict (412)
            if (commitResult.status === 'conflict') {
                setIsConflict(true);
                setError(commitResult.error);
                transitionSession(session, 'conflict');
                setStatus('conflict');

                if (editor && !editor.isDestroyed) {
                    runAsProgrammaticTransaction(() => {
                        editor.commands.clearStreamingGhost();
                        // USER DATA PROTECTION (AUD-02): Only rollback if editor generation hasn't changed
                        if (editorGeneration === session.editorGeneration && session.originalHtml && editor.getHTML() !== session.originalHtml) {
                            editor.chain().setContent(session.originalHtml).run();
                        }
                    });
                }

                // Auto-refund reservation on conflict (system condition, not a user decision)
                await refundAIReservation(operationId, 'version_conflict');
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

            // STEP 2: Local Atomic TipTap Commit (1 Transaction in History)
            if (editor && !editor.isDestroyed) {
                // ADV-04 Fix: Retrieve dynamic, mapped selection coordinates from ProseMirror plugin state
                const ghostState = streamingGhostPluginKey.getState(editor.state);
                const docSize = editor.state.doc.content.size;
                const targetFrom = ghostState?.active
                    ? Math.max(0, Math.min(ghostState.from, docSize))
                    : Math.max(0, Math.min(selectionStart, docSize));
                const targetTo = ghostState?.active
                    ? Math.max(targetFrom, Math.min(ghostState.to, docSize))
                    : Math.max(targetFrom, Math.min(selectionEnd, docSize));

                runAsProgrammaticTransaction(() => {
                    editor.commands.clearStreamingGhost();

                    editor.chain()
                        .setTextSelection({ from: targetFrom, to: targetTo })
                        .deleteSelection()
                        .insertContent(safeHtml)
                        .run();
                });
            }

            transitionSession(session, 'committed');
            setStatus('committed');
            activeSessionRef.current = null;
            pendingPreviewRef.current = null;
            // Hide the preview panel on acceptance — the decision is final and
            // the output now lives inside the document itself.
            setPreviewText('');
            options.onCommitSuccess?.({
                version: commitResult.version ?? expectedVersion,
                etag: commitResult.etag ?? (originalEtag || ''),
            });
        } catch (err) {
            const detailMessage = err instanceof Error ? err.message : 'Preview commit failed';
            console.error('[useAIStream] Preview commit error:', err);

            if (editor && !editor.isDestroyed) {
                runAsProgrammaticTransaction(() => {
                    editor.commands.clearStreamingGhost();
                });
            }

            setError(detailMessage);
            transitionSession(session, 'failed', detailMessage);
            setStatus('failed');
            activeSessionRef.current = null;
            pendingPreviewRef.current = null;

            // Commit failure is a system condition, not a user decision: refund.
            refundAIReservation(operationId, 'commit_error').catch(() => {});
            options.onError?.(err instanceof Error ? err : new Error(detailMessage));
        }
    }, [options, runAsProgrammaticTransaction]);

    /**
     * Retry the last AI operation with the same feature and original text.
     * The completed preview's reservation is settled as consumed (user decision
     * cost — never refunded) and a brand-new session reserves fresh quota.
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
