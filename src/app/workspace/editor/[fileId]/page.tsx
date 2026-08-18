"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { getFile, updateFileContent, renameFile, deleteFile } from "@/server/actions/file-ops";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { convertTextToHTML } from "@/lib/parsers/text-to-html";
import { sanitizeHtml } from "@/lib/sanitize-client";
import { AutoDirectionExtension } from "@/lib/extensions/direction-extension";
import { StreamingGhostExtension } from "@/lib/extensions/streaming-ghost-extension";
import { consumeAIStream, AIOperationType } from "@/lib/ai/stream-handler";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import { SearchReplace } from "@/components/editor/search-replace";
import { countWords, debounce, detectTextDirection, countCharacters } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSync } from "@/hooks/use-sync";
import { SyncIndicator } from "@/components/sync/sync-indicator";
import { FEATURES } from "@/config/features.config";
import { useAIStream } from "@/hooks/use-ai-stream";
import { AIStreamStatus } from "@/components/editor/ai-stream-status";
import { AIStreamPreview } from "@/components/editor/ai-stream-preview";

export default function EditorPage() {
    const params = useParams();
    const router = useRouter();
    const fileId = params.fileId as string;

    const [title, setTitle] = useState("");
    const [saving, setSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [showToPrompt, setShowToPrompt] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [selectedText, setSelectedText] = useState("");
    const [userId, setUserId] = useState<string | null>(null);

    // Invariant tracking refs for generation guard and optimistic version lock
    const fileVersionRef = useRef<number>(1);
    const fileEtagRef = useRef<string | null>(null);
    const editorGenerationRef = useRef<number>(1);

    // Abort controller ref for legacy AI streaming fallback
    const abortControllerRef = useRef<AbortController | null>(null);

    // Initialize useSync hook (only when userId is available)
    const syncHook = useSync({
        userId: userId || "",
        autoSyncInterval: 30000,
    });

    const editor = useEditor({
        extensions: [
            StarterKit,
            Placeholder.configure({
                placeholder: "Start writing...",
                emptyEditorClass: "is-editor-empty",
            }),
            AutoDirectionExtension,
            StreamingGhostExtension,
        ],
        content: "",
        immediatelyRender: false, // Fix SSR hydration mismatch
        editorProps: {
            attributes: {
                class: "tiptap-editor outline-none min-h-[70vh] text-zinc-300 p-6",
            },
        },
    });

    // Modern Ephemeral UI Streaming Hook
    const aiStream = useAIStream({
        onCommitSuccess: ({ version, etag }) => {
            fileVersionRef.current = version;
            fileEtagRef.current = etag;
            editorGenerationRef.current += 1;
            setLastSaved(new Date());

            if (syncHook.isInitialized && editor) {
                syncHook.saveLocal({
                    id: fileId,
                    content: editor.getHTML(),
                    title,
                });
            }
        },
        onConflict: (serverVersion) => {
            console.warn('[Editor] AI commit version conflict detected:', serverVersion);
        },
        onError: (err) => {
            setError(err.message);
        },
    });

    // Load file content - Offline-First approach
    useEffect(() => {
        let isMounted = true;

        async function loadFile() {
            // Step 1: Try to load from IndexedDB first (instant)
            if (syncHook.isInitialized) {
                const localFile = await syncHook.loadLocal(fileId);
                if (localFile && isMounted) {
                    setTitle(localFile.title);
                    fileVersionRef.current = localFile.version || 1;
                    fileEtagRef.current = localFile.etag || null;
                    editorGenerationRef.current += 1;
                    editor?.commands.setContent(sanitizeHtml(localFile.content || ""));
                    console.log('[Editor] Loaded from IndexedDB (instant)');
                }
            }

            // Step 2: Fetch from server in background
            const result = await getFile(fileId);

            if (!isMounted) return;

            if (result.success && result.data) {
                setTitle(result.data.title);
                fileVersionRef.current = result.data.version ?? 1;
                fileEtagRef.current = result.data.etag ?? null;
                editorGenerationRef.current += 1;

                const currentContent = editor?.getHTML() || "";
                const serverContent = result.data.content || "";

                const safeContent = sanitizeHtml(serverContent);
                if (currentContent !== safeContent) {
                    editor?.commands.setContent(safeContent);
                    console.log('[Editor] Updated from server');
                }

                if (syncHook.isInitialized) {
                    syncHook.saveLocal({
                        id: fileId,
                        content: safeContent,
                        title: result.data.title,
                    });
                }
            } else {
                const localFile = await syncHook.loadLocal(fileId);
                if (!localFile) {
                    router.push("/workspace");
                }
            }
        }

        if (fileId && editor) {
            loadFile();
        }

        return () => { isMounted = false; };
    }, [fileId, editor, router, syncHook.isInitialized]);

    // Fetch userId from Supabase client
    useEffect(() => {
        async function fetchUser() {
            const supabase = createClient();
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                setUserId(user.id);
            }
        }
        fetchUser();
    }, []);

    // Check ToPrompt availability
    useEffect(() => {
        async function checkQuota() {
            const quota = await getRemainingQuota();
            setShowToPrompt(quota?.toPrompt !== null);
        }
        checkQuota();
    }, []);

    // Auto-save with debounce (server + local for sync)
    const saveContent = useCallback(
        debounce(async (content: string) => {
            // G5: Do NOT auto-save during active AI streaming or committing
            if (aiStream.isLoading) {
                return;
            }

            setSaving(true);

            // Save to server
            const saveRes = await updateFileContent(fileId, content);
            if (saveRes.success && saveRes.version) {
                fileVersionRef.current = saveRes.version;
                fileEtagRef.current = saveRes.etag || null;
                editorGenerationRef.current += 1;
            }

            // Also save locally for offline/sync
            if (syncHook.isInitialized) {
                await syncHook.saveLocal({
                    id: fileId,
                    content,
                    title,
                });
            }

            setLastSaved(new Date());
            setSaving(false);
        }, 1000),
        [fileId, title, syncHook.isInitialized, aiStream.isLoading]
    );

    useEffect(() => {
        if (editor) {
            editor.on("update", ({ editor }) => {
                saveContent(editor.getHTML());
            });
        }
    }, [editor, saveContent]);

    // Track text selection for dynamic stats
    useEffect(() => {
        if (editor) {
            const handleSelectionUpdate = () => {
                const { from, to } = editor.state.selection;
                const text = editor.state.doc.textBetween(from, to, ' ');
                setSelectedText(text);
            };

            editor.on('selectionUpdate', handleSelectionUpdate);

            return () => {
                editor.off('selectionUpdate', handleSelectionUpdate);
            };
        }
    }, [editor]);

    // AI Operations with Ephemeral View Streaming & Single-Action Atomic Undo
    async function handleAIOperation(operation: AIOperationType) {
        if (!editor) return;

        // Modern UI Streaming (Gated behind feature flag during foundation phase)
        if (FEATURES.AI_STREAMING_ENABLED) {
            await aiStream.startStream({
                editor,
                operation,
                fileId,
                expectedVersion: fileVersionRef.current,
                originalEtag: fileEtagRef.current,
                editorGeneration: editorGenerationRef.current,
            });
            return;
        }

        // Fallback: Safe snapshot & buffered accumulator path
        setIsLoading(true);
        setError(null);

        // Deterministic anchor for the AI range inside the current document
        const { from, to } = editor.state.selection;
        const hasSelection = from !== to;
        const selectionStart = hasSelection ? from : 0;
        const selectionEnd = hasSelection ? to : editor.state.doc.content.size;

        // Content snapshot taken BEFORE any network activity — the rollback anchor
        const snapshotBefore = editor.getHTML();

        // Instantiate AbortController for user cancellation
        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        try {
            const text = hasSelection
                ? editor.state.doc.textBetween(from, to)
                : editor.getText();

            if (!text.trim()) {
                setError("Please enter some text first");
                setIsLoading(false);
                return;
            }

            // Initialize ephemeral streaming ghost preview (doc model remains pristine)
            editor.commands.startStreamingGhost({
                from: selectionStart,
                to: selectionEnd,
                text: "",
                operation,
            });

            await consumeAIStream({
                operation,
                text,
                signal: abortController.signal,
                onChunk: (accumulatedText) => {
                    if (editor && !editor.isDestroyed) {
                        editor.commands.updateStreamingGhost(accumulatedText);
                    }
                },
                onComplete: (finalText) => {
                    if (!editor || editor.isDestroyed) return;

                    // Dismantle the ephemeral preview
                    editor.commands.clearStreamingGhost();

                    // SUCCESS: Apply as ONE atomic undoable transaction
                    applyAITransaction(selectionStart, selectionEnd, finalText);
                },
                onError: (err) => {
                    if (!editor || editor.isDestroyed) return;

                    // Dismantle the ephemeral preview
                    editor.commands.clearStreamingGhost();

                    if (err.name === "AbortError") {
                        return;
                    }

                    setError(err.message || "حدث خطأ أثناء معالجة النص");

                    // ROLLBACK DEFENSE: ensure document matches pre-operation snapshot
                    if (snapshotBefore && editor.getHTML() !== snapshotBefore) {
                        editor.chain().setContent(snapshotBefore).run();
                    }
                },
            });

        } catch (err: any) {
            console.error("[AI Editor Error]", err);
            if (editor && !editor.isDestroyed) {
                editor.commands.clearStreamingGhost();
                if (snapshotBefore && editor.getHTML() !== snapshotBefore) {
                    editor.chain().setContent(snapshotBefore).run();
                }
            }
            setError(err?.message || "حدث خطأ غير متوقع أثناء معالجة النص");
        } finally {
            abortControllerRef.current = null;
            setIsLoading(false);
        }
    }

    /**
     * Instantly cancel/stop active AI streaming generation
     */
    function handleStopAI() {
        if (FEATURES.AI_STREAMING_ENABLED) {
            aiStream.stopStream();
            return;
        }

        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        if (editor && !editor.isDestroyed) {
            editor.commands.clearStreamingGhost();
        }
        setIsLoading(false);
    }

    // Keyboard shortcuts (Ctrl+F for search, Escape for stopping AI generation)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                setIsSearchOpen(true);
            } else if (e.key === 'Escape' && (isLoading || aiStream.isLoading)) {
                handleStopAI();
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isLoading, aiStream.isLoading]);

    /**
     * Apply the AI result as a single undoable transaction:
     * select the original range, delete it, and insert the sanitized AI result
     * in one history entry.
     */
    function applyAITransaction(
        selectionStart: number,
        selectionEnd: number,
        collectedText: string
    ): void {
        if (!editor) return;

        const html = convertTextToHTML(collectedText);
        const safeHtml = sanitizeHtml(html);

        editor.chain()
            .setTextSelection({ from: selectionStart, to: selectionEnd })
            .deleteSelection()
            .insertContent(safeHtml)
            .run();
    }

    // Title update
    async function handleTitleChange(newTitle: string) {
        setTitle(newTitle);
        await renameFile(fileId, newTitle);
    }

    // Delete file
    async function handleDelete() {
        if (confirm("Are you sure you want to delete this document?")) {
            await deleteFile(fileId);
            router.push("/workspace");
        }
    }

    // Copy to clipboard
    function handleCopy() {
        if (editor) {
            navigator.clipboard.writeText(editor.getText());
        }
    }

    // Toggle search and replace dialog
    function handleSearch() {
        setIsSearchOpen(!isSearchOpen);
    }

    // Export document in multiple formats (MD, TXT only)
    async function handleExport(format: 'md' | 'txt' = 'txt') {
        if (!editor) return;

        try {
            const { exportContent, downloadBlob } = await import('@/lib/exporters');
            const content = editor.getHTML();
            const result = await exportContent(content, title || 'document', format);

            if (result.success && result.blob && result.filename) {
                downloadBlob(result.blob, result.filename);
            } else {
                setError(result.error || 'Export failed');
            }
        } catch (err) {
            setError('Export failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
            console.error('Export error:', err);
        }
    }

    // Calculate stats based on selection or full text
    const textToAnalyze = selectedText || (editor?.getText() || "");
    const isSelection = selectedText.length > 0;
    const wordCount = countWords(textToAnalyze);
    const charCount = countCharacters(textToAnalyze);
    const textDir = detectTextDirection(textToAnalyze);

    const activeLoading = FEATURES.AI_STREAMING_ENABLED ? aiStream.isLoading : isLoading;

    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* AI Toolbar - Fixed position */}
            <AIToolbar
                onCorrect={() => handleAIOperation("correct")}
                onImprove={() => handleAIOperation("improve")}
                onSummarize={() => handleAIOperation("summarize")}
                onTranslate={() => handleAIOperation("translate")}
                onToPrompt={() => handleAIOperation("toPrompt")}
                onUndo={() => editor?.commands.undo()}
                onRedo={() => editor?.commands.redo()}
                onExport={handleExport}
                onCopy={handleCopy}
                onSearch={handleSearch}
                onStop={handleStopAI}
                canUndo={editor?.can().undo() || false}
                canRedo={editor?.can().redo() || false}
                isLoading={activeLoading}
                showToPrompt={showToPrompt}
            />

            {/* Search and Replace Dialog */}
            <SearchReplace
                editor={editor}
                isOpen={isSearchOpen}
                onClose={() => setIsSearchOpen(false)}
            />

            {/* AI Stream Ephemeral Status & Conflict Alerts */}
            {FEATURES.AI_STREAMING_ENABLED && (
                <AIStreamStatus
                    status={aiStream.status}
                    isConflict={aiStream.isConflict}
                    errorMessage={aiStream.error}
                    onRetry={() => aiStream.reset()}
                    onCancel={() => aiStream.stopStream()}
                />
            )}

            {/* Error Message */}
            {error && (
                <div className="mx-6 mt-4 p-3 rounded-md bg-red-900/20 border border-red-800/50 text-red-300 text-sm flex-shrink-0">
                    {error}
                    <button
                        className="ml-2 text-red-400 hover:text-red-300"
                        onClick={() => setError(null)}
                    >
                        Dismiss
                    </button>
                </div>
            )}

            {/* Editor - Scrollable container */}
            <div className="flex-1 overflow-auto custom-scrollbar">
                <EditorContent editor={editor} className="max-w-4xl mx-auto" />
            </div>

            {/* Status Bar - Fixed at bottom */}
            <div className="border-t border-zinc-800/50 px-4 py-2 flex items-center justify-between text-xs text-zinc-500 flex-shrink-0">
                {/* Left: File Title */}
                <span className="truncate max-w-[200px]" title={title}>
                    {title || "Untitled"}
                </span>

                {/* Center: Save Status Indicator */}
                <div className="flex items-center gap-2">
                    <span>Save</span>
                    {saving ? (
                        <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                    ) : lastSaved ? (
                        <div className="w-2 h-2 rounded-full bg-green-500/70 blur-[1px]" />
                    ) : (
                        <div className="w-2 h-2 rounded-full bg-red-500/70 blur-[1px]" />
                    )}

                    {/* Sync Status Indicator */}
                    {userId && (
                        <SyncIndicator
                            status={syncHook.status}
                            connectionState={syncHook.connectionState}
                            pendingCount={syncHook.pendingCount}
                            lastSyncResult={syncHook.lastSyncResult}
                            onSyncNow={() => syncHook.sync()}
                            compact={true}
                        />
                    )}
                </div>

                {/* Right: Stats (Words + Characters) + Text Direction */}
                <div className="flex items-center gap-3">
                    {isSelection && (
                        <span className="text-indigo-400 text-xs">Selected:</span>
                    )}
                    <span title={`${wordCount.toLocaleString()} word${wordCount !== 1 ? 's' : ''}`}>
                        {wordCount.toLocaleString()} words
                    </span>
                    <span className="text-zinc-700">|</span>
                    <span title={`${charCount.toLocaleString()} character${charCount !== 1 ? 's' : ''}`}>
                        {charCount.toLocaleString()} chars
                    </span>
                    <span className="uppercase">{textDir}</span>
                </div>
            </div>
        </div>
    );
}
