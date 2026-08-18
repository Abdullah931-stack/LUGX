"use client";

/**
 * Conflict Resolution Dialog
 * 
 * A comprehensive modal dialog for resolving sync conflicts between local, server, and base versions.
 * Displays natural plain text without exposing HTML tags or forcing users to type HTML code.
 * Supports Three-Way Merge, visual diffing, metadata resolution, and server deletion handling.
 */

import { useState, useEffect, useMemo } from "react";
import { X, Check, ArrowLeft, ArrowRight, GitMerge, AlertTriangle, RotateCcw, Trash2, FileText, Database } from "lucide-react";
import { SyncConflict } from "@/lib/sync/idb-types";
import { conflictResolver, DiffOp, MergeResult, ResolutionStrategy } from "@/lib/sync/conflict-resolver";
import { htmlToPlainText } from "@/lib/exporters/utils/markdown-stripper";
import { convertTextToHTML } from "@/lib/parsers/text-to-html";
import { sanitizeHtml } from "@/lib/sanitize-client";

export interface ConflictResolutionPayload {
    strategy: ResolutionStrategy;
    content: string;
    title?: string;
    parentFolderId?: string | null;
}

interface ConflictDialogProps {
    /** The conflict to resolve */
    conflict: SyncConflict;
    /** Called when conflict is resolved */
    onResolve: (resolution: ConflictResolutionPayload) => void | Promise<void>;
    /** Called when dialog is dismissed/cancelled */
    onClose: () => void;
    /** Loading state while server write is in flight */
    isResolving?: boolean;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp?: number): string {
    if (!timestamp) return "غير متوفر";
    return new Date(timestamp).toLocaleString('ar-EG', {
        dateStyle: 'short',
        timeStyle: 'medium',
    });
}

/**
 * Strip HTML tags from a text string while preserving conflict markers
 */
function cleanHtmlForDisplay(content: string): string {
    if (!content) return "";
    
    // If it contains conflict markers, format each section cleanly
    if (content.includes('<<<<<<< LOCAL')) {
        const lines = content.split('\n');
        const cleanedLines: string[] = [];
        for (const line of lines) {
            if (line.startsWith('<<<<<<<') || line.startsWith('=======') || line.startsWith('>>>>>>>')) {
                cleanedLines.push(line);
            } else {
                const plain = htmlToPlainText(line);
                cleanedLines.push(plain || line);
            }
        }
        return cleanedLines.join('\n');
    }

    return htmlToPlainText(content);
}

/**
 * Ensure content submitted back to editor is valid TipTap HTML
 */
function ensureHtmlForSave(content: string, originalHtmlFallback?: string): string {
    if (!content || content.trim().length === 0) {
        return '<p></p>';
    }

    // If it already has HTML block tags, sanitize and return
    if (/<(?:\/p|\/h[1-6]|\/li|\/blockquote|\/div)>/i.test(content)) {
        return sanitizeHtml(content);
    }

    // If plain text (user edited natural text), convert paragraphs to HTML
    return convertTextToHTML(content);
}

/**
 * Render a single diff line with appropriate styling in natural text
 */
function DiffLine({ op }: { op: DiffOp }) {
    const plainText = htmlToPlainText(op.value) || op.value;
    if (!plainText.trim() && op.type === 'equal') return null;

    const baseClasses = "text-xs sm:text-sm px-2.5 py-1 whitespace-pre-wrap break-words leading-relaxed rounded font-sans";

    switch (op.type) {
        case 'insert':
            return (
                <div className={`${baseClasses} bg-green-950/70 border-r-2 border-green-500 text-green-300`}>
                    + {plainText}
                </div>
            );
        case 'delete':
            return (
                <div className={`${baseClasses} bg-red-950/70 border-r-2 border-red-500 text-red-300 line-through opacity-80`}>
                    - {plainText}
                </div>
            );
        case 'equal':
            return (
                <div className={`${baseClasses} text-zinc-400`}>
                    &nbsp; {plainText}
                </div>
            );
    }
}

