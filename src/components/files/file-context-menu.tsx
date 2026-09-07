"use client";

import { useState } from "react";
import { Trash2, Edit3, Copy, FolderInput, RotateCcw, Lock, Unlock, Loader2 } from "lucide-react";
import { deleteFile, restoreFile, renameFile, copyFile, moveFile, getFile, toggleFileEncryption } from "@/server/actions/file-ops";
import { getUserVaultProfile } from "@/server/actions/vault-actions";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from "@/lib/sync/crypto-worker-bridge";
import { indexedDBManager } from "@/lib/sync/indexeddb";
import { FolderPickerModal } from "./folder-picker-modal";
import { CreateVaultModal, VaultUnlockModal } from "@/components/vault";
import { createClient } from "@/lib/supabase/client";
import { broadcastCrossTabEvent } from "@/lib/sync/cross-tab-sync";

interface FileContextMenuProps {
    isOpen: boolean;
    onClose: () => void;
    fileId: string;
    fileName: string;
    isFolder: boolean;
    isEncrypted?: boolean;
    userId?: string;
    /** True when the item is a tombstone (deletedAt != null). */
    isDeleted?: boolean;
    onRefresh?: () => void;
}

/**
 * Context menu for file/folder operations
 * Displays options: Rename, Delete, Copy, Move, and Encrypt/Decrypt File
 */
