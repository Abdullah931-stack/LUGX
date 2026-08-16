"use client";

import { useState, useEffect } from "react";
import { Folder } from "lucide-react";
import { getUserFiles } from "@/server/actions/file-ops";

interface FileItem {
    id: string;
    title: string;
    isFolder: boolean;
    parentFolderId: string | null;
}

interface FolderPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (folderId: string | null) => void;
    currentFileId?: string; // Prevent selecting the file itself or its children
    title: string; // "Copy to..." or "Move to..."
}

/**
 * Modal component for selecting a destination folder
 * Used for Copy and Move operations
 */
export function FolderPickerModal({
    isOpen,
    onClose,
    onSelect,
    currentFileId,
    title,
}: FolderPickerModalProps) {
    const [folders, setFolders] = useState<FileItem[]>([]);
    const [loading, setLoading] = useState(true);

    // Load folders when modal opens
    useEffect(() => {
        if (isOpen) {
            loadFolders();
        }
    }, [isOpen]);

    async function loadFolders() {
        setLoading(true);
        const result = await getUserFiles();
        if (result.success && result.data) {
            // Filter to only show folders, and exclude the current file
            const folderList = result.data.filter(
                (f) => f.isFolder && f.id !== currentFileId
            );
            setFolders(folderList);
        }
        setLoading(false);
    }

    function handleSelect(folderId: string | null) {
        onSelect(folderId);
        onClose();
    }

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/50 z-30"
                onClick={onClose}
            />

            {/* Modal */}
            <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg shadow-2xl w-full max-w-md">
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-zinc-800">
                        <h3 className="text-lg font-medium text-zinc-100">
                            {title}
                        </h3>
                    </div>

                    {/* Content */}
                    <div className="p-4 max-h-96 overflow-y-auto custom-scrollbar">
                        {loading ? (
                            <div className="text-center text-zinc-500 py-8">
                                Loading...
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {/* Root option */}
                                <button
                                    onClick={() => handleSelect(null)}
                                    className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 rounded flex items-center gap-2 transition-colors"
                                >
                                    <Folder className="w-4 h-4 text-amber-500/70" />
                                    Root (No folder)
                                </button>

                                {/* Folder list */}
                                {folders.map((folder) => (
                                    <button
                                        key={folder.id}
                                        onClick={() => handleSelect(folder.id)}
                                        className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 rounded flex items-center gap-2 transition-colors"
                                    >
                                        <Folder className="w-4 h-4 text-amber-500/70" />
                                        {folder.title}
                                    </button>
                                ))}

                                {folders.length === 0 && (
                                    <div className="text-center text-zinc-500 py-4 text-sm">
                                        No folders available. Create a folder first.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-3 border-t border-zinc-800 flex justify-end">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