export function ConflictDialog({ conflict, onResolve, onClose, isResolving = false }: ConflictDialogProps) {
    const isDeleteConflict = conflict.type === 'delete_conflict' || conflict.serverVersion.deleted;
    const hasBaseSnapshot = !!conflict.baseVersion && typeof conflict.baseVersion.content === 'string';

    // Clean display strings (no HTML tags)
    const localDisplayText = useMemo(() => cleanHtmlForDisplay(conflict.localVersion.content), [conflict.localVersion.content]);
    const serverDisplayText = useMemo(() => cleanHtmlForDisplay(conflict.serverVersion.content), [conflict.serverVersion.content]);
    const baseDisplayText = useMemo(() => cleanHtmlForDisplay(conflict.baseVersion?.content || ""), [conflict.baseVersion?.content]);

    // Compute initial 3-way merge
    const initialMergeResult = useMemo<MergeResult>(() => {
        return conflictResolver.attemptThreeWayMerge({
            base: conflict.baseVersion || null,
            local: conflict.localVersion,
            remote: conflict.serverVersion,
        });
    }, [conflict]);

    const [selectedStrategy, setSelectedStrategy] = useState<ResolutionStrategy>(() => {
        if (isDeleteConflict) return 'restore';
        if (initialMergeResult.success) return 'merge';
        return 'local';
    });

    // Editable text for merge editor (pure text without HTML tags)
    const [editableText, setEditableText] = useState<string>(() => {
        return cleanHtmlForDisplay(initialMergeResult.content || conflict.localVersion.content);
    });

    const [selectedTitle, setSelectedTitle] = useState<string>(() => {
        return initialMergeResult.title || conflict.localVersion.title || conflict.serverVersion.title || 'Untitled';
    });

    const [activeTab, setActiveTab] = useState<'compare' | 'merge_editor' | 'base_view'>('compare');

    // Re-sync state when conflict changes
    useEffect(() => {
        const result = conflictResolver.attemptThreeWayMerge({
            base: conflict.baseVersion || null,
            local: conflict.localVersion,
            remote: conflict.serverVersion,
        });

        if (isDeleteConflict) {
            setSelectedStrategy('restore');
        } else if (result.success) {
            setSelectedStrategy('merge');
        } else {
            setSelectedStrategy('local');
        }

        setEditableText(cleanHtmlForDisplay(result.content || conflict.localVersion.content));
        setSelectedTitle(result.title || conflict.localVersion.title || conflict.serverVersion.title || 'Untitled');
    }, [conflict, isDeleteConflict]);

    const handleResolveClick = async () => {
        let contentToSubmit = conflict.localVersion.content;

        switch (selectedStrategy) {
            case 'local':
                contentToSubmit = conflict.localVersion.content;
                break;
            case 'server':
                contentToSubmit = conflict.serverVersion.content;
                break;
            case 'merge':
                contentToSubmit = ensureHtmlForSave(editableText, initialMergeResult.content);
                break;
            case 'restore':
                contentToSubmit = conflict.localVersion.content;
                break;
            case 'delete':
                contentToSubmit = '';
                break;
        }

        await onResolve({
            strategy: selectedStrategy,
            content: contentToSubmit,
            title: selectedTitle,
            parentFolderId: conflict.localVersion.parentFolderId,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 font-sans" dir="rtl">
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/90">
                    <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400">
                            <GitMerge className="w-5 h-5" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
                                تعارض في التزامن (Three-Way Conflict Detected)
                                {isDeleteConflict && (
                                    <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">
                                        حذف في الخادم
                                    </span>
                                )}
                            </h2>
                            <p className="text-xs text-zinc-400">
                                تم تعديل هذا الملف في جلسة أخرى أو على الخادم أثناء وجود تعديلات محلية غير محفوظة.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={isResolving}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
                        title="إلغاء وإبقاء التعديلات غير متزامنة"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Notice Banners */}
                {!hasBaseSnapshot && !isDeleteConflict && (
                    <div className="px-5 py-2.5 bg-amber-950/40 border-b border-amber-800/50 flex items-center gap-2.5 text-xs text-amber-300">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-400" />
                        <span>
                            <strong>تنبيه:</strong> لم يتم العثور على نسخة مرجعية (Base Snapshot). تم تعطيل الدمج التلقائي الأعمى لحماية بياناتك. يرجى مراجعة النسختين واختيار النسخة المناسبة.
                        </span>
                    </div>
                )}

                {initialMergeResult.hasOverlaps && hasBaseSnapshot && !isDeleteConflict && (
                    <div className="px-5 py-2.5 bg-indigo-950/40 border-b border-indigo-800/50 flex items-center gap-2.5 text-xs text-indigo-300">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 text-indigo-400" />
                        <span>
                            توجد تعديلات متداخلة في نفس الأسطر. تم إدراج علامات التعارض في تبويب محرر الدمج لتسويتها بالنص الطبيعي.
                        </span>
                    </div>
                )}

                {/* Strategy Actions Bar */}
                <div className="px-5 py-3 border-b border-zinc-800/80 bg-zinc-950/40 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-zinc-400 font-medium ml-1">استراتيجية الحل:</span>

                        {isDeleteConflict ? (
                            <>
                                <button
                                    onClick={() => setSelectedStrategy('restore')}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                                        ${selectedStrategy === 'restore'
                                            ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/30'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    استعادة الملف بالتعديلات المحلية
                                </button>
                                <button
                                    onClick={() => setSelectedStrategy('delete')}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                                        ${selectedStrategy === 'delete'
                                            ? 'bg-red-600 text-white shadow-lg shadow-red-900/30'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                    تأكيد حذف الملف محلياً
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    onClick={() => { setSelectedStrategy('local'); setActiveTab('compare'); }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                                        ${selectedStrategy === 'local'
                                            ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/30'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                                >
                                    <ArrowRight className="w-3.5 h-3.5" />
                                    اعتماد النسخة المحلية (Keep Local)
                                </button>
                                <button
                                    onClick={() => { setSelectedStrategy('server'); setActiveTab('compare'); }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                                        ${selectedStrategy === 'server'
                                            ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/30'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                                >
                                    <ArrowLeft className="w-3.5 h-3.5" />
                                    اعتماد نسخة الخادم (Keep Remote)
                                </button>
                                <button
                                    onClick={() => { setSelectedStrategy('merge'); setActiveTab('merge_editor'); }}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5
                                        ${selectedStrategy === 'merge'
                                            ? 'bg-amber-600 text-white shadow-lg shadow-amber-900/30'
                                            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                                >
                                    <GitMerge className="w-3.5 h-3.5" />
                                    دمج ذكي / تحرير يدوي (3-Way Merge)
                                </button>
                            </>
                        )}
                    </div>

                    {/* View Tabs */}
                    {!isDeleteConflict && (
                        <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-xs">
                            <button
                                onClick={() => setActiveTab('compare')}
                                className={`px-2.5 py-1 rounded-md transition-colors ${activeTab === 'compare' ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400 hover:text-zinc-200'}`}
                            >
                                مقارنة الفروق
                            </button>
                            <button
                                onClick={() => setActiveTab('merge_editor')}
                                className={`px-2.5 py-1 rounded-md transition-colors ${activeTab === 'merge_editor' ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400 hover:text-zinc-200'}`}
                            >
                                محرر الدمج
                            </button>
                            {hasBaseSnapshot && (
                                <button
                                    onClick={() => setActiveTab('base_view')}
                                    className={`px-2.5 py-1 rounded-md transition-colors ${activeTab === 'base_view' ? 'bg-zinc-800 text-zinc-100 font-medium' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    الأصل (Base)
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Content Workspace */}
                <div className="flex-1 overflow-hidden flex flex-col bg-zinc-950/70 min-h-[300px]">
                    {activeTab === 'merge_editor' ? (
                        <div className="flex-1 flex flex-col p-4 overflow-hidden">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs text-zinc-400">
                                    محرر تسوية الدمج (اكتب أو عدّل النص الطبيعي مباشرة دون الحاجة لأي وسوم):
                                </span>
                                <button
                                    onClick={() => setEditableText(cleanHtmlForDisplay(initialMergeResult.content || conflict.localVersion.content))}
                                    className="text-xs text-amber-400 hover:underline"
                                >
                                    إعادة ضبط للنص المقترح
                                </button>
                            </div>
                            <textarea
                                value={editableText}
                                onChange={(e) => setEditableText(e.target.value)}
                                placeholder="اكتب أو عدل النص النهائي هنا..."
                                className="flex-1 w-full bg-zinc-950 border border-zinc-800 rounded-lg p-4 
                                    text-zinc-100 font-sans text-sm resize-none focus:outline-none 
                                    focus:ring-1 focus:ring-amber-500/60 leading-relaxed custom-scrollbar"
                                dir="auto"
                            />
                        </div>
                    ) : activeTab === 'base_view' && conflict.baseVersion ? (
                        <div className="flex-1 flex flex-col p-4 overflow-auto">
                            <div className="text-xs text-zinc-400 mb-2 flex items-center gap-1.5">
                                <Database className="w-3.5 h-3.5 text-zinc-500" />
                                النسخة المرجعية المشتركة قبل التعديلات (Base Snapshot v{conflict.baseVersion.version}):
                            </div>
                            <div className="flex-1 bg-zinc-950 border border-zinc-800/80 rounded-lg p-4 text-sm text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed" dir="auto">
                                {baseDisplayText || "لا يوجد محتوى نصي في النسخة المرجعية."}
                            </div>
                        </div>
                    ) : (
                        /* Side-by-Side View with Diff Center */
                        <div className="flex-1 flex overflow-hidden divide-x divide-x-reverse divide-zinc-800">
                            {/* Local Version Column */}
                            <div className="flex-1 flex flex-col overflow-hidden bg-zinc-900/30">
                                <div className="px-3.5 py-2 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-full bg-blue-500" />
                                        <span className="text-xs font-semibold text-blue-400">
                                            النسخة المحلية (Local v{conflict.localVersion.version})
                                        </span>
                                    </div>
                                    <span className="text-[11px] text-zinc-500 font-mono">
                                        {formatTime(conflict.localVersion.lastModified)}
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                                    <div className="text-sm text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed select-text" dir="auto">
                                        {localDisplayText || "مستند فارغ"}
                                    </div>
                                </div>
                            </div>

                            {/* Visual Diff View Center */}
                            <div className="w-1/3 flex flex-col overflow-hidden bg-zinc-950/90 border-x border-zinc-800">
                                <div className="px-3 py-2 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between">
                                    <span className="text-xs font-medium text-zinc-400 flex items-center gap-1">
                                        <FileText className="w-3.5 h-3.5 text-zinc-500" />
                                        الفروق النصية (Diff)
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto p-2.5 space-y-1 custom-scrollbar">
                                    {(initialMergeResult.diffs || []).map((op, i) => (
                                        <DiffLine key={i} op={op} />
                                    ))}
                                </div>
                            </div>

                            {/* Server Version Column */}
                            <div className="flex-1 flex flex-col overflow-hidden bg-zinc-900/30">
                                <div className="px-3.5 py-2 bg-zinc-900/80 border-b border-zinc-800 flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                        <div className="w-2 h-2 rounded-full bg-purple-500" />
                                        <span className="text-xs font-semibold text-purple-400">
                                            نسخة الخادم (Server v{conflict.serverVersion.version})
                                        </span>
                                    </div>
                                    <span className="text-[11px] text-zinc-500 font-mono">
                                        {formatTime(conflict.serverVersion.lastModified)}
                                    </span>
                                </div>
                                <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                                    {conflict.serverVersion.deleted ? (
                                        <div className="flex items-center justify-center h-full text-xs text-red-400/80 italic">
                                            تم حذف هذا الملف من الخادم
                                        </div>
                                    ) : (
                                        <div className="text-sm text-zinc-200 whitespace-pre-wrap font-sans leading-relaxed select-text" dir="auto">
                                            {serverDisplayText || "مستند فارغ"}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer Controls */}
                <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-900 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-2">
                        <span>إصدار محلي: <code className="text-zinc-400">v{conflict.localVersion.version}</code></span>
                        <span>|</span>
                        <span>إصدار الخادم: <code className="text-zinc-400">v{conflict.serverVersion.version}</code></span>
                    </div>

                    <div className="flex items-center gap-2.5">
                        <button
                            onClick={onClose}
                            disabled={isResolving}
                            className="px-4 py-2 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 
                                hover:bg-zinc-700 transition-colors disabled:opacity-50"
                        >
                            إلغاء (إبقاء محلياً)
                        </button>
                        <button
                            onClick={handleResolveClick}
                            disabled={isResolving}
                            className="px-5 py-2 rounded-lg text-xs font-semibold bg-green-600 text-white 
                                hover:bg-green-500 transition-all shadow-lg shadow-green-900/30 flex items-center gap-1.5
                                disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isResolving ? (
                                <span>جاري الحفظ والتأكيد...</span>
                            ) : (
                                <>
                                    <Check className="w-4 h-4" />
                                    تأكيد وحفظ الحل في الخادم
                                </>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

