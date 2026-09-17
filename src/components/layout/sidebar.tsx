"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    ChevronLeft,
    ChevronRight,
    FileText,
    Folder,
    Plus,
    FolderPlus,
    Upload,
    MoreHorizontal,
    Trash2,
    ShieldCheck,
    Lock,
    X,
} from "lucide-react";
import Link from "next/link";
import { getUserFiles, getDeletedFiles, createFile, moveFile } from "@/server/actions/file-ops";
import { importFile } from "@/server/actions/import-file";
import { validateFile } from "@/lib/parsers/file-validator";
import { parseFileContent } from "@/lib/parsers/text-parser";
import { pdfWorkerBridge } from "@/lib/parsers/pdf-worker-bridge";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { cryptoWorkerBridge } from "@/lib/sync/crypto-worker-bridge";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { createClient } from "@/lib/supabase/client";
import { VaultUnlockModal } from "@/components/vault";
import { useToast } from "@/hooks/use-toast";
import { FileTreeItem } from "@/components/files/file-tree-item";
import { FileContextMenu } from "@/components/files/file-context-menu";
import { PdfImportModeDialog, PdfExtractionMode } from "@/components/layout/pdf-import-mode-dialog";
import { PdfCorruptedFontDialog } from "@/components/layout/pdf-corrupted-font-dialog";
import { isOcrPackageInstalled } from "@/lib/parsers/pdf-ocr-engine";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
    updatedAt: Date;
    deletedAt: Date | null;
    isEncrypted?: boolean;
    userId?: string;
}

interface SidebarProps {
    userId?: string;
}

