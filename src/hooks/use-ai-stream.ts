'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Editor } from '@tiptap/react';
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
import { formatStreamOutputToHTML, validateStreamMarkdownOutput } from '@/lib/parsers/stream-markdown';
import { commitAIFileOperation, refundAIReservation } from '@/server/actions/ai-commit';
import { commitAIReservation, getAIReservationStatus } from '@/server/actions/ai-ops';
import { streamingGhostPluginKey } from '@/lib/extensions/streaming-ghost-extension';
import {
    trackPendingAIOperation,
    updatePendingAIOperationPhase,
    clearPendingAIOperation,
    listPendingAIOperations,
} from '@/lib/ai/pending-operation-store';

export interface UseAIStreamOptions {
    onStreamStart?: () => void;
    onCommitSuccess?: (result: { version: number; etag: string }) => void;
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
}

export type EditorInstance = EditorAdapter | Editor | any;

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
    safeHtml: string;
}

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

    // Helper to safely invoke ghost methods across both EditorAdapter and TipTap
    const clearGhostDecoration = useCallback((editor: EditorInstance | null): void => {
        if (!editor || editor.isDestroyed) return;
        if (typeof editor.clearStreamingGhost === 'function') {
            editor.clearStreamingGhost();
        } else if (editor.commands?.clearStreamingGhost) {
            editor.commands.clearStreamingGhost();
        }
    }, []);

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
                clearPendingAIOperation(session.operationId);
                pendingPreviewRef.current = null;
            }
        };
    }, []);

    // Phase 11 (hard-reload recovery): React cleanup never runs on a HARD page
    // reload, so pending-operation records surviving in sessionStorage are
    // settled here on the next mount. The abandoned preview is NEVER applied
    // to the document and NEVER treated as committed - the server document is
    // re-fetched by the orchestrator's initial-load pipeline as the single
    // source of truth. Settlement follows the v1.6.0 quota policy:
    // - preview_ready (completed generation): consumed (commitAIReservation)
    // - generating (lost mid-generation reservation): refundAIReservation
    useEffect(() => {
        const orphans = listPendingAIOperations();
        if (orphans.length === 0) return;

        for (const record of orphans) {
            void (async () => {
                try {
                    const status = await getAIReservationStatus(record.operationId);
                    if (status.found && status.status === 'reserved') {
                        if (record.phase === 'preview_ready') {
                            await commitAIReservation(record.operationId);
                        } else {
                            await refundAIReservation(record.operationId, 'reload_recovery');
                        }
                    }
                    clearPendingAIOperation(record.operationId);
                } catch {
                    // Transient failure: keep the record so a later mount retries.
                }
            })();
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
                    clearGhostDecoration(editorRef.current);
                });
            }

            settleReservationAsConsumed(session.operationId);
        } catch (err) {
            console.error('[useAIStream] Error rejecting preview:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            clearPendingAIOperation(session.operationId);
            pendingPreviewRef.current = null;
            setPreviewText('');
            activeSessionRef.current = null;
        }
    }, [clearGhostDecoration, runAsProgrammaticTransaction, settleReservationAsConsumed]);

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

        const selection = typeof editor.getSelection === 'function'
            ? editor.getSelection()
            : (editor.state?.selection || { from: 0, to: 0 });
        const from = selection.from ?? 0;
        const to = selection.to ?? 0;
        const hasSelection = from !== to;
        const docSize = typeof editor.getCharCount === 'function'
            ? editor.getCharCount()
            : (editor.state?.doc?.content?.size || editor.getText?.().length || 0);
        const selectionStart = hasSelection ? from : 0;
        const selectionEnd = hasSelection ? to : docSize;

        const textToProcess = hasSelection
            ? (typeof editor.getSelectedText === 'function'
                ? editor.getSelectedText()
                : (editor.state?.doc?.textBetween(from, to) || ''))
            : (typeof editor.getValue === 'function'
                ? editor.getValue()
                : (editor.getText?.() || ''));

        if (!textToProcess.trim()) {
            setError('Please enter some text first');
            return;
        }

        const sessionId = `session_${crypto.randomUUID()}`;
        const operationId = `op_${crypto.randomUUID()}`;
        const abortController = new AbortController();

        const originalContent = typeof editor.getValue === 'function'
            ? editor.getValue()
            : (editor.getHTML?.() || '');

        const session = createStreamSession({
            sessionId,
            operationId,
            fileId,
            operation,
            originalMarkdown: originalContent,
            originalHtml: originalContent,
            originalText: textToProcess,
            selection: { from: selectionStart, to: selectionEnd },
            expectedVersion,
            originalEtag,
            editorGeneration,
            abortController,
        });

        activeSessionRef.current = session;
        // Phase 11: durable tab-scoped record enabling hard-reload recovery.
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
        } else if (editor.commands?.startStreamingGhost) {
            editor.commands.startStreamingGhost({
                from: selectionStart,
                to: selectionEnd,
                text: '',
                operation,
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

                    // Append only the latest delta to previewBuffer
                    previewBuffer.append(sessionId, latestChunk);
                    setPreviewText(accumulated);

                    if (editor && !editor.isDestroyed) {
                        if (typeof editor.updateStreamingGhost === 'function') {
                            editor.updateStreamingGhost(accumulated, true);
                        } else if (editor.commands?.updateStreamingGhost) {
                            editor.commands.updateStreamingGhost(accumulated);
                        }
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
                    updatePendingAIOperationPhase(operationId, 'preview_ready');

                    // Validate pure Markdown output
                    const { markdown: validatedMarkdown, isEmpty } = validateStreamMarkdownOutput(finalRawText);
                    if (isEmpty) {
                        throw new Error('AI produced an empty or invalid response');
                    }

                    // Format ephemeral HTML for UI preview badge if requested
                    const { html: safeHtml } = formatStreamOutputToHTML(finalRawText);

                    // Check session integrity before preparing preview decision
                    const integrity = assertSessionIntegrity(session, editorGeneration, expectedVersion);
                    if (!integrity.valid) {
                        throw new Error(`Integrity error: ${integrity.reason}`);
                    }

                    // Check again in case of user abort during format
                    if (session.abortController.signal.aborted || activeSessionRef.current?.sessionId !== sessionId) {
                        return;
                    }

                    // Update ghost widget state to preview_ready (switching action buttons to Reject/Retry/Apply)
                    if (editor && !editor.isDestroyed) {
                        if (typeof editor.updateStreamingGhost === 'function') {
                            editor.updateStreamingGhost(validatedMarkdown, false);
                        }
                    }

                    // EXPLICIT DECISION MODEL: park the validated Markdown result and wait for the
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
                        resultMarkdown: validatedMarkdown,
                        safeHtml,
                    };
                },
                onError: (err) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    if (editor && !editor.isDestroyed) {
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

                    // Auto-refund on failure
                    refundAIReservation(operationId, 'stream_error').catch(() => {});
                    clearPendingAIOperation(operationId);
                    options.onError?.(err);
                },
            });

        } catch (err) {
            const detailMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
            console.error('[useAIStream] Exception during execution:', err);
            if (activeSessionRef.current?.sessionId === sessionId) {
                if (editor && !editor.isDestroyed) {
                    runAsProgrammaticTransaction(() => {
                        clearGhostDecoration(editor);
                        // USER DATA PROTECTION (AUD-02): Never overwrite user's manual edits
                        if (editorGeneration === session.editorGeneration && session.originalMarkdown) {
                            if (typeof editor.setValue === 'function' && editor.getValue() !== session.originalMarkdown) {
                                editor.setValue(session.originalMarkdown);
                            } else if (typeof editor.chain === 'function' && editor.getHTML() !== (session.originalHtml || session.originalMarkdown)) {
                                editor.chain().setContent(session.originalHtml || session.originalMarkdown).run();
                            }
                        }
                    });
                }

                setError(detailMessage || 'An unexpected error occurred');
                transitionSession(session, 'failed', detailMessage);
                setStatus('failed');
                refundAIReservation(operationId, 'exception_caught').catch(() => {});
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
     * Accept the completed preview: server-first atomic commit on pure Markdown,
     * then a single atomic editor transaction replacing the dynamically tracked [from, to] range.
     * Only this action — not stream completion — mutates the document and finalizes the operation.
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
            safeHtml,
        } = pending;

        transitionSession(session, 'committing');
        setStatus('committing');

        try {
            // Dynamic Position Resolution: Query current shifted ghost range from CodeMirror StateField
            const ghostRange = typeof editor?.getGhostRange === 'function'
                ? editor.getGhostRange()
                : null;
            const currentDocLength = typeof editor?.getCharCount === 'function'
                ? editor.getCharCount()
                : (typeof editor?.getValue === 'function' ? editor.getValue().length : (editor?.state?.doc?.content?.size || 0));

            const targetFrom = ghostRange ? ghostRange.from : Math.max(0, Math.min(selectionStart, currentDocLength));
            const targetTo = ghostRange ? ghostRange.to : Math.max(targetFrom, Math.min(selectionEnd, currentDocLength));

            // Compute server Markdown content
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

            // STEP 1: Server Atomic Commit on raw Markdown
            const effectiveExpectedVersion = typeof options.getLatestVersion === 'function'
                ? options.getLatestVersion()
                : expectedVersion;
            const effectiveExpectedETag = typeof options.getLatestETag === 'function'
                ? options.getLatestETag()
                : originalEtag;

            const commitResult = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion: effectiveExpectedVersion,
                expectedETag: effectiveExpectedETag || undefined,
                resultContent: finalDocumentMarkdown,
                originalContent: session.originalMarkdown || session.originalHtml || undefined,
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
                        clearGhostDecoration(editor);
                        // USER DATA PROTECTION (AUD-02): Only rollback if editor generation hasn't changed
                        if (editorGeneration === session.editorGeneration && session.originalMarkdown) {
                            if (typeof editor.setValue === 'function' && editor.getValue() !== session.originalMarkdown) {
                                editor.setValue(session.originalMarkdown);
                            } else if (typeof editor.chain === 'function' && editor.getHTML() !== (session.originalHtml || session.originalMarkdown)) {
                                editor.chain().setContent(session.originalHtml || session.originalMarkdown).run();
                            }
                        }
                    });
                }

                // Auto-refund reservation on conflict (system condition, not a user decision)
                await refundAIReservation(operationId, 'version_conflict');
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

            // STEP 2: Local Atomic Commit (1 Transaction in History)
            if (editor && !editor.isDestroyed) {
                runAsProgrammaticTransaction(() => {
                    if (typeof editor.replaceRange === 'function') {
                        // CodeMirror Markdown EditorAdapter: query latest dynamic range before clearing
                        const latestGhost = typeof editor.getGhostRange === 'function' ? editor.getGhostRange() : null;
                        const docLen = typeof editor.getCharCount === 'function'
                            ? editor.getCharCount()
                            : (typeof editor.getValue === 'function' ? editor.getValue().length : 0);
                        const actualFrom = latestGhost ? latestGhost.from : Math.max(0, Math.min(targetFrom, docLen));
                        const actualTo = latestGhost ? latestGhost.to : Math.max(actualFrom, Math.min(targetTo, docLen));

                        editor.replaceRange(actualFrom, actualTo, resultMarkdown);
                    } else if (typeof editor.chain === 'function') {
                        // TipTap Editor fallback
                        const ghostState = streamingGhostPluginKey.getState(editor.state);
                        const docSize = editor.state?.doc?.content?.size || 0;
                        const tFrom = ghostState?.active
                            ? Math.max(0, Math.min(ghostState.from, docSize))
                            : Math.max(0, Math.min(selectionStart, docSize));
                        const tTo = ghostState?.active
                            ? Math.max(tFrom, Math.min(ghostState.to, docSize))
                            : Math.max(tFrom, Math.min(selectionEnd, docSize));

                        editor.chain()
                            .setTextSelection({ from: tFrom, to: tTo })
                            .deleteSelection()
                            .insertContent(safeHtml || resultMarkdown)
                            .run();
                    }

                    clearGhostDecoration(editor);
                });
            }

            transitionSession(session, 'committed');
            setStatus('committed');
            clearPendingAIOperation(operationId);
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
                    clearGhostDecoration(editor);
                });
            }

            setError(detailMessage);
            transitionSession(session, 'failed', detailMessage);
            setStatus('failed');
            activeSessionRef.current = null;
            pendingPreviewRef.current = null;

            // Commit failure is a system condition, not a user decision: refund.
            refundAIReservation(operationId, 'commit_error').catch(() => {});
            clearPendingAIOperation(operationId);
            options.onError?.(err instanceof Error ? err : new Error(detailMessage));
        }
    }, [clearGhostDecoration, options, runAsProgrammaticTransaction]);

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

    // Sync callback refs with latest closures
    commitPreviewRef.current = commitPreview;
    rejectPreviewRef.current = rejectPreview;
    retryPreviewRef.current = retryPreview;
    stopStreamRef.current = stopStream;

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