export function FileContextMenu({
    isOpen,
    onClose,
    fileId,
    fileName,
    isFolder,
    isEncrypted = false,
    userId = "",
    isDeleted = false,
    onRefresh,
}: FileContextMenuProps) {
    const [isRenaming, setIsRenaming] = useState(false);
    const [newName, setNewName] = useState(fileName);
    const [showCopyPicker, setShowCopyPicker] = useState(false);
    const [showMovePicker, setShowMovePicker] = useState(false);

    // Vault modal states
    const [showCreateVault, setShowCreateVault] = useState(false);
    const [showUnlockVault, setShowUnlockVault] = useState(false);
    const [isTransforming, setIsTransforming] = useState(false);
    const [resolvedUid, setResolvedUid] = useState<string>(userId || "");

    /**
     * Resolves the authenticated user ID reliably.
     * Uses passed prop, cached state, or falls back to browser Supabase auth session.
     */
    async function resolveEffectiveUserId(): Promise<string> {
        if (resolvedUid && resolvedUid.trim()) return resolvedUid.trim();
        if (userId && userId.trim()) {
            setResolvedUid(userId.trim());
            return userId.trim();
        }
        try {
            const supabase = createClient();
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.id) {
                setResolvedUid(user.id);
                return user.id;
            }
        } catch (err) {
            console.warn("[FileContextMenu] Failed to resolve auth user session:", err);
        }
        return "";
    }

    // Restore a soft-deleted item (tombstone)
    async function handleRestore() {
        const result = await restoreFile(fileId);
        if (result.success) {
            onRefresh?.();
            onClose();
        } else {
            alert(result.error || "Failed to restore");
        }
    }

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
        if (!newName.trim() || newName === fileName) {
            setIsRenaming(false);
            return;
        }
        const result = await renameFile(fileId, newName.trim());
        if (result.success) {
            onRefresh?.();
            setIsRenaming(false);
            onClose();
        } else {
            alert(result.error || "Failed to rename");
        }
    }

    function cancelRename() {
        setNewName(fileName);
        setIsRenaming(false);
    }

    function handleCopyClick() {
        setShowCopyPicker(true);
    }

    async function handleCopyToFolder(targetFolderId: string | null) {
        if (isEncrypted) {
            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) {
                setShowUnlockVault(true);
                return;
            }

            setIsTransforming(true);
            try {
                const fileRes = await getFile(fileId);
                if (!fileRes.success || !fileRes.data || !fileRes.data.content) {
                    throw new Error("تعذر قراءة محتوى الملف المشفر");
                }

                const fileData = fileRes.data;
                const rawCiphertext = fileData.content;
                if (!rawCiphertext) {
                    throw new Error("محتوى الملف المشفر فارغ أو غير موجود");
                }

                // Check if file is large (> 100KB ciphertext) which demands prolonged cryptographic cycles
                const approximateSizeBytes = Math.round(rawCiphertext.length * 0.75);
                if (approximateSizeBytes > 100 * 1024) {
                    const proceed = window.confirm(
                        "تنبيه: هذا الملف المشفر ذو سعة كبيرة نسبياً، وقد تستغرق عملية فك التشفير وإعادة التشفير وقتاً إضافياً للمعالجة التشفيرية. هل ترغب في المتابعة؟"
                    );
                    if (!proceed) {
                        setIsTransforming(false);
                        return;
                    }
                }

                const meta = fileData.encryptionMetadata;
                if (!meta?.iv) {
                    throw new Error("ميتاداتا التشفير مفقودة في الملف الأصلي");
                }

                const uid = await resolveEffectiveUserId();
                const oldAad = `vault:file:${uid}:${fileId}`;
                const ivBytes = base64ToUint8Array(meta.iv);

                // 1. Decrypt original ciphertext with old AAD
                const decryptedPlaintext = await cryptoWorkerBridge.decryptAESGCM(
                    masterKey,
                    rawCiphertext,
                    ivBytes,
                    oldAad
                );
                wipeBuffer(ivBytes);

                // 2. Generate new file UUID and fresh IV
                const newFileId = crypto.randomUUID();
                const newIvBytes = await cryptoWorkerBridge.generateRandomBytes(12);
                const newAad = `vault:file:${uid}:${newFileId}`;

                // 3. Re-encrypt with new file UUID AAD
                const encResult = await cryptoWorkerBridge.encryptAESGCM(
                    masterKey,
                    decryptedPlaintext,
                    newIvBytes,
                    newAad
                );
                wipeBuffer(newIvBytes);

                const newMeta = {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: "",
                    iv: encResult.ivBase64,
                    kdfIterations: 600000,
                };

                // 4. Dispatch atomic copy with re-encrypted ciphertext and new metadata
                const result = await copyFile(fileId, targetFolderId, 0, {
                    newFileId,
                    content: encResult.ciphertextBase64,
                    encryptionMetadata: newMeta,
                });

                if (result.success) {
                    onRefresh?.();
                    onClose();
                } else {
                    alert(result.error || "فشل نسخ الملف المشفر");
                }
            } catch (err: any) {
                console.error("[FileContextMenu] Encrypted copy error:", err);
                alert("حدث خطأ أثناء نسخ الملف المشفر: " + (err.message || "خطأ غير معروف"));
            } finally {
                setIsTransforming(false);
            }
            return;
        }

        const result = await copyFile(fileId, targetFolderId);
        if (result.success) {
            onRefresh?.();
            onClose();
        } else {
            alert(result.error || "Failed to copy");
        }
    }

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

    // --- Dynamic File Conversion Engine (Offline-First) ---

    async function handleEncryptClick() {
        const effectiveUid = await resolveEffectiveUserId();
        if (effectiveUid) {
            await indexedDBManager.init(effectiveUid);
        }

        // 1. Check if user vault profile exists locally or remotely
        let profile = await indexedDBManager.getCachedVaultProfile(effectiveUid);
        if (!profile) {
            try {
                const res = await getUserVaultProfile();
                if (res.success && res.data) {
                    profile = res.data;
                    await indexedDBManager.saveCachedVaultProfile(res.data, effectiveUid);
                }
            } catch {
                // Offline fallback
            }
        }

        if (!profile) {
            setShowCreateVault(true);
            return;
        }

        // 2. Check if vault is unlocked
        if (!sessionKeyStore.hasMasterKey()) {
            setShowUnlockVault(true);
            return;
        }

        // 3. Vault is unlocked: perform encryption
        await executeFileEncryption();
    }

    async function executeFileEncryption() {
        setIsTransforming(true);
        let ivBytes: Uint8Array | null = null;

        try {
            const effectiveUid = await resolveEffectiveUserId();
            if (effectiveUid) {
                await indexedDBManager.init(effectiveUid);
            }

            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) throw new Error("Vault master key not found in volatile RAM");

            // Fetch current plaintext content from local IndexedDB or server
            const localFile = await indexedDBManager.getFile(fileId, effectiveUid);
            let contentToEncrypt = localFile?.content ?? "";

            if (!contentToEncrypt) {
                const serverRes = await getFile(fileId);
                if (serverRes.success && serverRes.data) {
                    contentToEncrypt = serverRes.data.content || "";
                }
            }

            ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
            const aad = `vault:file:${effectiveUid}:${fileId}`;
            const encResult = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                contentToEncrypt,
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

            // Sync to server if reachable
            let syncResult: any = null;
            try {
                syncResult = await toggleFileEncryption(fileId, true, encResult.ciphertextBase64, metadata);
            } catch (serverErr) {
                console.warn("[FileContextMenu] Cloud encryption sync deferred:", serverErr);
            }

            const targetVersion = (syncResult?.success && syncResult.version) ? syncResult.version : (localFile?.version || 1);
            const targetEtag = (syncResult?.success && syncResult.etag) ? syncResult.etag : (localFile?.etag || "");
            const isClean = !!(syncResult?.success);

            // Offline-First: Save to local IndexedDB as encrypted ciphertext (NEVER plaintext)
            if (localFile) {
                await indexedDBManager.saveFile({
                    ...localFile,
                    content: encResult.ciphertextBase64,
                    isEncrypted: true,
                    encryptionMetadata: metadata,
                    isDirty: !isClean,
                    version: targetVersion,
                    etag: targetEtag,
                    lastModified: Date.now(),
                    lastSyncedAt: isClean ? Date.now() : (localFile.lastSyncedAt || 0),
                }, effectiveUid);
            } else {
                await indexedDBManager.saveFile({
                    id: fileId,
                    content: encResult.ciphertextBase64,
                    title: fileName,
                    isFolder: false,
                    parentFolderId: null,
                    version: targetVersion,
                    etag: targetEtag,
                    isEncrypted: true,
                    encryptionMetadata: metadata,
                    isDirty: !isClean,
                    lastModified: Date.now(),
                    lastSyncedAt: isClean ? Date.now() : 0,
                }, effectiveUid);
            }

            // Clean up any pending unsynced operations in IDB to prevent SyncManager retry loops
            if (isClean) {
                const ops = await indexedDBManager.getOperations(fileId);
                for (const op of ops) {
                    if (!op.synced) {
                        await indexedDBManager.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            }

            // Broadcast encryption event to active editor tab
            broadcastCrossTabEvent({
                type: "file_encrypted",
                fileId,
                version: targetVersion,
                etag: targetEtag || undefined,
                metadata,
            });

            onRefresh?.();
            onClose();
        } catch (err: any) {
            console.error("[FileContextMenu] Encryption error:", err);
            alert("فشل تشفير الملف: " + (err.message || "خطأ غير معروف"));
        } finally {
            if (ivBytes) wipeBuffer(ivBytes);
            setIsTransforming(false);
        }
    }

    async function handleDecryptClick() {
        const effectiveUid = await resolveEffectiveUserId();
        if (effectiveUid) {
            await indexedDBManager.init(effectiveUid);
        }

        if (!sessionKeyStore.hasMasterKey()) {
            setShowUnlockVault(true);
            return;
        }

        await executeFileDecryption();
    }

    async function executeFileDecryption() {
        setIsTransforming(true);

        try {
            const effectiveUid = await resolveEffectiveUserId();
            if (effectiveUid) {
                await indexedDBManager.init(effectiveUid);
            }

            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) throw new Error("Vault master key not found in memory");

            const localFile = await indexedDBManager.getFile(fileId, effectiveUid);
            let rawContent = localFile?.content ?? "";
            let metadata = localFile?.encryptionMetadata;

            if (!rawContent || !metadata) {
                const serverRes = await getFile(fileId);
                if (serverRes.success && serverRes.data) {
                    rawContent = serverRes.data.content || "";
                    metadata = serverRes.data.encryptionMetadata as any;
                }
            }

            let decryptedContent = rawContent;

            // Decrypt ciphertext if metadata provides IV
            if (metadata?.iv && rawContent) {
                try {
                    const ivBytes = base64ToUint8Array(metadata.iv);
                    const aad = `vault:file:${effectiveUid}:${fileId}`;
                    decryptedContent = await cryptoWorkerBridge.decryptAESGCM(
                        masterKey,
                        rawContent,
                        ivBytes,
                        aad
                    );
                } catch {
                    // Content may already be plaintext from local IndexedDB
                }
            }

            // Sync to server if reachable
            let syncResult: any = null;
            try {
                syncResult = await toggleFileEncryption(fileId, false, decryptedContent, null);
            } catch (serverErr) {
                console.warn("[FileContextMenu] Cloud decryption sync deferred:", serverErr);
            }

            const targetVersion = (syncResult?.success && syncResult.version) ? syncResult.version : (localFile?.version || 1);
            const targetEtag = (syncResult?.success && syncResult.etag) ? syncResult.etag : (localFile?.etag || "");
            const isClean = !!(syncResult?.success);

            // Offline-First: Update local IndexedDB to unencrypted
            if (localFile) {
                await indexedDBManager.saveFile({
                    ...localFile,
                    content: decryptedContent,
                    isEncrypted: false,
                    encryptionMetadata: null,
                    isDirty: !isClean,
                    version: targetVersion,
                    etag: targetEtag,
                    lastModified: Date.now(),
                    lastSyncedAt: isClean ? Date.now() : (localFile.lastSyncedAt || 0),
                }, effectiveUid);
            }

            // Clean up any pending unsynced operations in IDB to prevent SyncManager retry loops
            if (isClean) {
                const ops = await indexedDBManager.getOperations(fileId);
                for (const op of ops) {
                    if (!op.synced) {
                        await indexedDBManager.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            }

            // Broadcast decryption event to active editor tab
            broadcastCrossTabEvent({
                type: "file_decrypted",
                fileId,
                version: targetVersion,
                etag: targetEtag || undefined,
                metadata: null,
            });

            onRefresh?.();
            onClose();
        } catch (err: any) {
            console.error("[FileContextMenu] Decryption error:", err);
            alert("فشل فك تشفير الملف: " + (err.message || "خطأ غير معروف"));
        } finally {
            setIsTransforming(false);
        }
    }

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop to close menu */}
            <div className="fixed inset-0 z-10" onClick={onClose} />

            {/* Dropdown Menu */}
            <div className="absolute right-0 top-full mt-1 z-20 w-48 bg-zinc-900 border border-zinc-800 rounded-md shadow-lg overflow-hidden text-right" dir="rtl">
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
                        className="w-full px-3 py-2 text-right text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                    >
                        <Edit3 className="w-4 h-4" />
                        <span>إعادة التسمية</span>
                    </button>
                )}

                {/* Encrypt / Decrypt Toggle (only for regular non-folder files) */}
                {!isFolder && !isDeleted && (
                    <>
                        {isEncrypted ? (
                            <button
                                onClick={handleDecryptClick}
                                disabled={isTransforming}
                                className="w-full px-3 py-2 text-right text-sm text-indigo-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                            >
                                {isTransforming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
                                <span>فك تشفير الملف</span>
                            </button>
                        ) : (
                            <button
                                onClick={handleEncryptClick}
                                disabled={isTransforming}
                                className="w-full px-3 py-2 text-right text-sm text-amber-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                            >
                                {isTransforming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                                <span>تشفير الملف 🔒</span>
                            </button>
                        )}
                    </>
                )}

                {/* Restore Option (tombstoned items only) */}
                {isDeleted && (
                    <button
                        onClick={handleRestore}
                        className="w-full px-3 py-2 text-right text-sm text-indigo-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                    >
                        <RotateCcw className="w-4 h-4" />
                        <span>استعادة</span>
                    </button>
                )}

                {/* Delete Option (only meaningful for live items) */}
                {!isDeleted && (
                    <button
                        onClick={handleDelete}
                        className="w-full px-3 py-2 text-right text-sm text-red-400 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                    >
                        <Trash2 className="w-4 h-4" />
                        <span>حذف</span>
                    </button>
                )}

                {/* Copy & Move */}
                {!isDeleted && (
                    <>
                        <button
                            onClick={handleCopyClick}
                            className="w-full px-3 py-2 text-right text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                            <Copy className="w-4 h-4" />
                            <span>نسخ</span>
                        </button>

                        <button
                            onClick={handleMoveClick}
                            className="w-full px-3 py-2 text-right text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                            <FolderInput className="w-4 h-4" />
                            <span>نقل</span>
                        </button>
                    </>
                )}
            </div>

            {/* Folder Pickers */}
            <FolderPickerModal
                isOpen={showCopyPicker}
                onClose={() => setShowCopyPicker(false)}
                onSelect={handleCopyToFolder}
                currentFileId={fileId}
                title={`نسخ "${fileName}" إلى...`}
            />

            <FolderPickerModal
                isOpen={showMovePicker}
                onClose={() => setShowMovePicker(false)}
                onSelect={handleMoveToFolder}
                currentFileId={fileId}
                title={`نقل "${fileName}" إلى...`}
            />

            {/* Vault Modals */}
            <CreateVaultModal
                isOpen={showCreateVault}
                onClose={() => setShowCreateVault(false)}
                onSuccess={() => executeFileEncryption()}
                userId={resolvedUid || userId}
            />

            <VaultUnlockModal
                isOpen={showUnlockVault}
                onClose={() => setShowUnlockVault(false)}
                onUnlocked={() => {
                    if (isEncrypted) {
                        executeFileDecryption();
                    } else {
                        executeFileEncryption();
                    }
                }}
                userId={resolvedUid || userId}
            />
        </>
    );
}