export function Sidebar({ userId }: SidebarProps = {}) {
    const [collapsed, setCollapsed] = useState(false);
    const [files, setFiles] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isDragOver, setIsDragOver] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importToVault, setImportToVault] = useState(false);
    const [showUnlockVault, setShowUnlockVault] = useState(false);
    const [importProgress, setImportProgress] = useState<{
        fileName: string;
        currentPage: number;
        totalPages: number;
        percent: number;
    } | null>(null);
    const [pendingPdfImport, setPendingPdfImport] = useState<{
        files: File[];
        targetFolderId: string | null;
        pdfFileName: string;
    } | null>(null);
    const [corruptedFontNotice, setCorruptedFontNotice] = useState<{
        file: File;
        targetFolderId: string | null;
        remainingFiles: File[];
        isOcrInstalled: boolean;
    } | null>(null);
    const [effectiveUserId, setEffectiveUserId] = useState<string>(userId || "");
    const abortControllerRef = useRef<AbortController | null>(null);
    const [deletedFiles, setDeletedFiles] = useState<FileItem[]>([]);
    const [showTrash, setShowTrash] = useState(false);
    const { toast } = useToast();

    const resolveEffectiveUserId = useCallback(async (): Promise<string> => {
        if (userId && userId.trim()) return userId.trim();
        try {
            const supabase = createClient();
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.id) return user.id;
        } catch (err) {
            console.warn("[Sidebar] Failed to resolve auth user session:", err);
        }
        return "";
    }, [userId]);

    useEffect(() => {
        loadFiles();
        void resolveEffectiveUserId().then((uid) => {
            if (uid) setEffectiveUserId(uid);
        });
    }, [resolveEffectiveUserId]);

    async function loadFiles() {
        try {
            setLoading(true);
            const result = await getUserFiles();
            if (result.success && result.data) {
                // Build nested tree structure from flat array
                const { buildFileTree } = await import('@/lib/utils/file-tree');
                const treeData = buildFileTree(result.data);
                setFiles(treeData);
            }
        } catch (error) {
            console.error("Failed to load files:", error);
        } finally {
            setLoading(false);
        }
    }

    // Load tombstoned (soft-deleted) items for the Trash view.
    async function loadDeletedFiles() {
        try {
            const result = await getDeletedFiles();
            if (result.success && result.data) {
                setDeletedFiles(result.data);
            }
        } catch (error) {
            console.error("Failed to load deleted files:", error);
        }
    }

    // Handle file/folder movement via drag & drop
    async function handleMoveFile(fileId: string, newParentId: string | null) {
        try {
            const result = await moveFile(fileId, newParentId);
            if (result.success) {
                toast({
                    title: "Moved Successfully",
                    description: "File has been moved to the new location",
                });
                loadFiles(); // Refresh file list
            } else {
                toast({
                    title: "Move Failed",
                    description: result.error || "Failed to move file",
                    variant: "destructive",
                });
            }
        } catch (_error) {
            toast({
                title: "Move Error",
                description: "An error occurred while moving the file",
                variant: "destructive",
            });
        }
    }

    async function handleCreateFile() {
        const title = prompt("Enter file name:");
        if (!title) return;

        const result = await createFile(title, null, false);
        if (result.success) {
            loadFiles();
        }
    }

    async function handleCreateFolder() {
        const title = prompt("Enter folder name:");
        if (!title) return;

        const result = await createFile(title, null, true);
        if (result.success) {
            loadFiles();
        }
    }

    async function handleFileImport(fileList: FileList, targetFolderId: string | null = null) {
        if (isImporting) {
            toast({
                title: "جاري الاستيراد بالفعل",
                description: "يرجى الانتظار حتى اكتمال عملية الاستيراد الحالية",
            });
            return;
        }

        const filesArray = Array.from(fileList);

        // Validate files
        const validFiles: File[] = [];
        const invalidFiles: Array<{ file: File; error: string }> = [];

        filesArray.forEach((file: File) => {
            const validation = validateFile(file);
            if (validation.isValid) {
                validFiles.push(file);
            } else {
                invalidFiles.push({ file, error: validation.error || 'Invalid file' });
            }
        });

        // Show errors for invalid files
        if (invalidFiles.length > 0) {
            invalidFiles.forEach(({ file, error }: { file: File; error: string }) => {
                toast({
                    title: "Invalid File",
                    description: `${file.name}: ${error}`,
                    variant: "destructive",
                });
            });
        }

        if (validFiles.length === 0) return;

        // If vault import is toggled, ensure vault is unlocked first
        if (importToVault && !sessionKeyStore.hasMasterKey()) {
            setShowUnlockVault(true);
            toast({
                title: "الخزنة مقفلة",
                description: "يرجى فتح الخزنة أولاً لإتمام الاستيراد المشفر",
                variant: "destructive",
            });
            return;
        }

        // If any valid file is a PDF and OCR package is installed, show mode choice dialog
        const hasPdf = validFiles.some((f) => f.name.toLowerCase().endsWith('.pdf'));
        if (hasPdf) {
            const ocrInstalled = await isOcrPackageInstalled();
            if (ocrInstalled) {
                const firstPdf = validFiles.find((f) => f.name.toLowerCase().endsWith('.pdf'))!;
                setPendingPdfImport({
                    files: validFiles,
                    targetFolderId,
                    pdfFileName: firstPdf.name,
                });
                return;
            }
        }

        await executeFileImport(validFiles, targetFolderId, 'fast');
    }

    async function executeFileImport(
        validFiles: File[],
        targetFolderId: string | null,
        extractionMode: PdfExtractionMode = 'fast',
        bypassCorruptionCheck = false
    ) {
        setIsImporting(true);

        for (let fileIdx = 0; fileIdx < validFiles.length; fileIdx++) {
            const file = validFiles[fileIdx];
            const abortController = new AbortController();
            abortControllerRef.current = abortController;

            try {
                const isPdf = file.name.toLowerCase().endsWith('.pdf');
                const fileType = isPdf
                    ? 'pdf'
                    : file.name.toLowerCase().endsWith('.md')
                        ? 'md'
                        : 'txt';

                let textContent: string;

                if (fileType === 'pdf') {
                    setImportProgress({
                        fileName: file.name,
                        currentPage: 1,
                        totalPages: 1,
                        percent: 0,
                    });

                    const arrayBuffer = await file.arrayBuffer();

                    // Universal font corruption detection for regular (fast) extraction
                    if (!bypassCorruptionCheck && extractionMode === 'fast') {
                        const { detectPdfFontCorruption } = await import('@/lib/parsers/pdf-corruption-detector');
                        const corruptionReport = await detectPdfFontCorruption(arrayBuffer, 5);

                        if (corruptionReport.isCorrupted) {
                            const ocrInstalled = await isOcrPackageInstalled();
                            setCorruptedFontNotice({
                                file,
                                targetFolderId,
                                remainingFiles: validFiles.slice(fileIdx + 1),
                                isOcrInstalled: ocrInstalled,
                            });
                            setIsImporting(false);
                            setImportProgress(null);
                            return;
                        }
                    }

                    const { isTableExtractionEnabled } = await import('@/lib/parsers/pdf-settings');
                    const disableTableExtraction = !isTableExtractionEnabled();

                    if (extractionMode === 'ocr') {
                        const { runBilingualOcr } = await import('@/lib/parsers/pdf-ocr-engine');
                        textContent = await runBilingualOcr(arrayBuffer, {
                            signal: abortController.signal,
                            disableTableExtraction,
                            onProgress: (p) => {
                                setImportProgress({
                                    fileName: file.name,
                                    currentPage: p.page,
                                    totalPages: p.total,
                                    percent: p.percent,
                                });
                            },
                        });
                    } else {
                        const extractResult = await pdfWorkerBridge.extractText(arrayBuffer, {
                            signal: abortController.signal,
                            disableTableExtraction,
                            onProgress: (p) => {
                                setImportProgress({
                                    fileName: file.name,
                                    ...p,
                                });
                            },
                        });
                        textContent = extractResult.text;
                    }
                } else {
                    // MD / TXT parsed directly client-side as UTF-8
                    textContent = await parseFileContent(file);
                }

                if (abortController.signal.aborted) {
                    throw new DOMException('Import cancelled', 'AbortError');
                }

                if (!textContent || !textContent.trim()) {
                    throw new Error(`الملف ${file.name} لا يحتوي على أي نصوص قابلة للاستخراج`);
                }

                let result;
                if (importToVault) {
                    const masterKey = sessionKeyStore.getMasterKeyRaw();
                    if (!masterKey) throw new Error("Vault master key not available in memory");

                    const effectiveUid = await resolveEffectiveUserId();
                    const fileId = crypto.randomUUID();
                    const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
                    const aad = `vault:file:${effectiveUid}:${fileId}`;

                    const encResult = await cryptoWorkerBridge.encryptAESGCM(
                        masterKey,
                        textContent,
                        ivBytes,
                        aad
                    );

                    const metadata = {
                        version: 1,
                        algorithm: "AES-GCM-256",
                        keyId: "master-v1",
                        salt: "",
                        iv: encResult.ivBase64,
                        kdfIterations: 600000,
                    };

                    // Optimistic offline write to local IndexedDB
                    try {
                        if (effectiveUid) {
                            await indexedDBManager.init(effectiveUid);
                            await indexedDBManager.saveFile({
                                id: fileId,
                                title: file.name.replace(/\.(pdf|md|txt)$/i, '').slice(0, 500) || "Imported Document",
                                content: encResult.ciphertextBase64,
                                parentFolderId: targetFolderId,
                                isFolder: false,
                                isEncrypted: true,
                                encryptionMetadata: metadata,
                                version: 1,
                                etag: "",
                                lastModified: Date.now(),
                                lastSyncedAt: Date.now(),
                                isDirty: false,
                            });
                        }
                    } catch (dbErr) {
                        console.warn("[Sidebar] IndexedDB cache write deferred:", dbErr);
                    }

                    result = await importFile(
                        file.name,
                        encResult.ciphertextBase64,
                        fileType,
                        targetFolderId,
                        {
                            isEncrypted: true,
                            encryptionMetadata: metadata,
                            fileId,
                        }
                    );
                } else {
                    result = await importFile(
                        file.name,
                        textContent,
                        fileType,
                        targetFolderId
                    );
                }

                if (result.success) {
                    toast({
                        title: importToVault ? "تم استيراد المستند مشفراً للخزنة" : "File Imported",
                        description: `${file.name} imported successfully${result.data?.wordCount ? ` (${result.data.wordCount} words)` : ''}`,
                    });
                } else {
                    toast({
                        title: "Import Failed",
                        description: result.error || "Unknown error",
                        variant: "destructive",
                    });
                }
            } catch (error: unknown) {
                const isAborted = (error as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
                if (isAborted) {
                    toast({
                        title: "تم الإلغاء",
                        description: `تم إلغاء استيراد ${file.name}`,
                    });
                    break;
                } else {
                    const message = error instanceof Error ? error.message : `Failed to import ${file.name}`;
                    toast({
                        title: "Import Error",
                        description: message,
                        variant: "destructive",
                    });
                }
            } finally {
                setImportProgress(null);
                abortControllerRef.current = null;
            }
        }

        setIsImporting(false);
        loadFiles();
    }

    function handleDragEnter(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    }

    function handleDragLeave(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(false);
        }
    }

    function handleDragOver(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        if (e.dataTransfer.types.includes('Files')) {
            e.dataTransfer.dropEffect = 'copy';
        }
    }

    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            void handleFileImport(files, null);
        }
    }

    function handleImportClick(targetFolderId: string | null = null) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.pdf,.md,.txt';
        input.onchange = (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) {
                void handleFileImport(files, targetFolderId);
            }
        };
        input.click();
    }

    return (
        <aside
            className={cn(
                "bg-zinc-900/50 border-r border-zinc-800/50 flex flex-col transition-all duration-300 relative",
                collapsed ? "w-14" : "w-64",
                isDragOver && !collapsed && "border-indigo-500 bg-indigo-500/5"
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
        >
            {/* Header */}
            <div className="h-14 border-b border-zinc-800/50 flex items-center justify-between px-3">
                {!collapsed && (
                    <span className="text-sm font-medium text-zinc-400">Files</span>
                )}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setCollapsed(!collapsed)}
                    className="ml-auto"
                >
                    {collapsed ? (
                        <ChevronRight className="w-4 h-4" />
                    ) : (
                        <ChevronLeft className="w-4 h-4" />
                    )}
                </Button>
            </div>

            {/* Actions */}
            {!collapsed && (
                <div className="p-2 border-b border-zinc-800/50 flex gap-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="flex-1 justify-start gap-2"
                        onClick={handleCreateFile}
                    >
                        <Plus className="w-4 h-4" />
                        New File
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={handleCreateFolder}
                    >
                        <FolderPlus className="w-4 h-4" />
                    </Button>
                </div>
            )}

            {/* File List */}
            <div
                className="flex-1 overflow-auto p-2 custom-scrollbar"
                onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('text/plain') && !e.dataTransfer.types.includes('Files')) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = 'move';
                    }
                }}
                onDrop={(e) => {
                    if (e.dataTransfer.types.includes('text/plain') && !e.dataTransfer.types.includes('Files')) {
                        e.preventDefault();
                        e.stopPropagation();

                        const fileId = e.dataTransfer.getData('text/plain');
                        if (fileId) {
                            handleMoveFile(fileId, null);
                        }
                    }
                }}
            >
                {loading ? (
                    <div className="text-center text-zinc-500 text-sm py-4">
                        Loading...
                    </div>
                ) : files.length === 0 ? (
                    <div className="text-center text-zinc-500 text-sm py-4">
                        {collapsed ? "" : "No files yet"}
                    </div>
                ) : (
                    <ul className="space-y-1">
                        {files.map((file) => (
                            <FileTreeItem
                                key={file.id}
                                file={file}
                                userId={userId || file.userId}
                                level={0}
                                onMove={handleMoveFile}
                                onRefresh={loadFiles}
                                onImportFiles={(droppedFiles, folderId) => void handleFileImport(droppedFiles, folderId)}
                            />
                        ))}
                    </ul>
                )}
            </div>

            {/* Trash Section */}
            {!collapsed && (
                <div className="border-t border-zinc-800/50">
                    <button
                        onClick={() => {
                            setShowTrash(!showTrash);
                            if (!showTrash) void loadDeletedFiles();
                        }}
                        className="w-full px-3 py-2 flex items-center justify-between text-sm text-zinc-400 hover:text-zinc-50 hover:bg-zinc-800/50 transition-colors"
                    >
                        <span className="flex items-center gap-2">
                            <Trash2 className="w-4 h-4" />
                            Deleted Files
                        </span>
                        <span className="flex items-center gap-2">
                            {deletedFiles.length > 0 && (
                                <span className="bg-zinc-800 text-zinc-500 text-xs px-1.5 py-0.5 rounded">
                                    {deletedFiles.length}
                                </span>
                            )}
                            <ChevronRight
                                className="w-3 h-3 transition-transform"
                                style={{ transform: showTrash ? "rotate(90deg)" : "rotate(0deg)" }}
                            />
                        </span>
                    </button>

                    {showTrash && (
                        <div className="px-2 pb-2 pt-1 custom-scrollbar overflow-y-auto max-h-40">
                            {deletedFiles.length === 0 ? (
                                <div className="text-center text-zinc-600 text-xs py-3">
                                    No deleted files
                                </div>
                            ) : (
                                <ul className="space-y-1">
                                    {deletedFiles.map((file) => (
                                        <TrashFileRow
                                            key={file.id}
                                            file={file}
                                            userId={userId || file.userId}
                                            onRefresh={() => {
                                                void loadFiles();
                                                void loadDeletedFiles();
                                            }}
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Drag Overlay */}
            {isDragOver && !collapsed && (
                <div className="absolute inset-0 bg-indigo-500/10 border-2 border-dashed border-indigo-500 rounded-lg flex items-center justify-center pointer-events-none z-10">
                    <div className="text-center">
                        <Upload className="w-12 h-12 text-indigo-500 mx-auto mb-2" />
                        <p className="text-indigo-400 font-medium">Drop files here</p>
                        <p className="text-zinc-500 text-xs mt-1">PDF, MD, TXT only</p>
                    </div>
                </div>
            )}

            {/* Footer Actions: Security & Import */}
            {!collapsed && (
                <div className="p-2 border-t border-zinc-800/50 mt-auto space-y-2">
                    {/* Active Extraction Progress Card */}
                    {importProgress && (
                        <div className="p-2.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-xs space-y-1.5 animate-in fade-in">
                            <div className="flex items-center justify-between">
                                <span className="font-medium text-indigo-300 truncate max-w-[170px]">
                                    {importProgress.fileName}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => abortControllerRef.current?.abort()}
                                    className="text-zinc-400 hover:text-red-400 p-0.5 rounded transition-colors"
                                    title="إلغاء المعالجة"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                            <div className="flex justify-between text-[11px] text-zinc-400">
                                <span>صفحة {importProgress.currentPage} من {importProgress.totalPages}</span>
                                <span>{importProgress.percent}%</span>
                            </div>
                            <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                <div
                                    className="bg-indigo-500 h-1.5 rounded-full transition-all duration-200"
                                    style={{ width: `${importProgress.percent}%` }}
                                />
                            </div>
                        </div>
                    )}

                    <Link href="/account" className="block w-full">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="w-full gap-2 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50 justify-start text-xs font-normal"
                        >
                            <ShieldCheck className="w-4 h-4 text-indigo-400" />
                            <span>أمان الخزنة والأجهزة</span>
                        </Button>
                    </Link>

                    {/* Encrypted Vault Import Toggle */}
                    <div className="flex items-center justify-between px-1 text-xs">
                        <label className="flex items-center gap-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200">
                            <input
                                type="checkbox"
                                checked={importToVault}
                                onChange={(e) => setImportToVault(e.target.checked)}
                                className="rounded border-zinc-700 bg-zinc-900 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                            />
                            <span>استيراد مشفر للخزنة</span>
                        </label>
                        {importToVault && (
                            <Lock className="w-3.5 h-3.5 text-amber-400" />
                        )}
                    </div>

                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2 border-zinc-700 hover:border-indigo-500 hover:bg-indigo-500/10 hover:text-indigo-400 text-xs"
                        onClick={() => handleImportClick(null)}
                        disabled={isImporting}
                    >
                        <Upload className="w-4 h-4" />
                        {isImporting ? "جاري الاستيراد..." : "Import Files"}
                    </Button>
                </div>
            )}

            {/* Unlock Vault Modal if needed during encrypted import */}
            <VaultUnlockModal
                isOpen={showUnlockVault}
                onClose={() => setShowUnlockVault(false)}
                userId={effectiveUserId}
                onUnlocked={() => {
                    setShowUnlockVault(false);
                    toast({
                        title: "تم فتح الخزنة بنجاح",
                        description: "يمكنك الآن استيراد الملفات مباشرة إلى الخزنة المشفرة",
                    });
                }}
            />

            {/* PDF Extraction Mode Dialog (appears only when OCR is installed) */}
            <PdfImportModeDialog
                isOpen={Boolean(pendingPdfImport)}
                fileName={pendingPdfImport?.pdfFileName || ""}
                onClose={() => setPendingPdfImport(null)}
                onConfirm={(mode) => {
                    if (pendingPdfImport) {
                        const { files, targetFolderId } = pendingPdfImport;
                        setPendingPdfImport(null);
                        void executeFileImport(files, targetFolderId, mode);
                    }
                }}
            />

            {/* PDF Corrupted Font Warning Dialog (universal detection of unmapped PUA/fragmented fonts) */}
            <PdfCorruptedFontDialog
                isOpen={Boolean(corruptedFontNotice)}
                fileName={corruptedFontNotice?.file.name || ""}
                isOcrInstalled={Boolean(corruptedFontNotice?.isOcrInstalled)}
                onRunOcr={() => {
                    if (corruptedFontNotice) {
                        const { file, targetFolderId, remainingFiles } = corruptedFontNotice;
                        setCorruptedFontNotice(null);
                        void executeFileImport([file, ...remainingFiles], targetFolderId, 'ocr', true);
                    }
                }}
                onContinueAnyway={() => {
                    if (corruptedFontNotice) {
                        const { file, targetFolderId, remainingFiles } = corruptedFontNotice;
                        setCorruptedFontNotice(null);
                        void executeFileImport([file, ...remainingFiles], targetFolderId, 'fast', true);
                    }
                }}
                onClose={() => {
                    setCorruptedFontNotice(null);
                    setIsImporting(false);
                    setImportProgress(null);
                }}
            />
        </aside>
    );
}

/**
 * Row for a soft-deleted (tombstoned) item inside the Trash section.
 */
function TrashFileRow({
    file,
    userId,
    onRefresh,
}: {
    file: FileItem;
    userId?: string;
    onRefresh: () => void;
}) {
    const [showContextMenu, setShowContextMenu] = useState(false);

    return (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-zinc-500 hover:text-zinc-400 hover:bg-zinc-800/50 transition-colors group">
            {file.isFolder ? (
                <Folder className="w-4 h-4 text-amber-500/40 shrink-0" />
            ) : (
                <FileText className="w-4 h-4 text-zinc-600 shrink-0" />
            )}

            <span className="truncate flex-1 line-through decoration-zinc-700">
                {file.title}
            </span>

            {file.deletedAt && (
                <span className="hidden sm:inline text-xs text-zinc-600">
                    {formatDate(file.deletedAt)}
                </span>
            )}

            <div className="relative">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-0 group-hover:opacity-100 h-6 w-6"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setShowContextMenu(!showContextMenu);
                    }}
                >
                    <MoreHorizontal className="w-3 h-3" />
                </Button>

                <FileContextMenu
                    isOpen={showContextMenu}
                    onClose={() => setShowContextMenu(false)}
                    fileId={file.id}
                    fileName={file.title}
                    isFolder={file.isFolder}
                    userId={userId || file.userId}
                    isDeleted
                    onRefresh={onRefresh}
                />
            </div>
        </div>
    );
}

function formatDate(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - new Date(date).getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d left`;
    return "30d+";
}
