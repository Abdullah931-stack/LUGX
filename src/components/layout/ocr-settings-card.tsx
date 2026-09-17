"use client";

import { useState, useEffect } from "react";
import { Download, Trash2, CheckCircle2, Eye, Loader2, HardDrive, Table, PowerOff, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
    isOcrPackageInstalled,
    downloadBilingualOcrPackage,
    deleteOcrPackage,
} from "@/lib/parsers/pdf-ocr-engine";
import {
    isTableExtractionEnabled,
    setTableExtractionEnabled,
} from "@/lib/parsers/pdf-settings";
import { useToast } from "@/hooks/use-toast";

export function OcrSettingsCard() {
    const [isInstalled, setIsInstalled] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadPercent, setDownloadPercent] = useState(0);
    const [isTableEnabled, setIsTableEnabled] = useState(isTableExtractionEnabled);
    const { toast } = useToast();

    useEffect(() => {
        void checkStatus();
    }, []);

    async function checkStatus() {
        try {
            setIsLoading(true);
            const installed = await isOcrPackageInstalled();
            setIsInstalled(installed);
        } catch {
            setIsInstalled(false);
        } finally {
            setIsLoading(false);
        }
    }

    async function handleDownload() {
        try {
            setIsDownloading(true);
            setDownloadPercent(0);

            await downloadBilingualOcrPackage((percent) => {
                setDownloadPercent(percent);
            });

            setIsInstalled(true);
            toast({
                title: "اكتمل التنزيل بنجاح",
                description: "تم تثبيت حزمة OCR المزدوجة (عربي + إنجليزي) وتخزينها محلياً في المتصفح.",
            });
        } catch (error) {
            console.error("OCR download error:", error);
            toast({
                title: "فشل التنزيل",
                description: "تعذر تنزيل حزمة OCR. يُرجى التحقق من اتصال الإنترنت والمحاولة مجدداً.",
                variant: "destructive",
            });
        } finally {
            setIsDownloading(false);
        }
    }

    async function handleDelete() {
        try {
            await deleteOcrPackage();
            setIsInstalled(false);
            toast({
                title: "تم حذف الحزمة",
                description: "تم تحرير مساحة التخزين وإزالة ملفات الـ OCR من ذاكرة المتصفح.",
            });
        } catch (error) {
            console.error("Delete error:", error);
        }
    }

    function handleToggleTable(enabled: boolean) {
        setIsTableEnabled(enabled);
        setTableExtractionEnabled(enabled);
        toast({
            title: enabled ? "تم تفعيل استخراج الجداول" : "تم تعطيل استخراج الجداول",
            description: enabled
                ? "سيقوم النظام بتحليل إحداثيات النصوص وتوليد جداول Markdown تلقائية عند استيراد ملفات الـ PDF."
                : "سيتم استخراج محتوى ملفات الـ PDF كنصوص وفقرات خطية متتابعة دون تحويلها إلى جداول Markdown.",
        });
    }

    return (
        <Card className="border-zinc-800 bg-zinc-900/50">
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Eye className="w-5 h-5 text-indigo-400" />
                        <CardTitle className="text-base font-medium text-zinc-100">
                            معالجة المستندات والتعرف الضوئي (Document Processing & OCR)
                        </CardTitle>
                    </div>
                </div>
                <CardDescription className="text-xs text-zinc-400">
                    خيارات معالجة وتطهير ملفات PDF، وتوليد الجداول المكانية، وحزمة التعرف الضوئي المزدوج.
                </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4 pt-2">
                {/* Section 1: Bilingual OCR Engine */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-300">
                            محرك التعرف الضوئي (OCR المزدوج - عربي وإنجليزي)
                        </span>
                        <div>
                            {isLoading ? (
                                <span className="text-xs text-zinc-500 flex items-center gap-1">
                                    <Loader2 className="w-3 h-3 animate-spin" /> جاري الفحص...
                                </span>
                            ) : isInstalled ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                    <CheckCircle2 className="w-3 h-3" /> مثبتة ومحفوظة محلياً (~19MB)
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                                    <HardDrive className="w-3 h-3" /> غير مثبتة (0MB)
                                </span>
                            )}
                        </div>
                    </div>

                    <p className="text-xs text-zinc-400">
                        حزمة اختيارية مستقلة تحتوي على نموذجي اللغتين العربية والإنجليزية لمعالجة ملفات الـ PDF الممسوحة ضوئياً والمحارف التالفة. لا يتم تنزيلها إلا عند رغبتك.
                    </p>

                    {isDownloading ? (
                        <div className="space-y-2 py-2">
                            <div className="flex justify-between text-xs text-zinc-400">
                                <span className="flex items-center gap-1.5">
                                    <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                                    جاري تنزيل ملفات Tesseract ونماذج ara + eng...
                                </span>
                                <span className="font-mono text-zinc-200">{downloadPercent}%</span>
                            </div>
                            <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
                                <div
                                    className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                                    style={{ width: `${downloadPercent}%` }}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between gap-4 pt-1">
                            <p className="text-xs text-zinc-500">
                                {isInstalled
                                    ? "الحزمة جاهزة في كاش المتصفح. يمكنك اختيار تقنية OCR عند استيراد أي ملف PDF."
                                    : "انقر على زر التنزيل لجلب الحزمة وتخزينها محلياً في ذاكرة التخزين المؤقت للمتصفح."}
                            </p>

                            <div className="flex items-center gap-2 shrink-0">
                                {isInstalled ? (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleDelete}
                                        className="border-zinc-800 text-zinc-400 hover:text-red-400 hover:border-red-900/50 gap-1.5 text-xs"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        حذف الحزمة
                                    </Button>
                                ) : (
                                    <Button
                                        variant="default"
                                        size="sm"
                                        onClick={handleDownload}
                                        className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5 text-xs px-4"
                                    >
                                        <Download className="w-3.5 h-3.5" />
                                        تنزيل الحزمة (~19MB)
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Divider */}
                <div className="border-t border-zinc-800/80 pt-3" />

                {/* Section 2: Spatial Table Extraction Algorithm */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Table className="w-4 h-4 text-indigo-400" />
                            <span className="text-xs font-medium text-zinc-200">
                                خوارزمية استخراج الجداول الذكية (2D Spatial Table Extraction)
                            </span>
                        </div>
                        <div>
                            {isTableEnabled ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                    <CheckCircle2 className="w-3 h-3" /> مفعّلة (افتراضي)
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
                                    معطّلة
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 pt-1">
                        <p className="text-xs text-zinc-400 max-w-xl">
                            تحليل الإحداثيات المكانية للنصوص وتوليد جداول Markdown تلقائية (<code className="text-zinc-300 font-mono text-[11px]">| Col 1 | Col 2 |</code>). عند تعطيل هذا الخيار، يتم استخراج النصوص بشكل خطي تتابعي كفقرات عادية دون محاولة بناء جداول.
                        </p>

                        <div className="flex items-center gap-2 shrink-0">
                            {isTableEnabled ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleToggleTable(false)}
                                    className="border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 hover:border-amber-500/50 gap-1.5 text-xs font-medium"
                                >
                                    <PowerOff className="w-3.5 h-3.5" />
                                    إغلاق الخوارزمية (تعطيل)
                                </Button>
                            ) : (
                                <Button
                                    variant="default"
                                    size="sm"
                                    onClick={() => handleToggleTable(true)}
                                    className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5 text-xs font-medium px-4"
                                >
                                    <Play className="w-3.5 h-3.5" />
                                    تشغيل الخوارزمية (تفعيل)
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
