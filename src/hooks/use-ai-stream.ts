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

export interface UseAIStreamOptions {
    onStreamStart?: () => void;
    onCommitSuccess?: (result: { version: number; etag: string }) => void;
    onConflict?: (serverVersion?: { version?: number | null; etag?: string | null }) => void;
    onError?: (error: Error) => void;
}

export interface StartStreamParams {
    editor: Editor;
    operation: AIOperationType;
    fileId: string;
    expectedVersion: number;
    originalEtag: string | null;
    editorGeneration: number;
}

export function useAIStream(options: UseAIStreamOptions = {}) {
    const [status, setStatus] = useState<AIStreamStatus>('idle');
    const [previewText, setPreviewText] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isConflict, setIsConflict] = useState<boolean>(false);

    const activeSessionRef = useRef<AIStreamSession | null>(null);
    const editorRef = useRef<Editor | null>(null);

    // Clean up on unmount
    useEffect(() => {
        return () => {
            if (activeSessionRef.current) {
                const session = activeSessionRef.current;
                session.abortController.abort();
                previewBuffer.close(session.sessionId);
                if (session.status === 'streaming' || session.status === 'reserved') {
                    refundAIReservation(session.operationId, 'unmount_cleanup').catch(() => {});
                }
            }
        };
    }, []);

    /**
     * Stop / Abort the active AI streaming session
     */
    const stopStream = useCallback(() => {
        const session = activeSessionRef.current;
        if (!session) return;

        // If the session has already transitioned to a terminal status, release ref and skip aborting
        if (isTerminalStatus(session.status)) {
            activeSessionRef.current = null;
            return;
        }

        try {
            session.abortController.abort();
            transitionSession(session, 'aborting');
            transitionSession(session, 'aborted');
            setStatus('aborted');

            // Dismantle ghost preview in editor
            if (editorRef.current && !editorRef.current.isDestroyed) {
                editorRef.current.commands.clearStreamingGhost();
            }

            // Trigger server-side quota refund
            refundAIReservation(session.operationId, 'user_cancelled').catch(() => {});

        } catch (err) {
            console.error('[useAIStream] Error stopping stream:', err);
        } finally {
            previewBuffer.close(session.sessionId);
            setPreviewText('');
            activeSessionRef.current = null;
        }
    }, []);

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
                onChunk: (accumulated) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    previewBuffer.append(sessionId, accumulated);
                    setPreviewText(accumulated);

                    if (editor && !editor.isDestroyed) {
                        editor.commands.updateStreamingGhost(accumulated);
                    }
                },
                onComplete: async (finalRawText) => {
                    if (activeSessionRef.current?.sessionId !== sessionId) return;

                    transitionSession(session, 'completed');
                    setStatus('completed');

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

                    // STEP 1: Server Atomic Commit
                    transitionSession(session, 'committing');
                    setStatus('committing');

                    const commitResult = await commitAIFileOperation({
                        operationId,
                        fileId,
                        expectedVersion,
                        expectedETag: originalEtag,
                        resultContent: safeHtml,
                    });

                    // Handle Version Conflict (412)
                    if (commitResult.status === 'conflict') {
                        setIsConflict(true);
                        setError(commitResult.error);
                        transitionSession(session, 'rolled_back');
                        setStatus('rolled_back');

                        if (editor && !editor.isDestroyed) {
                            editor.commands.clearStreamingGhost();
                            // USER DATA PROTECTION (AUD-02): Only rollback if editor generation hasn't changed
                            if (editorGeneration === session.editorGeneration && session.originalHtml && editor.getHTML() !== session.originalHtml) {
                                editor.chain().setContent(session.originalHtml).run();
                            }
                        }

                        // Auto-refund reservation on conflict
                        await refundAIReservation(operationId, 'version_conflict');
                        activeSessionRef.current = null;
                        options.onConflict?.(commitResult.serverVersion);
                        return;
                    }

                    if (!commitResult.success || commitResult.status !== 'committed') {
                        const errMessage = ('error' in commitResult && typeof commitResult.error === 'string')
                            ? commitResult.error
                            : 'Server commit failed';
                        throw new Error(errMessage);
                    }

                    // STEP 2: Local Atomic TipTap Commit (1 Transaction in History)
                    if (editor && !editor.isDestroyed) {
                        editor.commands.clearStreamingGhost();

                        editor.chain()
                            .setTextSelection({ from: selectionStart, to: selectionEnd })
                            .deleteSelection()
                            .insertContent(safeHtml)
                            .run();
                    }

                    transitionSession(session, 'committed');
                    setStatus('committed');
                    activeSessionRef.current = null;
                    options.onCommitSuccess?.({
                        version: commitResult.version,
                        etag: commitResult.etag,
                    });
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

        } catch (err: any) {
            console.error('[useAIStream] Exception during execution:', err);
            if (activeSessionRef.current?.sessionId === sessionId) {
                if (editor && !editor.isDestroyed) {
                    editor.commands.clearStreamingGhost();
                    // USER DATA PROTECTION (AUD-02): Never overwrite user's manual edits
                    if (editorGeneration === session.editorGeneration && session.originalHtml && editor.getHTML() !== session.originalHtml) {
                        editor.chain().setContent(session.originalHtml).run();
                    }
                }

                setError(err?.message || 'An unexpected error occurred');
                transitionSession(session, 'failed', err?.message);
                setStatus('failed');
                refundAIReservation(operationId, 'exception_caught').catch(() => {});
                activeSessionRef.current = null;
            }
        } finally {
            if (activeSessionRef.current?.sessionId === sessionId) {
                previewBuffer.close(sessionId);
            }
        }
    }, [options]);

    const reset = useCallback(() => {
        stopStream();
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
        startStream,
        stopStream,
        reset,
    };
}
