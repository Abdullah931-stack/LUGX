"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
    MarkdownEditor,
    type EditorAdapter,
    type EditorMode,
    type EditorSelection,
    type DirectionSettings,
} from "@/components/editor/markdown";
import { getRemainingQuota } from "@/server/actions/ai-ops";
import { AIToolbar } from "@/components/editor/ai-toolbar";
import { SearchReplace } from "@/components/editor/search-replace";
import { countWords, detectTextDirection, countCharacters } from "@/lib/utils";
import { Loader2, AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { SyncIndicator } from "@/components/sync/sync-indicator";
import { AIStreamStatus } from "@/components/editor/ai-stream-status";
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
    const [editorMode, setEditorMode] = useState<EditorMode>("live");
    const [adapter, setAdapter] = useState<EditorAdapter | null>(null);
    const [directionSettings, setDirectionSettings] = useState<DirectionSettings>({
        mode: "auto",
        lockCodeBlocksLTR: true,
    });

    // Load persisted direction preferences from localStorage on mount
    useEffect(() => {
        try {
            const saved = localStorage.getItem("lugx_editor_direction_pref");
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === "object") {
                    setDirectionSettings((prev) => ({
                        mode: ["auto", "rtl", "ltr"].includes(parsed.mode) ? parsed.mode : prev.mode,
                        lockCodeBlocksLTR:
                            typeof parsed.lockCodeBlocksLTR === "boolean"
                                ? parsed.lockCodeBlocksLTR
                                : prev.lockCodeBlocksLTR,
                    }));
                }
            }
        } catch {
            // Ignore localStorage errors (e.g. privacy mode / SSR)
        }
    }, []);

    // Update direction settings callback
    const handleDirectionSettingsChange = useCallback(
        (updated: Partial<DirectionSettings>) => {
            setDirectionSettings((prev) => {
                const next = { ...prev, ...updated };
                try {
                    localStorage.setItem("lugx_editor_direction_pref", JSON.stringify(next));
                } catch {
                    // Ignore storage errors
                }
                if (adapter) {
                    adapter.setDirectionSettings(next);
                }
                return next;
            });
        },
        [adapter]
    );

    // Stabilized navigation callback
    const handleNavigate = useCallback((path: string) => router.push(path), [router]);

    // Centralized Editor Orchestrator
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
        editor: adapter,
        onNavigate: handleNavigate,
    });

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

    // Keyboard shortcuts (Ctrl+F for search, Escape for stopping AI generation, Ctrl+Alt+D for direction cycle)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "f" && !e.altKey) {
                e.preventDefault();
                setIsSearchOpen(true);
            } else if (e.key === "Escape" && isAIActive) {
                stopAIOperation();
            } else if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key.toLowerCase() === "d" || e.code === "KeyD")) {
                if (e.repeat) return;
                e.preventDefault();
                setDirectionSettings((prev) => {
                    const nextMode = prev.mode === "auto" ? "rtl" : prev.mode === "rtl" ? "ltr" : "auto";
                    const next = { ...prev, mode: nextMode };
                    try {
                        localStorage.setItem("lugx_editor_direction_pref", JSON.stringify(next));
                    } catch {
                        // Ignore storage errors
                    }
                    if (adapter) {
                        adapter.setDirectionSettings(next);
                    }
                    return next;
                });
            }
        };

        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [isAIActive, stopAIOperation, adapter]);

    // Copy raw Markdown to clipboard with safe fallback
    const handleCopy = useCallback(async () => {
        if (!adapter) return;
        try {
            await navigator.clipboard.writeText(adapter.getValue());
        } catch (copyErr) {
            console.warn("[Editor] Clipboard writeText failed, attempting fallback:", copyErr);
            try {
                const textArea = document.createElement("textarea");
                textArea.value = adapter.getValue();
                textArea.style.position = "fixed";
                textArea.style.opacity = "0";
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand("copy");
                document.body.removeChild(textArea);
            } catch (fallbackErr) {
                console.error("[Editor] Fallback copy failed:", fallbackErr);
            }
        }
    }, [adapter]);

    // Toggle search and replace dialog
    const handleSearch = useCallback(() => {
        setIsSearchOpen((prev) => !prev);
    }, []);

    // Formatting handler
    const handleFormat = useCallback(
        (prefix: string, suffix: string = "", placeholder: string = "") => {
            if (adapter) {
                adapter.insertMarkdown(prefix, suffix, placeholder);
            }
        },
        [adapter]
    );

    // Toggle between Live Preview and Raw Source mode
    const handleToggleMode = useCallback(() => {
        setEditorMode((prev) => (prev === "live" ? "source" : "live"));
    }, []);

    // Export document in multiple formats (MD, TXT)
    const handleExport = useCallback(
        async (format: "md" | "txt" = "txt") => {
            if (!adapter) return;

            try {
                const { exportContent, downloadBlob } = await import("@/lib/exporters");
                const content = adapter.getValue();
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
        [adapter, title, setError]
    );

    // Dynamic stats computation from raw Markdown
    const isSelection = selectedText.length > 0;
    const textToAnalyze = isSelection ? selectedText : adapter?.getValue() || "";
    const wordCount = isSelection
        ? countWords(selectedText)
        : adapter
        ? adapter.getWordCount()
        : 0;
    const charCount = isSelection
        ? countCharacters(selectedText)
        : adapter
        ? adapter.getCharCount()
        : 0;
    const textDir = detectTextDirection(textToAnalyze);

    return (
        <div className="h-full flex flex-col bg-zinc-950">
            {/* Toolbar - Fixed position */}
            <AIToolbar
                onCorrect={() => startAIOperation("correct")}
                onImprove={() => startAIOperation("improve")}
                onSummarize={() => startAIOperation("summarize")}
                onTranslate={() => startAIOperation("translate")}
                onToPrompt={() => startAIOperation("toPrompt")}
                onUndo={() => adapter?.undo()}
                onRedo={() => adapter?.redo()}
                onExport={handleExport}
                onCopy={handleCopy}
                onSearch={handleSearch}
                onStop={stopAIOperation}
                onFormat={handleFormat}
                mode={editorMode}
                onToggleMode={handleToggleMode}
                directionSettings={directionSettings}
                onDirectionSettingsChange={handleDirectionSettingsChange}
                canUndo={adapter?.canUndo() || false}
                canRedo={adapter?.canRedo() || false}
                isLoading={isAIActive}
                showToPrompt={showToPrompt}
            />

            {/* Search and Replace Dialog */}
            <SearchReplace
                adapter={adapter}
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
                {hydration === "hydrating" && !adapter?.getValue() && (
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
                    <div className="max-w-4xl mx-auto p-4 md:p-6">
                        <MarkdownEditor
                            onAdapterReady={setAdapter}
                            onChange={handleEditorChange}
                            onSelectionChange={(_sel: EditorSelection) => {
                                if (adapter) {
                                    setSelectedText(adapter.getSelectedText());
                                }
                            }}
                            mode={editorMode}
                            onModeChange={setEditorMode}
                            dir={directionSettings.mode}
                            lockCodeBlocksLTR={directionSettings.lockCodeBlocksLTR}
                            onDirectionChange={handleDirectionSettingsChange}
                            placeholder="ابدأ الكتابة بصيغة Markdown..."
                            className="min-h-[70vh] text-zinc-300"
                        />
                    </div>
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
