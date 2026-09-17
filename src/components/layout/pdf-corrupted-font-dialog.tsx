"use client";

import { useState } from "react";
import { AlertTriangle, Sparkles, Download, ArrowLeft, X, Loader2, Table, PowerOff, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadBilingualOcrPackage } from "@/lib/parsers/pdf-ocr-engine";
import {
    isTableExtractionEnabled,
    setTableExtractionEnabled,
} from "@/lib/parsers/pdf-settings";

interface PdfCorruptedFontDialogProps {
    isOpen: boolean;
    fileName: string;
    isOcrInstalled: boolean;
    onRunOcr: () => void;
    onContinueAnyway: () => void;
    onClose: () => void;
}

export function PdfCorruptedFontDialog({
    isOpen,
    fileName,
    isOcrInstalled,
    onRunOcr,
    onContinueAnyway,
    onClose,
}: PdfCorruptedFontDialogProps) {
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadPercent, setDownloadPercent] = useState(0);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isTableEnabled, setIsTableEnabled] = useState(isTableExtractionEnabled);

    function handleToggleTable(enabled: boolean) {
        setIsTableEnabled(enabled);
        setTableExtractionEnabled(enabled);
    }

    if (!isOpen) return null;

    async function handleOcrAction() {
        if (isOcrInstalled) {
            onRunOcr();
            return;
        }

        // Need to download OCR package first with progress indicator
        setIsDownloading(true);
        setErrorMsg(null);
        setDownloadPercent(5);

        try {
            await downloadBilingualOcrPackage((percent) => {
                setDownloadPercent(percent);
            });
            // Download complete - immediately proceed to OCR execution
            setIsDownloading(false);
            onRunOcr();
        } catch (err: unknown) {
            setIsDownloading(false);
            setErrorMsg(err instanceof Error ? err.message : "فشل تنزيل حزمة التعرف الضوئي");
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-lg rounded-xl border border-amber-500/30 bg-zinc-900 p-6 shadow-2xl relative text-right" dir="rtl">
                {/* Close button */}
                <button
                    onClick={onClose}
                    disabled={isDownloading}
                    className="absolute left-4 top-4 text-zinc-400 hover:text-zinc-200 disabled:opacity-50 transition-colors"
                >
                    <X className="w-5 h-5" />
                </button>

                {/* Header with Warning Icon */}
                <div className="flex items-center gap-3 mb-3">
                    <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        <AlertTriangle className="w-6 h-6" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-zinc-100">
                            تنبيه: تم رصد خطوط مشوهة أو غير معيارية
                        </h3>
                        <p className="text-xs text-zinc-400 truncate max-w-xs sm:max-w-sm" dir="ltr">
                            {fileName}
                        </p>
                    </div>
                </div>

                {/* Technical Explanation */}
                <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3.5 mb-5 text-xs text-zinc-300 leading-relaxed space-y-2">
                    <p>
                        يحتوي هذا الملف على خطوط مخصصة مدمجة (Custom Embedded Fonts) تفتقر إلى جداول اليونيكود القياسية، مما يؤدي إلى استبدال الحروف برمز منطقة خاصة (PUA) أو تفتت الكلمات وانعكاسها في الاستخراج العادي.
                    </p>
                    <p className="text-amber-300 font-medium flex items-center gap-1.5 pt-1">
                        <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
                        نوصي بشدة باستخدام تقنية التعرف الضوئي (OCR) لقراءة النص بصرياً بدقة 100%.
                    </p>
                </div>

                {/* Download Progress Bar if currently downloading */}
                {isDownloading && (
                    <div className="mb-5 p-3 rounded-lg bg-indigo-950/40 border border-indigo-500/30">
                        <div className="flex justify-between items-center text-xs text-indigo-200 mb-1.5">
                            <span className="flex items-center gap-1.5">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                                جاري تنزيل حزمة التعرف الضوئي (مرة واحدة فقط)...
                            </span>
                            <span className="font-mono font-bold text-indigo-300">{downloadPercent}%</span>
                        </div>
                        <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                            <div
                                className="bg-gradient-to-r from-indigo-500 to-violet-500 h-full transition-all duration-300 rounded-full"
                                style={{ width: `${downloadPercent}%` }}
                            />
                        </div>
                    </div>
                )}

                {errorMsg && (
                    <div className="mb-4 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
                        {errorMsg}
                    </div>
                )}

                {/* Table Algorithm Quick Action */}
                <div className="mb-4 p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-800/80 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <Table className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                        <span className="text-xs text-zinc-300">
                            خوارزمية الجداول: {isTableEnabled ? <span className="text-indigo-300 font-medium">مفعّلة</span> : <span className="text-zinc-500 font-medium">معطّلة</span>}
                        </span>
                    </div>
                    {isTableEnabled ? (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isDownloading}
                            onClick={() => handleToggleTable(false)}
                            className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 text-xs h-6 px-2 gap-1 shrink-0"
                        >
                            <PowerOff className="w-2.5 h-2.5" />
                            إغلاق الخوارزمية
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="default"
                            size="sm"
                            disabled={isDownloading}
                            onClick={() => handleToggleTable(true)}
                            className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs h-6 px-2 gap-1 shrink-0"
                        >
                            <Play className="w-2.5 h-2.5" />
                            تفعيل الخوارزمية
                        </Button>
                    )}
                </div>

                {/* Action Buttons */}
                <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-1">
                    {/* Primary Button: Run or Download OCR */}
                    <Button
                        onClick={handleOcrAction}
                        disabled={isDownloading}
                        className="w-full sm:flex-1 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-medium text-xs h-10 gap-2 shadow-lg shadow-indigo-600/20"
                    >
                        {isDownloading ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                جاري التحميل ({downloadPercent}%)...
                            </>
                        ) : isOcrInstalled ? (
                            <>
                                <Sparkles className="w-4 h-4 text-amber-300" />
                                استخدام التعرف الضوئي (OCR) - موصى به
                            </>
                        ) : (
                            <>
                                <Download className="w-4 h-4" />
                                تنزيل وتشغيل الـ OCR - موصى به
                            </>
                        )}
                    </Button>

                    {/* Secondary Button: Continue Regular Vector Extraction */}
                    <Button
                        variant="outline"
                        onClick={onContinueAnyway}
                        disabled={isDownloading}
                        className="w-full sm:w-auto border-zinc-700 bg-zinc-800/60 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-xs h-10 gap-1.5"
                    >
                        المتابعة رغم التشوه
                        <ArrowLeft className="w-3.5 h-3.5" />
                    </Button>
                </div>
            </div>
        </div>
    );
}
