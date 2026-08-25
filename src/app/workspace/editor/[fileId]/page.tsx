"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { AutoDirectionExtension } from "@/lib/extensions/direction-extension";
import { StreamingGhostExtension } from "@/lib/extensions/streaming-ghost-extension";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import { SearchReplace } from "@/components/editor/search-replace";
import { countWords, detectTextDirection, countCharacters } from "@/lib/utils";
import { Loader2, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SyncIndicator } from "@/components/sync/sync-indicator";
import { AIStreamStatus } from "@/components/editor/ai-stream-status";
import { AIStreamPreview } from "@/components/editor/ai-stream-preview";
import { ConflictDialog } from "@/components/sync/conflict-dialog";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";

export default function EditorPage() {
    const params = useParams();
    const router = useRouter();
    const fileId = params.fileId as string;

    const [userId, setUserId] = useState<string | null>(null);
    const [showToPrompt, setShowToPrompt] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const [selectedText, setSelectedText] = useState("");

    // Initialize TipTap Editor Instance
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
        immediatelyRender: false,
        editorProps: {
            attributes: {
                class: "tiptap-editor outline-none min-h-[70vh] text-zinc-300 p-6",
            },
        },
    });

    // Stabilized navigation callback: a fresh arrow per render previously leaked into
    // the orchestrator's initial-load effect dependencies and re-triggered a full
    // server fetch + setContent cycle on every render (visible as text vanishing
    // mid-typing while background sync ran).
    const handleNavigate = useCallback((path: string) => router.push(path), [router]);

    // Centralized Editor Orchestrator (Phase 9 / Gate G9)
    const {
        title,
        hydration,

        aiStatus,
        previewText,
        isStreaming,
        isCommitting,
        isAIActive,
        aiError,
        isAIConflict,
        startAIOperation,
        stopAIOperation,
        resetAI,
        commitAIPreview,
        rejectAIPreview,
        retryAIPreview,

        isSaving,
        lastSaved,
        error,
        setError,

        activeConflict,
        isConflictDialogOpen,
        setIsConflictDialogOpen,
        isResolvingConflict,
        handleResolveConflict,

        syncHook,
        handleEditorChange,
    } = useEditorOrchestrator({
        fileId,
        userId,
        editor,
        onNavigate: handleNavigate,
    });

    // Bind TipTap update stream to Orchestrator with manual edit detection
    useEffect(() => {
        if (editor) {
            const onUpdate = ({ editor: currentEditor }: { editor: Editor }) => {
                handleEditorChange(currentEditor.getHTML());
            };
            editor.on("update", onUpdate);

            return () => {
                editor.off("update", onUpdate);
            };
        }
    }, [editor, handleEditorChange]);

    // Fetch authenticated user ID
    useEffect(() => {
        async function fetchUser() {
            try {
                const supabase = createClient();
                const {
                    data: { user },
                } = await supabase.auth.getUser();
                if (user) {
                    setUserId(user.id);
                }
            } catch (authErr) {
                console.warn("[Editor] fetchUser network exception:", authErr);
            }
        }
        fetchUser();
    }, []);

    // Check ToPrompt availability
    useEffect(() => {
        async function checkQuota() {
            try {
                const quota = await getRemainingQuota();
                setShowToPrompt(quota?.toPrompt !== null);
            } catch (quotaErr) {
                console.warn("[Editor] checkQuota error:", quotaErr);
            }
        }
        checkQuota();
    }, []);

    // Track text selection for dynamic stats
    useEffect(() => {
        if (editor) {
            const handleSelectionUpdate = () => {
                const { from, to } = editor.state.selection;
                const text = editor.state.doc.textBetween(from, to, " ");
                setSelectedText(text);
            };

            editor.on("selectionUpdate", handleSelectionUpdate);

            return () => {
                editor.off("selectionUpdate", handleSelectionUpdate);
            };
        }
    }, [editor]);

    // Keyboard shortcuts (Ctrl+F for search, Escape for stopping AI generation)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "f") {
                e.preventDefault();
                setIsSearchOpen(true);
            } else if (e.key === "Escape" && isAIActive) {
                stopAIOperation();
            }
        };

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isAIActive, stopAIOperation]);

    // Copy to clipboard
    const handleCopy = useCallback(() => {
        if (editor) {
            navigator.clipboard.writeText(editor.getText());
        }
    }, [editor]);

    // Toggle search and replace dialog
    const handleSearch = useCallback(() => {
        setIsSearchOpen((prev) => !prev);
    }, []);

    // Export document in multiple formats (MD, TXT)
    const handleExport = useCallback(
        async (format: "md" | "txt" = "txt") => {
            if (!editor) return;

            try {
                const { exportContent, downloadBlob } = await import("@/lib/exporters");
                const content = editor.getHTML();
                const result = await exportContent(content, title || "document", format);

                if (result.success && result.blob && result.filename) {
                    downloadBlob(result.blob, result.filename);
                } else {
                    setError(result.error || "Export failed");
                }
            } catch (err) {
                setError("Export failed: " + (err instanceof Error ? err.message : "Unknown error"));
                console.error("Export error:", err);
            }
        },
        [editor, title, setError]
    );

    // Text stats computation
    const textToAnalyze = selectedText || editor?.getText() || "";
    const isSelection = selectedText.length > 0;
    const wordCount = countWords(textToAnalyze);
    const charCount = countCharacters(textToAnalyze);
    const textDir = detectTextDirection(textToAnalyze);

    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* AI Toolbar - Fixed position */}
            <AIToolbar
                onCorrect={() => startAIOperation("correct")}
                onImprove={() => startAIOperation("improve")}
                onSummarize={() => startAIOperation("summarize")}
                onTranslate={() => startAIOperation("translate")}
                onToPrompt={() => startAIOperation("toPrompt")}
                onUndo={() => editor?.commands.undo()}
                onRedo={() => editor?.commands.redo()}
                onExport={handleExport}
                onCopy={handleCopy}
                onSearch={handleSearch}
                onStop={stopAIOperation}
                canUndo={editor?.can().undo() || false}
                canRedo={editor?.can().redo() || false}
                isLoading={isAIActive}
                showToPrompt={showToPrompt}
            />

            {/* Search and Replace Dialog */}
            <SearchReplace
                editor={editor}
                isOpen={isSearchOpen}
                onClose={() => setIsSearchOpen(false)}
            />

            {/* AI Stream Ephemeral Status & Alerts */}
            <AIStreamStatus
                status={aiStatus}
                isConflict={isAIConflict}
                errorMessage={aiError}
                onRetry={resetAI}
                onCancel={stopAIOperation}
            />

            {/* AI Ephemeral Live Preview Panel (Active when streaming or text available) */}
            {previewText && (
                <AIStreamPreview
                    text={previewText}
                    operation="معالجة ذكية"
                    isStreaming={isStreaming}
                    onStop={stopAIOperation}
                    onApply={commitAIPreview}
                    onRetry={retryAIPreview}
                    onReject={rejectAIPreview}
                />
            )}

            {/* Persistent Conflict Alert Banner */}
            {activeConflict && !isConflictDialogOpen && (
                <div className="mx-6 mt-4 p-3.5 rounded-lg bg-amber-950/40 border border-amber-800/60 flex items-center justify-between text-xs text-amber-300 flex-shrink-0 animate-in fade-in">
                    <div className="flex items-center gap-2.5">
                        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                        <span>
                            <strong>تنبيه تعارض:</strong> تم اكتشاف تعديلات جديدة على الخادم. الحفظ التلقائي متوقف لحماية بياناتك المحلية حتى تسوية التعارض.
                        </span>
                    </div>
                    <button
                        onClick={() => setIsConflictDialogOpen(true)}
                        className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-medium transition-colors shadow-sm"
                    >
                        مراجعة وحل التعارض
                    </button>
                </div>
            )}

            {/* Conflict Resolution Modal Dialog */}
            {activeConflict && isConflictDialogOpen && (
                <ConflictDialog
                    conflict={activeConflict}
                    onResolve={handleResolveConflict}
                    onClose={() => setIsConflictDialogOpen(false)}
                    isResolving={isResolvingConflict}
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
            <div className="flex-1 overflow-auto custom-scrollbar relative">
                {hydration === "hydrating" && !editor?.getText() && (
                    <div className="absolute inset-0 bg-zinc-950/80 backdrop-blur-xs z-10 flex flex-col items-center justify-center gap-3">
                        <Loader2 className="w-7 h-7 animate-spin text-indigo-400" />
                        <span className="text-xs text-zinc-400 font-medium">جاري تحميل ومزامنة المستند...</span>
                    </div>
                )}
                {hydration === "fatal" ? (
                    <div className="m-6 p-8 rounded-xl bg-red-950/30 border border-red-800/40 text-center flex flex-col items-center justify-center gap-3 max-w-md mx-auto mt-16">
                        <AlertTriangle className="w-10 h-10 text-red-400" />
                        <h3 className="text-base font-semibold text-red-200">تعذّر فتح المستند</h3>
                        <p className="text-xs text-zinc-400 leading-relaxed">
                            الملف المطلوب غير موجود على الخادم ولا تتوفر منه نسخة محلية محفوظة.
                        </p>
                        <button
                            onClick={() => router.push("/workspace")}
                            className="mt-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium transition-colors cursor-pointer"
                        >
                            العودة إلى مساحة العمل
                        </button>
                    </div>
                ) : (
                    <EditorContent editor={editor} className="max-w-4xl mx-auto" />
                )}
            </div>

            {/* Status Bar - Fixed at bottom */}
            <div className="border-t border-zinc-800/50 px-4 py-2 flex items-center justify-between text-xs text-zinc-500 flex-shrink-0">
                {/* Left: File Title */}
                <span className="truncate max-w-[200px]" title={title}>
                    {title || "Untitled"}
                </span>

                {/* Center: Save Status & Sync Indicator */}
                <div className="flex items-center gap-2">
                    {hydration === "hydrating" ? (
                        <div className="flex items-center gap-1.5 text-zinc-400">
                            <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                            <span>Syncing...</span>
                        </div>
                    ) : (
                        <>
                            <span>Save</span>
                            {isSaving || isCommitting ? (
                                <Loader2 className="w-3 h-3 animate-spin text-zinc-400" />
                            ) : lastSaved ? (
                                <div className="w-2 h-2 rounded-full bg-green-500/70 blur-[1px]" title="Saved" />
                            ) : (
                                <div className="w-2 h-2 rounded-full bg-red-500/70 blur-[1px]" title="Unsaved" />
                            )}
                        </>
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
                    <span title={`${wordCount.toLocaleString()} word${wordCount !== 1 ? "s" : ""}`}>
                        {wordCount.toLocaleString()} words
                    </span>
                    <span className="text-zinc-700">|</span>
                    <span title={`${charCount.toLocaleString()} character${charCount !== 1 ? "s" : ""}`}>
                        {charCount.toLocaleString()} chars
                    </span>
                    <span className="uppercase">{textDir}</span>
                </div>
            </div>
        </div>
    );
}
