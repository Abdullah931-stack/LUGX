"use client";

import { useState } from "react";
import { Trash2, Edit3, Copy, FolderInput } from "lucide-react";
import { deleteFile, renameFile, copyFile, moveFile } from "@/server/actions/file-ops";
import { useRouter } from "next/navigation";
import { FolderPickerModal } from "./folder-picker-modal";

interface FileContextMenuProps {
    isOpen: boolean;
    onClose: () => void;
    fileId: string;
    fileName: string;
    isFolder: boolean;
    onRefresh?: () => void;
}

/**
 * Context menu for file/folder operations
 * Displays options: Rename, Delete (Copy & Move disabled for now)
 */
export function FileContextMenu({
    isOpen,
    onClose,
    fileId,
    fileName,
    isFolder,
    onRefresh,
}: FileContextMenuProps) {
    const router = useRouter();
    const [isRenaming, setIsRenaming] = useState(false);
    const [newName, setNewName] = useState(fileName);
    const [showCopyPicker, setShowCopyPicker] = useState(false);
    const [showMovePicker, setShowMovePicker] = useState(false);

    // Handle delete operation
    async function handleDelete() {
        const confirmMessage = isFolder
            ? "Are you sure you want to delete this folder and all its contents?"
            : "Are you sure you want to delete this file?";

        if (confirm(confirmMessage)) {
            const result = await deleteFile(fileId);
            if (result.success) {
                onRefresh?.();
                onClose();
            } else {
                alert(result.error || "Failed to delete");
            }
        }
    }

    // Handle rename operation
    async function handleRename() {
        setIsRenaming(true);
    }

    // Submit rename
    async function submitRename() {
        if (newName.trim() && newName !== fileName) {
            const result = await renameFile(fileId, newName.trim());
            if (result.success) {
                onRefresh?.();
                setIsRenaming(false);
                onClose();
            } else {
                alert(result.error || "Failed to rename");
            }
        } else {
            setIsRenaming(false);
        }
    }

    // Cancel rename
    function cancelRename() {
        setNewName(fileName);
        setIsRenaming(false);
    }

    // Handle copy operation
    function handleCopyClick() {
        setShowCopyPicker(true);
    }

    async function handleCopyToFolder(targetFolderId: string | null) {
        const result = await copyFile(fileId, targetFolderId);
        if (result.success) {
            onRefresh?.();
            onClose();
        } else {
            alert(result.error || "Failed to copy");
        }
    }

    // Handle move operation
    function handleMoveClick() {
        setShowMovePicker(true);
    }

    async function handleMoveToFolder(targetFolderId: string | null) {
        const result = await moveFile(fileId, targetFolderId);
        if (result.success) {
            onRefresh?.();
            onClose();
        } else {
            alert(result.error || "Failed to move");
        }
    }

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop to close menu */}
            <div
                className="fixed inset-0 z-10"
                onClick={onClose}
            />

            {/* Dropdown Menu */}
            <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-zinc-900 border border-zinc-800 rounded-md shadow-lg overflow-hidden">
                {/* Rename Option */}
                {isRenaming ? (
                    <div className="px-3 py-2">
                        <input
                            type="text"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") submitRename();
                                if (e.key === "Escape") cancelRename();
                            }}
                            onBlur={submitRename}
                            className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-700 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 text-zinc-200"
                            autoFocus
                        />
                    </div>
                ) : (
                    <button
                        onClick={handleRename}
                        className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
                    >
                        <Edit3 className="w-4 h-4" />
                        Rename
                    </button>
                )}

                {/* Delete Option */}
                <button
                    onClick={handleDelete}
                    className="w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
                >
                    <Trash2 className="w-4 h-4" />
                    Delete
                </button>

                {/* Copy Option - Now enabled */}
                <button
                    onClick={handleCopyClick}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
                >
                    <Copy className="w-4 h-4" />
                    Copy
                </button>

                {/* Move Option - Now enabled */}
                <button
                    onClick={handleMoveClick}
                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors"
                >
                    <FolderInput className="w-4 h-4" />
                    Move
                </button>
            </div>

            {/* Folder Pickers */}
            <FolderPickerModal
                isOpen={showCopyPicker}
                onClose={() => setShowCopyPicker(false)}
                onSelect={handleCopyToFolder}
                currentFileId={fileId}
                title={`Copy "${fileName}" to...`}
            />

            <FolderPickerModal
                isOpen={showMovePicker}
                onClose={() => setShowMovePicker(false)}
                onSelect={handleMoveToFolder}
                currentFileId={fileId}
                title={`Move "${fileName}" to...`}
            />
        </>
    );
}
