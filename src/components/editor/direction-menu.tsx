"use client";

import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DirectionSettings } from "@/components/editor/markdown/types";
import {
    AlignRight,
    AlignLeft,
    ArrowLeftRight,
    Code2,
    Check,
    Sparkles,
    Keyboard,
} from "lucide-react";

interface DirectionMenuProps {
    settings: DirectionSettings;
    onSettingsChange: (newSettings: Partial<DirectionSettings>) => void;
    disabled?: boolean;
    className?: string;
}

export function DirectionMenu({
    settings,
    onSettingsChange,
    disabled = false,
    className,
}: DirectionMenuProps) {
    const { mode, lockCodeBlocksLTR } = settings;

    // Render active trigger icon
    const renderTriggerIcon = () => {
        switch (mode) {
            case "rtl":
                return <AlignRight className="w-3.5 h-3.5 text-indigo-400" />;
            case "ltr":
                return <AlignLeft className="w-3.5 h-3.5 text-sky-400" />;
            case "auto":
            default:
                return <ArrowLeftRight className="w-3.5 h-3.5 text-emerald-400" />;
        }
    };

    const getModeLabel = () => {
        switch (mode) {
            case "rtl":
                return "RTL";
            case "ltr":
                return "LTR";
            case "auto":
            default:
                return "Auto";
        }
    };

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    className={cn(
                        "gap-1.5 text-xs font-mono border border-zinc-800/60 hover:bg-zinc-800/70 transition-colors",
                        mode === "auto" && "text-zinc-200 bg-zinc-900/40",
                        mode === "rtl" && "text-indigo-300 bg-indigo-950/30 border-indigo-800/40",
                        mode === "ltr" && "text-sky-300 bg-sky-950/30 border-sky-800/40",
                        className
                    )}
                    title="إعدادات اتجاه النص (Ctrl+Alt+D)"
                >
                    {renderTriggerIcon()}
                    <span className="font-sans font-medium text-xs hidden md:inline">
                        {getModeLabel()}
                    </span>
                </Button>
            </DropdownMenu.Trigger>

            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="end"
                    sideOffset={6}
                    className="z-50 w-72 rounded-xl bg-zinc-950/95 border border-zinc-800/90 p-2 shadow-2xl backdrop-blur-xl text-zinc-200 text-xs font-sans animate-in fade-in-50 zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                >
                    {/* Header */}
                    <div className="px-2 py-1.5 mb-1 flex items-center justify-between border-b border-zinc-800/60">
                        <div className="flex items-center gap-1.5 font-semibold text-zinc-100">
                            <ArrowLeftRight className="w-3.5 h-3.5 text-indigo-400" />
                            <span>اتجاه النص (Text Direction)</span>
                        </div>
                        <span className="text-[10px] text-zinc-500 font-mono">Bidi Engine</span>
                    </div>

                    {/* Mode Options */}
                    <div className="space-y-1">
                        {/* 1. Auto Mode */}
                        <button
                            type="button"
                            onClick={() => onSettingsChange({ mode: "auto" })}
                            className={cn(
                                "w-full flex items-start gap-2.5 p-2 rounded-lg text-start transition-all cursor-pointer",
                                mode === "auto"
                                    ? "bg-emerald-950/30 border border-emerald-800/40 text-emerald-200"
                                    : "hover:bg-zinc-900/80 text-zinc-300"
                            )}
                        >
                            <div className="mt-0.5 p-1 rounded-md bg-zinc-900 border border-zinc-800 flex-shrink-0">
                                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between">
                                    <span className="font-semibold text-xs text-zinc-100">تلقائي ذكي (Auto)</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">
                                        افتراضي
                                    </span>
                                </div>
                                <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                                    كشف اتجاه كل فقرة تلقائياً مع عزل الأسطر لمنع الخلل أثناء التمرير.
                                </p>
                            </div>
                            {mode === "auto" && <Check className="w-4 h-4 text-emerald-400 mt-1 flex-shrink-0" />}
                        </button>

                        {/* 2. RTL Mode */}
                        <button
                            type="button"
                            onClick={() => onSettingsChange({ mode: "rtl" })}
                            className={cn(
                                "w-full flex items-start gap-2.5 p-2 rounded-lg text-start transition-all cursor-pointer",
                                mode === "rtl"
                                    ? "bg-indigo-950/30 border border-indigo-800/40 text-indigo-200"
                                    : "hover:bg-zinc-900/80 text-zinc-300"
                            )}
                        >
                            <div className="mt-0.5 p-1 rounded-md bg-zinc-900 border border-zinc-800 flex-shrink-0">
                                <AlignRight className="w-3.5 h-3.5 text-indigo-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <span className="font-semibold text-xs text-zinc-100">من اليمين لليسار (RTL)</span>
                                <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                                    فرض الاتجاه العربي الشامل على كامل المستند والأسطر.
                                </p>
                            </div>
                            {mode === "rtl" && <Check className="w-4 h-4 text-indigo-400 mt-1 flex-shrink-0" />}
                        </button>

                        {/* 3. LTR Mode */}
                        <button
                            type="button"
                            onClick={() => onSettingsChange({ mode: "ltr" })}
                            className={cn(
                                "w-full flex items-start gap-2.5 p-2 rounded-lg text-start transition-all cursor-pointer",
                                mode === "ltr"
                                    ? "bg-sky-950/30 border border-sky-800/40 text-sky-200"
                                    : "hover:bg-zinc-900/80 text-zinc-300"
                            )}
                        >
                            <div className="mt-0.5 p-1 rounded-md bg-zinc-900 border border-zinc-800 flex-shrink-0">
                                <AlignLeft className="w-3.5 h-3.5 text-sky-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <span className="font-semibold text-xs text-zinc-100">من اليسار لليمين (LTR)</span>
                                <p className="text-[11px] text-zinc-400 mt-0.5 leading-relaxed">
                                    فرض الاتجاه اللاتيني/الإنجليزي الشامل على كامل المستند.
                                </p>
                            </div>
                            {mode === "ltr" && <Check className="w-4 h-4 text-sky-400 mt-1 flex-shrink-0" />}
                        </button>
                    </div>

                    <DropdownMenu.Separator className="h-px bg-zinc-800/60 my-2" />

                    {/* Additional UX Controls */}
                    <div className="px-1 py-1">
                        <button
                            type="button"
                            onClick={() => onSettingsChange({ lockCodeBlocksLTR: !lockCodeBlocksLTR })}
                            className={cn(
                                "w-full flex items-center justify-between p-2 rounded-lg text-xs transition-colors cursor-pointer",
                                lockCodeBlocksLTR
                                    ? "bg-zinc-900 text-zinc-200"
                                    : "hover:bg-zinc-900/60 text-zinc-400"
                            )}
                        >
                            <div className="flex items-center gap-2">
                                <Code2 className="w-3.5 h-3.5 text-amber-400" />
                                <span className="text-xs">تثبيت كتل الأكواد (LTR Code)</span>
                            </div>
                            <div
                                className={cn(
                                    "w-8 h-4 rounded-full transition-colors relative flex items-center px-0.5",
                                    lockCodeBlocksLTR ? "bg-indigo-600 justify-end" : "bg-zinc-700 justify-start"
                                )}
                            >
                                <div className="w-3 h-3 rounded-full bg-white shadow-xs" />
                            </div>
                        </button>
                    </div>

                    <DropdownMenu.Separator className="h-px bg-zinc-800/60 my-1.5" />

                    {/* Footer Shortcut Hint */}
                    <div className="px-2 py-1 flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                        <span className="flex items-center gap-1">
                            <Keyboard className="w-3 h-3 text-zinc-500" />
                            <span>تبديل سريع</span>
                        </span>
                        <kbd className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                            Ctrl + Alt + D
                        </kbd>
                    </div>
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}
