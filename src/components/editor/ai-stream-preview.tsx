'use client';

import React from 'react';
import { detectTextDirection } from '@/lib/utils';
import { Sparkles, StopCircle, Check, RefreshCw } from 'lucide-react';

interface AIStreamPreviewProps {
    text: string;
    operation: string;
    isStreaming: boolean;
    onStop: () => void;
    onApply?: () => void;
    onRetry?: () => void;
}

/**
 * AIStreamPreview Component
 *
 * Renders an isolated ephemeral live preview panel with explicit action controls.
 */
export const AIStreamPreview: React.FC<AIStreamPreviewProps> = ({
    text,
    operation,
    isStreaming,
    onStop,
    onApply,
    onRetry,
}) => {
    if (!text && !isStreaming) return null;

    const dir = detectTextDirection(text || '');

    return (
        <div className="mx-6 my-4 p-4 rounded-xl bg-zinc-900/90 border border-emerald-500/40 shadow-lg text-zinc-100 flex flex-col gap-3 backdrop-blur-md">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
                <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono font-medium uppercase tracking-wider">
                    <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                    <span>معاينة الذكاء الاصطناعي ({operation})</span>
                    {isStreaming && (
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping inline-block" />
                    )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                    {isStreaming ? (
                        <button
                            onClick={onStop}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-red-600/20 hover:bg-red-600/40 border border-red-500/30 text-red-300 text-xs transition-colors"
                        >
                            <StopCircle className="w-3.5 h-3.5" />
                            <span>إيقاف التوليد</span>
                        </button>
                    ) : (
                        <>
                            {onRetry && (
                                <button
                                    onClick={onRetry}
                                    className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    <span>إعادة المحاولة</span>
                                </button>
                            )}
                            {onApply && (
                                <button
                                    onClick={onApply}
                                    className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
                                >
                                    <Check className="w-3.5 h-3.5" />
                                    <span>تطبيق التعديل</span>
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Live Preview Text Content */}
            <div
                dir={dir}
                className="text-sm leading-relaxed whitespace-pre-wrap text-zinc-200 max-h-60 overflow-y-auto custom-scrollbar font-normal p-2 rounded bg-zinc-950/40 border border-zinc-800/40"
            >
                {text || 'جاري استقبال البيانات...'}
                {isStreaming && (
                    <span className="inline-block w-1.5 h-4 bg-emerald-400 ml-1 align-middle animate-pulse rounded-xs shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                )}
            </div>
        </div>
    );
};
