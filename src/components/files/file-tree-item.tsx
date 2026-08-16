"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ChevronRight, FileText, Folder, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileContextMenu } from "./file-context-menu";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
    updatedAt: Date;
    children?: FileItem[];
}

interface FileTreeItemProps {
    file: FileItem;
    level?: number;
    onMove?: (fileId: string, newParentId: string | null) => void;
    onRefresh?: () => void;
}

/**
 * Recursive File Tree Item Component
 * Supports nested folders with unlimited depth and drag & drop
 */
export function FileTreeItem({ file, level = 0, onMove, onRefresh }: FileTreeItemProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const [showContextMenu, setShowContextMenu] = useState(false);
    const hasChildren = file.isFolder && file.children && file.children.length > 0;

    function handleToggle(e: React.MouseEvent) {
        e.preventDefault();
        if (file.isFolder) {
            setIsExpanded(!isExpanded);
        }
    }

    // Drag start - set file ID in dataTransfer
    function handleDragStart(e: React.DragEvent) {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', file.id);
        e.dataTransfer.effectAllowed = 'move';
    }

    // Drag over - allow drop on folders only
    function handleDragOver(e: React.DragEvent) {
        if (!file.isFolder) return;

        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setIsDragOver(true);
    }

    // Drag leave
    function handleDragLeave(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
    }

    // Drop - move file into this folder
    function handleDrop(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);

        if (!file.isFolder) return;

        const draggedFileId = e.dataTransfer.getData('text/plain');

        // Don't allow dropping into itself
        if (draggedFileId === file.id) return;

        // TODO: Add check to prevent dropping parent into its child
        // (would require checking if target folder is descendant of dragged folder)

        // Call move handler
        if (onMove) {
            onMove(draggedFileId, file.id);
        }
    }

    return (
        <li>
            <div
                draggable
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-zinc-400 hover:text-zinc-50 hover:bg-zinc-800/50 transition-colors group",
                    isDragOver && file.isFolder && "bg-indigo-500/20 border-indigo-500 border"
                )}
                style={{ paddingLeft: `${level * 16 + 8}px` }}
            >
                {/* Expand/Collapse Arrow */}
                {file.isFolder && (
                    <button
                        onClick={handleToggle}
                        className="shrink-0 hover:bg-zinc-700/50 rounded p-0.5 transition-transform"
                        style={{
                            transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                        }}
                    >
                        <ChevronRight className="w-3 h-3" />
                    </button>
                )}

                {/* File/Folder Icon */}
                {file.isFolder ? (
                    <Folder className="w-4 h-4 text-amber-500/70 shrink-0" />
                ) : (
                    <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                )}

                {/* Title - clickable link */}
                <Link
                    href={file.isFolder ? `/workspace` : `/workspace/editor/${file.id}`}
                    className="truncate flex-1"
                >
                    {file.title}
                </Link>

                {/* Context Menu Button */}
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

                    {/* Context Menu */}
                    <FileContextMenu
                        isOpen={showContextMenu}
                        onClose={() => setShowContextMenu(false)}
                        fileId={file.id}
                        fileName={file.title}
                        isFolder={file.isFolder}
                        onRefresh={onRefresh}
                    />
                </div>
            </div>

            {/* Render Children (Nested Folders/Files) */}
            {file.isFolder && isExpanded && hasChildren && (
                <ul className="mt-1 space-y-1">
                    {file.children!.map((child) => (
                        <FileTreeItem key={child.id} file={child} level={level + 1} onMove={onMove} onRefresh={onRefresh} />
                    ))}
                </ul>
            )}
        </li>
    );
}
