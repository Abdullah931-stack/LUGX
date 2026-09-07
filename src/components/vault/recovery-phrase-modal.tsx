"use client";

import { useState } from "react";
import { Key, Copy, Check, AlertTriangle, ShieldCheck } from "lucide-react";

interface RecoveryPhraseModalProps {
    isOpen: boolean;
    onClose: () => void;
    mnemonic: string;
}

export function RecoveryPhraseModal({ isOpen, onClose, mnemonic }: RecoveryPhraseModalProps) {
    const [copied, setCopied] = useState(false);

    if (!isOpen || !mnemonic) return null;

    const words = mnemonic.trim().split(/\s+/);

    function handleCopy() {
        navigator.clipboard.writeText(mnemonic);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
    }

    return (
        <>
            <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50" onClick={onClose} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden text-right" dir="rtl">
                    {/* Header */}
                    <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                <Key className="w-5 h-5" />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-zinc-100">بذرة الاسترجاع (12 كلمة)</h3>
                                <p className="text-xs text-zinc-400">وسيلتك الوحيدة لاسترجاع الوصول عند نسيان كلمة المرور</p>
                            </div>
                        </div>
                    </div>

                    {/* Content */}
                    <div className="p-6 space-y-4">
                        <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/40 text-amber-300 text-xs flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                            <span>
                                لا تشارك هذه الكلمات مع أي شخص، ولا تحفظها في مكان غير موثوق.
                            </span>
                        </div>

                        {/* Words Grid */}
                        <div className="grid grid-cols-3 gap-2 p-3 bg-zinc-950/60 rounded-lg border border-zinc-800/80" dir="ltr">
                            {words.map((word, idx) => (
                                <div key={idx} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900/90 rounded border border-zinc-800 text-xs">
                                    <span className="text-zinc-500 font-mono text-[10px] w-4">{idx + 1}.</span>
                                    <span className="text-zinc-200 font-mono font-medium">{word}</span>
                                </div>
                            ))}
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={handleCopy}
                                className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                                <span>{copied ? "تم النسخ بنجاح" : "نسخ الكلمات الـ 12"}</span>
                            </button>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-zinc-800 flex justify-end">
                        <button
                            onClick={onClose}
                            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                            <ShieldCheck className="w-4 h-4" />
                            <span>تم الحفظ والإغلاق</span>
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
