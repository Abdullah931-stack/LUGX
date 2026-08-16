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
} from "lucide-react";
import { getUserFiles, createFile, moveFile } from "@/server/actions/file-ops";
import { importFile } from "@/server/actions/import-file";
import { validateFile } from "@/lib/parsers/file-validator";
import { parseFileContent } from "@/lib/parsers/text-parser";
import { useToast } from "@/hooks/use-toast";
import { FileTreeItem } from "@/components/files/file-tree-item";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
    updatedAt: Date;
}

export function Sidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const [files, setFiles] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [isDragOver, setIsDragOver] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
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
