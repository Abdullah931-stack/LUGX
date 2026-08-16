"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
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
} from "lucide-react";
import { getUserFiles, getDeletedFiles, createFile, moveFile } from "@/server/actions/file-ops";
import { importFile } from "@/server/actions/import-file";
import { validateFile } from "@/lib/parsers/file-validator";
import { parseFileContent } from "@/lib/parsers/text-parser";
import { useToast } from "@/hooks/use-toast";
import { FileTreeItem } from "@/components/files/file-tree-item";
import { FileContextMenu } from "@/components/files/file-context-menu";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
    updatedAt: Date;
    deletedAt: Date | null;
}

export function Sidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const [files, setFiles] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isDragOver, setIsDragOver] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [deletedFiles, setDeletedFiles] = useState<FileItem[]>([]);
    const [showTrash, setShowTrash] = useState(false);
    const { toast } = useToast();

    useEffect(() => {
        loadFiles();
    }, []);

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

    // Load tombstoned (soft-deleted) items for the Trash view. These rows
    // never reach the normal tree (server filters deletedAt IS NULL), so
    // they are listed here as a flat, collapsible section.
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
        } catch (error) {
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

    async function handleFileImport(fileList: FileList) {
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

        setIsImporting(true);

        // Process each valid file
        for (const file of validFiles) {
            try {
                const fileType = file.name.toLowerCase().endsWith('.pdf')
                    ? 'pdf'
                    : file.name.toLowerCase().endsWith('.md')
                        ? 'md'
                        : 'txt';

                let fileContent: string;

                if (fileType === 'pdf') {
                    // Convert to base64 for server processing
                    const buffer = await file.arrayBuffer();
                    fileContent = Buffer.from(buffer).toString('base64');
                } else {
                    // Parse MD/TXT client-side then convert to base64
                    const textContent = await parseFileContent(file);

                    // Ensure UTF-8 encoding preserves newlines and formatting
                    fileContent = Buffer.from(textContent, 'utf-8').toString('base64');

                    // Debug: verify content has newlines
                    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
                    console.log('[File Import] Newlines preserved:', decoded.includes('\n'));
                }

                // Import file via server action
                const result = await importFile(
                    file.name,
                    fileContent,
                    fileType,
                    null // No parent folder for now
                );

                if (result.success) {
                    toast({
                        title: "File Imported",
                        description: `${file.name} imported successfully (${result.data?.wordCount} words)`,
                    });
                } else {
                    toast({
                        title: "Import Failed",
                        description: result.error || "Unknown error",
                        variant: "destructive",
                    });
                }
            } catch (error) {
                toast({
                    title: "Import Error",
                    description: `Failed to import ${file.name}`,
                    variant: "destructive",
                });
            }
        }

        setIsImporting(false);
        loadFiles(); // Refresh file list
    }

    function handleDragEnter(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        // Only show overlay if dragging actual files (not internal items)
        // Internal drags have 'text/plain' type, external have 'Files'
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(true);
        }
    }

    function handleDragLeave(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        // Only hide if we were showing it for external files
        if (e.dataTransfer.types.includes('Files')) {
            setIsDragOver(false);
        }
    }

    function handleDragOver(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();

        // Only allow drop if it's external files
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
            handleFileImport(files);
        }
    }

    function handleImportClick() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.pdf,.md,.txt';
        input.onchange = (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (files) {
                handleFileImport(files);
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
                    // Allow dropping in root area (between files, not on them)
                    // Check if drag contains internal file ID (text/plain)
                    if (e.dataTransfer.types.includes('text/plain') && !e.dataTransfer.types.includes('Files')) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = 'move';
                    }
                }}
                onDrop={(e) => {
                    // Handle drop to root level
                    if (e.dataTransfer.types.includes('text/plain') && !e.dataTransfer.types.includes('Files')) {
                        e.preventDefault();
                        e.stopPropagation();

                        const fileId = e.dataTransfer.getData('text/plain');
                        if (fileId) {
                            // Move to root (null parent)
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
                                level={0}
                                onMove={handleMoveFile}
                                onRefresh={loadFiles}
                            />
                        ))}
                    </ul>
                )}
            </div>

            {/* Trash Section (soft-deleted files awaiting restoration or purge) */}
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

            {/* Import Button */}
            {!collapsed && (
                <div className="p-2 border-t border-zinc-800/50 mt-auto">
                    <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-2 border-zinc-700 hover:border-indigo-500 hover:bg-indigo-500/10 hover:text-indigo-400"
                        onClick={handleImportClick}
                        disabled={isImporting}
                    >
                        <Upload className="w-4 h-4" />
                        {isImporting ? "Importing..." : "Import Files"}
                    </Button>
                </div>
            )}
        </aside>
    );
}

/**
 * Row for a soft-deleted (tombstoned) item inside the Trash section.
 * Follows the same visual language as FileTreeItem but with muted
 * styling, a strike-through title and a strikethrough date hint.
 * The context menu is shown with isDeleted so that only "Restore"
 * applies (rename/copy/move/delete are disabled for tombstones).
 */
function TrashFileRow({
    file,
    onRefresh,
}: {
    file: FileItem;
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
