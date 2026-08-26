"use client";

import { ExportButton } from "@/components/editor/export-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EditorMode } from "@/components/editor/markdown/types";
import {
    Undo2,
    Redo2,
    Copy,
    Search,
    Check,
    Wand2,
    FileText,
    Languages,
    Sparkles,
    Square,
    Bold,
    Italic,
    Code,
    Heading1,
    Heading2,
    List,
    ListOrdered,
    Quote,
    Link,
    Eye,
    FileCode,
} from "lucide-react";

interface AIToolbarProps {
    onCorrect: () => void;
    onImprove: () => void;
    onSummarize: () => void;
    onTranslate: () => void;
    onToPrompt: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onExport: (format: "md" | "txt") => void;
    onCopy: () => void;
    onSearch: () => void;
    onStop?: () => void;
    onFormat?: (prefix: string, suffix?: string, placeholder?: string) => void;
    mode?: EditorMode;
    onToggleMode?: () => void;
    canUndo: boolean;
    canRedo: boolean;
    isLoading: boolean;
    showToPrompt: boolean;
    className?: string;
}

export function AIToolbar({
    onCorrect,
    onImprove,
    onSummarize,
    onTranslate,
    onToPrompt,
    onUndo,
    onRedo,
    onExport,
    onCopy,
    onSearch,
    onStop,
    onFormat,
    mode = "live",
    onToggleMode,
    canUndo,
    canRedo,
    isLoading,
    showToPrompt,
    className,
}: AIToolbarProps) {
    return (
        <div
            className={cn(
                "flex items-center gap-1 p-2 border-b border-zinc-800/50 bg-zinc-900/30 overflow-x-auto custom-scrollbar",
                className
            )}
        >
            {/* History Controls */}
            <div className="flex items-center gap-1 pr-2 border-r border-zinc-800/50 flex-shrink-0">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onUndo}
                    disabled={!canUndo || isLoading}
                    title="تراجع (Ctrl+Z)"
                >
                    <Undo2 className="w-4 h-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onRedo}
                    disabled={!canRedo || isLoading}
                    title="إعادة (Ctrl+Y)"
                >
                    <Redo2 className="w-4 h-4" />
                </Button>
            </div>

            {/* Markdown Formatting Controls */}
            {onFormat && (
                <div className="flex items-center gap-1 px-2 border-r border-zinc-800/50 flex-shrink-0">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("# ", "", "عنوان رئيسي")}
                        disabled={isLoading}
                        title="عنوان رئيسي (H1)"
                    >
                        <Heading1 className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("## ", "", "عنوان فرعي")}
                        disabled={isLoading}
                        title="عنوان فرعي (H2)"
                    >
                        <Heading2 className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("**", "**", "نص عريض")}
                        disabled={isLoading}
                        title="نص عريض (Bold)"
                    >
                        <Bold className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("*", "*", "نص مائل")}
                        disabled={isLoading}
                        title="نص مائل (Italic)"
                    >
                        <Italic className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("`", "`", "كود")}
                        disabled={isLoading}
                        title="كود مدمج (Code)"
                    >
                        <Code className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("- ", "", "عنصر")}
                        disabled={isLoading}
                        title="قائمة نقطية (List)"
                    >
                        <List className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("1. ", "", "عنصر")}
                        disabled={isLoading}
                        title="قائمة مرقمة (Numbered List)"
                    >
                        <ListOrdered className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("> ", "", "اقتباس")}
                        disabled={isLoading}
                        title="اقتباس (Quote)"
                    >
                        <Quote className="w-4 h-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onFormat("[", "](https://)", "نص الرابط")}
                        disabled={isLoading}
                        title="رابط (Link)"
                    >
                        <Link className="w-4 h-4" />
                    </Button>
                </div>
            )}

            {/* AI Tools */}
            <div className="flex items-center gap-1 px-2 border-r border-zinc-800/50 flex-shrink-0">
                {isLoading && onStop ? (
                    <Button
                        variant="destructive"
                        size="sm"
                        className="gap-1.5 animate-pulse bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30"
                        onClick={onStop}
                        title="إيقاف التوليد (Esc)"
                    >
                        <Square className="w-3.5 h-3.5 fill-current" />
                        <span>Stop</span>
                    </Button>
                ) : (
                    <>
                        <Button
                            variant="ai"
                            size="sm"
                            className="gap-1.5"
                            onClick={onCorrect}
                            disabled={isLoading}
                        >
                            <Check className="w-4 h-4" />
                            <span className="hidden sm:inline">Correct</span>
                        </Button>
                        <Button
                            variant="ai"
                            size="sm"
                            className="gap-1.5"
                            onClick={onImprove}
                            disabled={isLoading}
                        >
                            <Wand2 className="w-4 h-4" />
                            <span className="hidden sm:inline">Improve</span>
                        </Button>
                        <Button
                            variant="ai"
                            size="sm"
                            className="gap-1.5"
                            onClick={onSummarize}
                            disabled={isLoading}
                        >
                            <FileText className="w-4 h-4" />
                            <span className="hidden sm:inline">Summarize</span>
                        </Button>
                        <Button
                            variant="ai"
                            size="sm"
                            className="gap-1.5"
                            onClick={onTranslate}
                            disabled={isLoading}
                        >
                            <Languages className="w-4 h-4" />
                            <span className="hidden sm:inline">Translate</span>
                        </Button>
                        {showToPrompt && (
                            <Button
                                variant="ai"
                                size="sm"
                                className="gap-1.5"
                                onClick={onToPrompt}
                                disabled={isLoading}
                            >
                                <Sparkles className="w-4 h-4" />
                                <span className="hidden sm:inline">ToPrompt</span>
                            </Button>
                        )}
                    </>
                )}
            </div>

            {/* Mode & Export Controls */}
            <div className="flex items-center gap-1 ml-auto flex-shrink-0">
                {onToggleMode && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "gap-1.5 text-xs font-mono",
                            mode === "source" && "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                        )}
                        onClick={onToggleMode}
                        disabled={isLoading}
                        title={mode === "live" ? "التبديل إلى وضع المصدر الخام (Source)" : "التبديل إلى وضع المعاينة الحية (Live)"}
                    >
                        {mode === "live" ? (
                            <>
                                <Eye className="w-3.5 h-3.5" />
                                <span className="hidden md:inline">Live</span>
                            </>
                        ) : (
                            <>
                                <FileCode className="w-3.5 h-3.5" />
                                <span className="hidden md:inline">Source</span>
                            </>
                        )}
                    </Button>
                )}
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={onCopy}
                    disabled={isLoading}
                    title="نسخ نص Markdown"
                >
                    <Copy className="w-4 h-4" />
                    <span className="hidden sm:inline">Copy</span>
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={onSearch}
                    disabled={isLoading}
                    title="بحث واستبدال (Ctrl+F)"
                >
                    <Search className="w-4 h-4" />
                    <span className="hidden sm:inline">Search</span>
                </Button>
                <ExportButton onExport={onExport} disabled={isLoading} />
            </div>
        </div>
    );
}
