"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { getFile, updateFileContent, renameFile, deleteFile } from "@/server/actions/file-ops";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { convertTextToHTML } from "@/lib/parsers/text-to-html";
import { sanitizeHtml } from "@/lib/sanitize-client";
import { AutoDirectionExtension } from "@/lib/extensions/direction-extension";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import { SearchReplace } from "@/components/editor/search-replace";
import { countWords, debounce, detectTextDirection, countCharacters } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useSync } from "@/hooks/use-sync";
import { SyncIndicator } from "@/components/sync/sync-indicator";

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
        ],
        content: "",
        immediatelyRender: false, // Fix SSR hydration mismatch
        editorProps: {
            attributes: {
                class: "tiptap-editor outline-none min-h-[70vh] text-zinc-300 p-6",
            },
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
                    // Show local content immediately (sanitized — stored
                    // content may have been produced by an older client)
                    setTitle(localFile.title);
                    editor?.commands.setContent(sanitizeHtml(localFile.content || ""));
                    console.log('[Editor] Loaded from IndexedDB (instant)');
                }
            }

            // Step 2: Fetch from server in background
            const result = await getFile(fileId);

            if (!isMounted) return;

            if (result.success && result.data) {
                // Update title and content from server
                setTitle(result.data.title);

                // Only update editor if content is different (to avoid cursor jump)
                const currentContent = editor?.getHTML() || "";
                const serverContent = result.data.content || "";

                // Sanitize server content before it reaches TipTap:
                // DB content is user-controlled (imports, old clients),
                // so it must be treated as untrusted HTML.
                const safeContent = sanitizeHtml(serverContent);
                if (currentContent !== safeContent) {
                    editor?.commands.setContent(safeContent);
                    console.log('[Editor] Updated from server');
                }

                // Cache the server version locally
                if (syncHook.isInitialized) {
                    syncHook.saveLocal({
                        id: fileId,
                        content: safeContent,
                        title: result.data.title,
                    });
                }
            } else {
                // File doesn't exist on server and no local copy
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
            setSaving(true);

            // Save to server
            await updateFileContent(fileId, content);

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
        [fileId, title, syncHook.isInitialized]
    );

    useEffect(() => {
        if (editor) {
            editor.on("update", ({ editor }) => {
                saveContent(editor.getHTML());
            });
        }
    }, [editor, saveContent]);

    // Keyboard shortcut for search (Ctrl+F / Cmd+F)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                setIsSearchOpen(true);
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    // Track text selection for dynamic stats
    useEffect(() => {
        if (editor) {
            // Listen to selection updates
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

    // AI Operations
    //
    // CONTENT-SAFETY CONTRACT (v2):
    //  - The document is NEVER modified before the AI response arrives.
    //    The original HTML is snapshotted at the start of the operation.
    //  - Success: a SINGLE undoable transaction replaces the original range
    //    with the formatted AI result — one Ctrl+Z restores everything.
    //  - Failure (any error, mid-stream abort, quota, network):
    //    the document is restored to the exact snapshot (rollback). The
    //    user never loses content because of an AI operation.
    async function handleAIOperation(operation: "correct" | "improve" | "summarize" | "translate" | "toPrompt") {
        if (!editor) return;

        setIsLoading(true);
        setError(null);
        editor.setEditable(false);

        // Deterministic anchor for the AI range inside the current document.
        const { from, to } = editor.state.selection;
        const hasSelection = from !== to;
        const selectionStart = hasSelection ? from : 0;
        const selectionEnd = hasSelection ? to : editor.state.doc.content.size;

        try {
            // Get selected text or full content (read-only — nothing is mutated yet)
            const text = hasSelection
                ? editor.state.doc.textBetween(from, to)
                : editor.getText();

            if (!text.trim()) {
                setError("Please enter some text first");
                setIsLoading(false);
                editor.setEditable(true);
                return;
            }

            // Content snapshot taken BEFORE any fetch — the rollback anchor.
            snapshotFallback = editor.getHTML();

            const response = await fetch("/api/ai/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, operation }),
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || response.statusText);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("No response stream");

            const decoder = new TextDecoder();
            let collectedText = "";

            // Stream into a temporary buffer only — the live document stays
            // untouched until we know the AI response completed successfully.
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                collectedText += decoder.decode(value, { stream: true });
            }

            if (!collectedText.trim()) {
                // AI returned an empty result — treat as failure.
                throw new Error("AI returned an empty result");
            }

            // SUCCESS: apply as ONE undoable transaction.
            applyAITransaction(selectionStart, selectionEnd, collectedText);

        } catch (err: any) {
            console.error(err);
            setError(err.message || "An error occurred");
            // ROLLBACK: restore the document to the pre-operation snapshot.
            // The snapshot was taken before any network call, so this is an
            // exact restore — no content is ever lost mid-operation.
            editor.chain().setContent(snapshotFallback).run();
        } finally {
            setIsLoading(false);
            editor.setEditable(true);
        }
    }

    // Holds the pre-operation snapshot accessible from the catch clause.
    let snapshotFallback = "";

    /**
     * Apply the AI result as a single undoable transaction:
     * restore the exact original text at the anchor range, then replace it
     * with the formatted result in one history entry.
     */
    function applyAITransaction(
        selectionStart: number,
        selectionEnd: number,
        collectedText: string
    ): void {
        if (!editor) return;

        const html = convertTextToHTML(collectedText);

        // ONE undoable transaction: select the original range, delete it,
        // and insert the AI result. TipTap's chain().run() batches all
        // commands into a single history entry — one Ctrl+Z restores the
        // full original content of the selected range.
        editor.chain()
            .setTextSelection({ from: selectionStart, to: selectionEnd })
            .deleteSelection()
            .insertContent(html)
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
            // Dynamic import to avoid SSR issues
            const { exportContent, downloadBlob } = await import('@/lib/exporters');

            // Get content from editor
            const content = editor.getHTML();

            // Export content in the specified format
            const result = await exportContent(content, title || 'document', format);

            if (result.success && result.blob && result.filename) {
                // Trigger download
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
                canUndo={editor?.can().undo() || false}
                canRedo={editor?.can().redo() || false}
                isLoading={isLoading}
                showToPrompt={showToPrompt}
            />

            {/* Search and Replace Dialog */}
            <SearchReplace
                editor={editor}
                isOpen={isSearchOpen}
                onClose={() => setIsSearchOpen(false)}
            />

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

            {/* Loading Overlay */}
            {isLoading && (
                <div className="mx-6 mt-4 p-3 rounded-md bg-indigo-900/20 border border-indigo-500/30 text-indigo-300 text-sm flex items-center gap-2 flex-shrink-0">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Processing with AI...
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
