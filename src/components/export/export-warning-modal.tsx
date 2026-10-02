"use client";

import React, { useEffect } from "react";
import { AlertTriangle, Download, X, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ExportWarningModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    fileName: string;
    format: "md" | "txt";
    isExporting?: boolean;
}

/**
 * Modal dialog that warns the user before exporting an encrypted vault document
 * as an unencrypted plaintext file to local disk.
 *
 * Remediates: LUGX-004, LUGX-017, LUGX-019, LUGX-085
 */
export function ExportWarningModal({
    isOpen,
    onClose,
    onConfirm,
    fileName,
    format,
    isExporting = false,
}: ExportWarningModalProps) {
    // Close on Escape key press
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !isExporting) {
                onClose();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, isExporting, onClose]);

    if (!isOpen) return null;

    const extension = format === "md" ? ".md" : ".txt";
    const fullFileName = `${fileName.trim() || "document"}${extension}`;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            data-testid="export-warning-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-warning-title"
        >
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
                onClick={isExporting ? undefined : onClose}
                aria-hidden="true"
            />

            {/* Modal Dialog Card */}
            <div className="relative bg-zinc-900 border border-amber-500/30 rounded-xl shadow-2xl w-full max-w-md overflow-hidden text-right z-10" dir="rtl">
                {/* Header */}
                <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between bg-amber-500/5">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 bg-amber-500/10 rounded-lg text-amber-400">
                            <ShieldAlert className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 id="export-warning-title" className="text-base font-semibold text-zinc-100">
                                تحذير أمني: تصدير مستند مشفر
                            </h2>
                            <p className="text-xs text-zinc-400">
                                تنزيل محتوى الخزنة كنص صريح غير مشفر
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isExporting}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 rounded-md hover:bg-zinc-800 disabled:opacity-50"
                        aria-label="إغلاق"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 space-y-4">
                    <div className="flex items-start gap-3 p-3.5 bg-amber-950/30 border border-amber-800/40 rounded-lg text-amber-200/90 text-sm">
                        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div className="space-y-1 text-xs sm:text-sm">
                            <p className="font-medium text-amber-300">
                                تنبيه فك التشفير المحلي:
                            </p>
                            <p className="text-zinc-300 leading-relaxed">
                                هذا الملف محفوظ حالياً داخل الخزنة المشفرة بتقنية المعرفة الصفرية (Zero-Knowledge). تصديره سيقوم بفك تشفيره وحفظه كنص صريح (<span className="font-mono text-amber-300">{extension}</span>) على قرصك الصلب دون أي تشفير.
                            </p>
                        </div>
                    </div>

                    <div className="bg-zinc-950/60 p-3 rounded-md border border-zinc-800 text-xs text-zinc-400">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-zinc-500">اسم الملف المصدر:</span>
                            <span className="font-mono text-zinc-200 truncate max-w-[200px]" dir="ltr">{fullFileName}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-zinc-500">الصيغة:</span>
                            <span className="text-zinc-300 uppercase">{format === "md" ? "Markdown (.md)" : "Plain Text (.txt)"}</span>
                        </div>
                    </div>

                    <p className="text-xs text-zinc-400">
                        هل أنت متأكد من رغبتك في تصدير هذا المستند كنص صريح مكشوف؟
                    </p>
                </div>

                {/* Actions */}
                <div className="px-6 py-4 bg-zinc-950/50 border-t border-zinc-800 flex items-center justify-end gap-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                        disabled={isExporting}
                        data-testid="cancel-export-button"
                        className="text-zinc-400 hover:text-zinc-200"
                    >
                        إلغاء
                    </Button>
                    <Button
                        variant="default"
                        size="sm"
                        onClick={onConfirm}
                        disabled={isExporting}
                        data-testid="confirm-export-button"
                        className="bg-amber-600 hover:bg-amber-500 text-zinc-950 font-medium gap-1.5"
                    >
                        <Download className="w-4 h-4" />
                        <span>تأكيد التصدير كنص صريح</span>
                    </Button>
                </div>
            </div>
        </div>
    );
}
