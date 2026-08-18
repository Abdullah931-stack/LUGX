"use client";

import { ExportButton } from "@/components/editor/export-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
} from "lucide-react";

interface AIToolbarProps {
    onCorrect: () => void;
    onImprove: () => void;
    onSummarize: () => void;
    onTranslate: () => void;
    onToPrompt: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onExport: (format: 'md' | 'txt') => void;
    onCopy: () => void;
    onSearch: () => void;
    onStop?: () => void;
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
    canUndo,
    canRedo,
    isLoading,
    showToPrompt,
    className,
}: AIToolbarProps) {
    return (
        <div
            className={cn(
                "flex items-center gap-1 p-2 border-b border-zinc-800/50 bg-zinc-900/30",
                className
            )}
        >
            {/* History Controls */}
            <div className="flex items-center gap-1 pr-2 border-r border-zinc-800/50">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onUndo}
                    disabled={!canUndo || isLoading}
                >
                    <Undo2 className="w-4 h-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onRedo}
                    disabled={!canRedo || isLoading}
                >
                    <Redo2 className="w-4 h-4" />
                </Button>
            </div>

            {/* AI Tools */}
            <div className="flex items-center gap-1 px-2 border-r border-zinc-800/50">
                {isLoading && onStop ? (
                    <Button
                        variant="destructive"
                        size="sm"
                        className="gap-1.5 animate-pulse bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30"
                        onClick={onStop}
                        title="Stop AI Generation (Esc)"
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

            {/* Export Controls */}
            <div className="flex items-center gap-1 ml-auto">
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5"
                    onClick={onCopy}
                    disabled={isLoading}
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
                    title="Search and Replace (Ctrl+F)"
                >
                    <Search className="w-4 h-4" />
                    <span className="hidden sm:inline">Search</span>
                </Button>
                <ExportButton
                    onExport={onExport}
                    disabled={isLoading}
                />
            </div>
        </div>
    );
}
