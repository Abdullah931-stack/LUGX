"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, FileText, FileCode } from "lucide-react";

interface ExportButtonProps {
    onExport: (format: 'md' | 'txt') => void;
    disabled?: boolean;
}

export function ExportButton({ onExport, disabled = false }: ExportButtonProps) {
    const [showMenu, setShowMenu] = useState(false);

    const handleExport = (format: 'md' | 'txt') => {
        onExport(format);
        setShowMenu(false);
    };

    return (
        <div className="relative">
            <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowMenu(!showMenu)}
                disabled={disabled}
            >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">Export</span>
            </Button>

            {showMenu && (
                <>
                    {/* Backdrop to close menu */}
                    <div
                        className="fixed inset-0 z-10"
                        onClick={() => setShowMenu(false)}
                    />

                    {/* Dropdown Menu */}
                    <div className="absolute right-0 mt-1 z-20 w-32 bg-zinc-900 border border-zinc-800 rounded-md shadow-lg overflow-hidden">
                        <button
                            onClick={() => handleExport('txt')}
                            className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2"
                        >
                            <FileText className="w-4 h-4" />
                            Plain Text
                        </button>
                        <button
                            onClick={() => handleExport('md')}
                            className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2"
                        >
                            <FileCode className="w-4 h-4" />
                            Markdown
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
