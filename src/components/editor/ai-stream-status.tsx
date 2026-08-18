'use client';

import React from 'react';
import type { AIStreamStatus as AIStreamStatusType } from '@/lib/ai/stream-session';
import { Loader2, AlertCircle, RefreshCw, XCircle } from 'lucide-react';

interface AIStreamStatusProps {
    status: AIStreamStatusType;
    operation?: string;
    isConflict?: boolean;
    errorMessage?: string | null;
    onRetry?: () => void;
    onCancel?: () => void;
}

/**
 * AIStreamStatus Component
 *
 * Visual status indicator for active AI sessions without modifying document content.
 */
export const AIStreamStatus: React.FC<AIStreamStatusProps> = ({
    status,
    operation = 'AI Operation',
    isConflict = false,
    errorMessage,
    onRetry,
    onCancel,
}) => {
    if (status === 'idle') return null;

    if (isConflict) {
        return (
            <div className="mx-6 mt-3 p-3 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 text-xs flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>تنبيه: تم تعديل الملف من جلسة أخرى أثناء المعالجة. تم الحفاظ على النص الأصلي.</span>
                </div>
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-100 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" />
                        <span>إعادة المحاولة</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'failed') {
        return (
            <div className="mx-6 mt-3 p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-200 text-xs flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                    <span>{errorMessage || 'حدث خطأ أثناء معالجة النص، وتم استرداد الحصة.'}</span>
                </div>
                {onRetry && (
                    <button
                        onClick={onRetry}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-red-600/30 hover:bg-red-600/50 text-red-100 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" />
                        <span>إعادة المحاولة</span>
                    </button>
                )}
            </div>
        );
    }

    if (status === 'reserved' || status === 'streaming' || status === 'committing') {
        return (
            <div className="mx-6 mt-3 px-4 py-2 rounded-lg bg-zinc-900/80 border border-emerald-500/30 text-xs flex items-center justify-between backdrop-blur-xs">
                <div className="flex items-center gap-2.5 text-emerald-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="font-mono uppercase tracking-wide">
                        {status === 'reserved' && 'جاري حجز الحصة والاتصال بالنموذج...'}
                        {status === 'streaming' && `جاري البث المباشر (${operation})...`}
                        {status === 'committing' && 'جاري الالتزام وتأكيد التغيير...'}
                    </span>
                </div>
                {onCancel && (
                    <button
                        onClick={onCancel}
                        className="px-2.5 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    >
                        إلغاء
                    </button>
                )}
            </div>
        );
    }

    return null;
};
