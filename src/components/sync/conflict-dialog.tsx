"use client";

/**
 * Conflict Resolution Dialog
 * 
 * A modal dialog for manually resolving sync conflicts between local and server versions.
 * Shows both versions side-by-side with visual diff highlighting.
 */

import { useState, useEffect } from "react";
import { X, Check, ArrowLeft, ArrowRight, GitMerge } from "lucide-react";
import { SyncConflict } from "@/lib/sync/idb-types";
import { conflictResolver, DiffOp } from "@/lib/sync/conflict-resolver";

interface ConflictDialogProps {
    /** The conflict to resolve */
    conflict: SyncConflict;
    /** Called when conflict is resolved */
    onResolve: (resolution: {
        strategy: 'local' | 'server' | 'merge';
        content: string;
    }) => void;
    /** Called when dialog is dismissed */
    onClose: () => void;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

/**
 * Render a single diff line with appropriate styling
 */
function DiffLine({ op }: { op: DiffOp }) {
    const baseClasses = "font-mono text-sm px-2 py-0.5 whitespace-pre-wrap break-all";

    switch (op.type) {
        case 'insert':
            return (
                <div className={`${baseClasses} bg-green-900/30 border-l-2 border-green-500 text-green-300`}>
                    + {op.value}
                </div>
            );
        case 'delete':
            return (
                <div className={`${baseClasses} bg-red-900/30 border-l-2 border-red-500 text-red-300`}>
                    - {op.value}
                </div>
            );
        case 'equal':
            return (
                <div className={`${baseClasses} text-zinc-400`}>
                    &nbsp; {op.value}
                </div>
            );
    }
}

export function ConflictDialog({ conflict, onResolve, onClose }: ConflictDialogProps) {
    const [selectedStrategy, setSelectedStrategy] = useState<'local' | 'server' | 'merge'>('local');
    const [mergedContent, setMergedContent] = useState<string>('');
    const [diffs, setDiffs] = useState<DiffOp[]>([]);
    const [showMergeEditor, setShowMergeEditor] = useState(false);

    // Compute diffs on mount
    useEffect(() => {
        const result = conflictResolver.attemptAutoMerge(
            '', // Base content not available, use empty
            conflict.localVersion.content,
            conflict.serverVersion.content
        );

        if (result.diffs) {
            setDiffs(result.diffs);
        }

        // Initialize merged content with local version
        setMergedContent(conflict.localVersion.content);
    }, [conflict]);

    const handleResolve = () => {
        let content: string;

        switch (selectedStrategy) {
            case 'local':
                content = conflict.localVersion.content;
                break;
            case 'server':
                content = conflict.serverVersion.content;
                break;
            case 'merge':
                content = mergedContent;
                break;
        }

        onResolve({ strategy: selectedStrategy, content });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl w-[95vw] max-w-5xl max-h-[90vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
                    <div className="flex items-center gap-3">
                        <GitMerge className="w-5 h-5 text-amber-400" />
                        <h2 className="text-lg font-semibold text-zinc-100">
                            تعارض في الملف
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Strategy Selection */}
                <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2">
                    <span className="text-sm text-zinc-400 ml-2">اختر الإجراء:</span>
                    <div className="flex gap-2">
                        <button
                            onClick={() => { setSelectedStrategy('local'); setShowMergeEditor(false); }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5
                                ${selectedStrategy === 'local'
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                        >
                            <ArrowLeft className="w-4 h-4" />
                            قبول المحلي
                        </button>
                        <button
                            onClick={() => { setSelectedStrategy('server'); setShowMergeEditor(false); }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5
                                ${selectedStrategy === 'server'
                                    ? 'bg-purple-600 text-white'
                                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                        >
                            قبول الخادم
                            <ArrowRight className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => { setSelectedStrategy('merge'); setShowMergeEditor(true); }}
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5
                                ${selectedStrategy === 'merge'
                                    ? 'bg-amber-600 text-white'
                                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                        >
                            <GitMerge className="w-4 h-4" />
                            دمج يدوي
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-hidden flex">
                    {showMergeEditor ? (
                        /* Merge Editor */
                        <div className="flex-1 flex flex-col p-4">
                            <div className="text-sm text-zinc-400 mb-2">
                                عدّل المحتوى للدمج اليدوي:
                            </div>
                            <textarea
                                value={mergedContent}
                                onChange={(e) => setMergedContent(e.target.value)}
                                className="flex-1 w-full bg-zinc-950 border border-zinc-700 rounded-md p-3 
                                    text-zinc-100 font-mono text-sm resize-none focus:outline-none 
                                    focus:ring-1 focus:ring-amber-500/50"
                                dir="auto"
                            />
                        </div>
                    ) : (
                        /* Side-by-Side Comparison */
                        <div className="flex-1 flex overflow-hidden">
                            {/* Local Version */}
                            <div className="flex-1 flex flex-col border-l border-zinc-800">
                                <div className="px-3 py-2 bg-zinc-800/50 border-b border-zinc-800 flex items-center justify-between">
                                    <span className="text-sm font-medium text-blue-400">
                                        النسخة المحلية
                                    </span>
                                    <span className="text-xs text-zinc-500">
                                        {formatTime(conflict.localVersion.lastModified)}
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto p-3 bg-zinc-950/50">
                                    <pre className="text-sm text-zinc-300 whitespace-pre-wrap break-all font-mono" dir="auto">
                                        {conflict.localVersion.content}
                                    </pre>
                                </div>
                            </div>

                            {/* Diff View (Center) */}
                            <div className="w-1/3 flex flex-col border-x border-zinc-800">
                                <div className="px-3 py-2 bg-zinc-800/50 border-b border-zinc-800">
                                    <span className="text-sm font-medium text-zinc-400">
                                        الاختلافات
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto bg-zinc-950/70">
                                    {diffs.map((op, i) => (
                                        <DiffLine key={i} op={op} />
                                    ))}
                                </div>
                            </div>

                            {/* Server Version */}
                            <div className="flex-1 flex flex-col">
                                <div className="px-3 py-2 bg-zinc-800/50 border-b border-zinc-800 flex items-center justify-between">
                                    <span className="text-sm font-medium text-purple-400">
                                        نسخة الخادم
                                    </span>
                                    <span className="text-xs text-zinc-500">
                                        {formatTime(conflict.serverVersion.lastModified)}
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto p-3 bg-zinc-950/50">
                                    <pre className="text-sm text-zinc-300 whitespace-pre-wrap break-all font-mono" dir="auto">
                                        {conflict.serverVersion.content}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-zinc-700 flex items-center justify-between">
                    <div className="text-xs text-zinc-500">
                        ETag المحلي: <code className="text-zinc-400">{conflict.localVersion.etag.slice(0, 8)}...</code>
                        {' | '}
                        ETag الخادم: <code className="text-zinc-400">{conflict.serverVersion.etag.slice(0, 8)}...</code>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 rounded-md text-sm font-medium bg-zinc-800 text-zinc-300 
                                hover:bg-zinc-700 transition-colors"
                        >
                            إلغاء
                        </button>
                        <button
                            onClick={handleResolve}
                            className="px-4 py-2 rounded-md text-sm font-medium bg-green-600 text-white 
                                hover:bg-green-500 transition-colors flex items-center gap-1.5"
                        >
                            <Check className="w-4 h-4" />
                            تأكيد الحل
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
