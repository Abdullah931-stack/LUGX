"use client";

import { useState } from "react";
import { Zap, Eye, CheckCircle, X, Table, PowerOff, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    isTableExtractionEnabled,
    setTableExtractionEnabled,
} from "@/lib/parsers/pdf-settings";

export type PdfExtractionMode = "fast" | "ocr";

interface PdfImportModeDialogProps {
    isOpen: boolean;
    fileName: string;
    onClose: () => void;
    onConfirm: (mode: PdfExtractionMode) => void;
}

export function PdfImportModeDialog({
    isOpen,
    fileName,
    onClose,
    onConfirm,
}: PdfImportModeDialogProps) {
    const [selectedMode, setSelectedMode] = useState<PdfExtractionMode>("fast");
    const [isTableEnabled, setIsTableEnabled] = useState(isTableExtractionEnabled);

    function handleToggleTable(enabled: boolean) {
        setIsTableEnabled(enabled);
        setTableExtractionEnabled(enabled);
    }

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl relative text-right" dir="rtl">
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute left-4 top-4 text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                    <X className="w-5 h-5" />
                </button>

                {/* Header */}
                <h3 className="text-lg font-semibold text-zinc-100 mb-1">
                    تحديد تقنية استخراج الـ PDF
                </h3>
                <p className="text-xs text-zinc-400 mb-5 truncate">
                    الملف المختار: <span className="text-zinc-300 font-mono" dir="ltr">{fileName}</span>
                </p>

                {/* Options List */}
                <div className="space-y-3 mb-6">
                    {/* Option 1: Fast Local */}
                    <div
                        onClick={() => setSelectedMode("fast")}
                        className={`cursor-pointer rounded-lg border p-4 transition-all duration-200 flex items-start gap-3 ${
                            selectedMode === "fast"
                                ? "border-indigo-500 bg-indigo-500/10 shadow-sm"
                                : "border-zinc-800 bg-zinc-800/40 hover:border-zinc-700"
                        }`}
                    >
                        <div className={`p-2 rounded-md ${selectedMode === "fast" ? "bg-indigo-500 text-white" : "bg-zinc-800 text-zinc-400"}`}>
                            <Zap className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-zinc-100">المعالجة المحلية السريعة</span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-medium">موصى به</span>
                            </div>
                            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                                استخراج رقمي فوري وخفيف، يدعم تطبيع الحروف العربية وهيكلة الجداول إلى Markdown في أجزاء من الثانية.
                            </p>
                        </div>
                    </div>

                    {/* Option 2: Visual OCR */}
                    <div
                        onClick={() => setSelectedMode("ocr")}
                        className={`cursor-pointer rounded-lg border p-4 transition-all duration-200 flex items-start gap-3 ${
                            selectedMode === "ocr"
                                ? "border-indigo-500 bg-indigo-500/10 shadow-sm"
                                : "border-zinc-800 bg-zinc-800/40 hover:border-zinc-700"
                        }`}
                    >
                        <div className={`p-2 rounded-md ${selectedMode === "ocr" ? "bg-indigo-500 text-white" : "bg-zinc-800 text-zinc-400"}`}>
                            <Eye className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-zinc-100">التعرف البصري (OCR مزدوج)</span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">أبطأ</span>
                            </div>
                            <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                                فحص بصري كامل بالبيكسل بالنموذج المزدوج (عربي + إنجليزي). مخصص للمستندات الممسوحة ضوئياً أو المحارف التالفة.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Table Algorithm Quick Action */}
                <div className="mb-5 p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <div className="p-1.5 rounded-md bg-zinc-800/80 text-indigo-400">
                            <Table className="w-4 h-4" />
                        </div>
                        <div>
                            <div className="text-xs font-medium text-zinc-200">خوارزمية الجداول المكانية</div>
                            <div className="text-[11px] text-zinc-400">
                                {isTableEnabled ? "مفعّلة (توليد جداول Markdown)" : "معطّلة (استخراج نصوص خطية)"}
                            </div>
                        </div>
                    </div>
                    {isTableEnabled ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleToggleTable(false)}
                            className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 text-xs h-7 px-2.5 gap-1 shrink-0"
                        >
                            <PowerOff className="w-3 h-3" />
                            إغلاق الخوارزمية
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            onClick={() => handleToggleTable(true)}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs h-7 px-2.5 gap-1 shrink-0"
                        >
                            <Play className="w-3 h-3" />
                            تفعيل الخوارزمية
                        </Button>
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-800">
                    <Button variant="ghost" size="sm" onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
                        إلغاء
                    </Button>
                    <Button
                        variant="default"
                        size="sm"
                        className="bg-indigo-600 hover:bg-indigo-500 text-white gap-2 px-5"
                        onClick={() => onConfirm(selectedMode)}
                    >
                        <CheckCircle className="w-4 h-4" />
                        بدء الاستخراج
                    </Button>
                </div>
            </div>
        </div>
    );
}
