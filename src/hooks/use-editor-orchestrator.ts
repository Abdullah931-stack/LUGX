"use client";

/**
 * useEditorOrchestrator
 *
 * Centralized State & Write Controller for Standalone Markdown Editor (Phase 2)
 *
 * Enforces:
 * 1. Single authoritative write path (manual save, AI commit, conflict resolution, sync replay).
 * 2. Strict auto-save suspension invariants (never saves during streaming, reserving, committing, conflict, or stopped).
 * 3. Manual edit during streaming policy: instantly aborts AI generation, clears ghost preview, refunds quota, and preserves user edits.
 * 4. Offline-first loading and optimistic concurrency synchronization with ETag and version precondition guards.
 * 5. Navigation & unload protection when dirty or in-flight committing.
 */

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { getFile, updateFileContent, toggleFileEncryption, renameFile, deleteFile } from "@/server/actions/file-ops";
import { getUserVaultProfile } from "@/server/actions/vault-actions";
import type { FileEncryptionMetadata } from "@/types/storage-payload";
import { useSync, type UseSyncReturn } from "@/hooks/use-sync";
import { useEditorAutosave, type UseEditorAutosaveReturn } from "@/hooks/use-editor-autosave";
import { useAIStream } from "@/hooks/use-ai-stream";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { cryptoWorkerBridge, wipeBuffer } from "@/lib/sync/crypto-worker-bridge";
import { createClient } from "@/lib/supabase/client";
import { AIOperationType } from "@/lib/ai/stream-handler";
import { SyncConflict } from "@/lib/sync/idb-types";
import { ConflictResolutionPayload } from "@/components/sync/conflict-dialog";
import { broadcastCrossTabEvent, subscribeCrossTabSync } from "@/lib/sync/cross-tab-sync";
import {
    classifyRemoteUpdate,
    type LocalBaseline,
} from "@/lib/sync/reconciliation";
import { AIStreamStatus } from "@/lib/ai/stream-session";
import { normalizeMarkdownSource } from "@/lib/sync/etag-generator";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

export interface RemoteUpdatePayload {
    fileId: string;
    content: string;
    etag: string;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: FileEncryptionMetadata | null;
}

export type WriteStateType =
    | "idle"
    | "saving"
    | "ai_committing"
    | "resolving_conflict"
    | "syncing"
    | "stopped";

export interface UseEditorOrchestratorOptions {
    fileId: string;
    userId: string | null;
    /** EditorAdapter instance for standalone Markdown editor */
    editor?: EditorAdapter | null;
    /** Alias for editor */
    adapter?: EditorAdapter | null;
    onNavigate?: (path: string) => void;
}

export interface UseEditorOrchestratorReturn {
    // 1. Document State
    title: string;
    setTitle: (title: string) => void;
    handleTitleChange: (newTitle: string) => Promise<void>;
    handleDeleteFile: () => Promise<void>;

    // 2. Preview & AI State
    aiStatus: AIStreamStatus;
    previewText: string;
    isStreaming: boolean;
    isCommitting: boolean;
    isAIActive: boolean;
    aiError: string | null;
    isAIConflict: boolean;
    startAIOperation: (operation: AIOperationType) => Promise<void>;
    stopAIOperation: () => void;
    resetAI: () => void;
    /** Accept the completed AI preview: server-first commit + atomic local replace. */
    commitAIPreview: () => Promise<void>;
    /** Reject the completed AI preview: discard output, settle quota as consumed. */
    rejectAIPreview: () => void;
    /** Re-run the last AI operation with identical inputs after settling the current preview. */
    retryAIPreview: () => Promise<void>;

    // 3. Dirty & Save State
    isDirty: boolean;
    isSaving: boolean;
    lastSaved: Date | null;
    error: string | null;
    setError: (error: string | null) => void;

    // 4. Server Version State
    serverVersion: number;
    serverEtag: string | null;

    // 5. Conflict State
    activeConflict: SyncConflict | null;
    isConflictDialogOpen: boolean;
    setIsConflictDialogOpen: (open: boolean) => void;
    isResolvingConflict: boolean;
    handleResolveConflict: (resolution: ConflictResolutionPayload) => Promise<void>;

    // 6. Write Controller & Sync State
    writeState: WriteStateType;
    /** Exposed for tests and UI gating: whether an auto-save may fire right now. */
    canAutoSave: () => boolean;
    /** Hydration lifecycle of the initial load pipeline for this file. */
    hydration: "hydrating" | "ready" | "fatal" | "vault_locked";
    syncHook: ReturnType<typeof useSync>;
    handleEditorChange: (newContent: string) => void;

    // 7. Vault State
    isEncrypted: boolean;
    allowAIOnEncryptedFiles: boolean;
    isVaultLocked: boolean;
    isUnlockModalOpen: boolean;
    setIsUnlockModalOpen: (open: boolean) => void;
    handleVaultUnlocked: () => Promise<void>;
}

/**
 * Constructs authenticated additional data (AAD) binding for encrypted file operations.
 * Validates that both userId and fileId are non-empty strings (LUGX-056).
 */
export function buildFileAAD(userId: string | undefined | null, fileId: string): string {
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
        throw new Error(`[Orchestrator] Invalid userId for file AAD: userId must be a non-empty string, got "${userId}"`);
    }
    if (!fileId || typeof fileId !== "string" || fileId.trim() === "") {
        throw new Error(`[Orchestrator] Invalid fileId for file AAD: fileId must be a non-empty string, got "${fileId}"`);
    }
    return `vault:file:${userId.trim()}:${fileId.trim()}`;
}

export function useEditorOrchestrator({
    fileId,
    userId,
    editor,
    adapter,
    onNavigate,
}: UseEditorOrchestratorOptions): UseEditorOrchestratorReturn {
    const currentAdapter = adapter || editor || null;
    const adapterRef = useRef<EditorAdapter | null>(currentAdapter);
    useLayoutEffect(() => {
        adapterRef.current = currentAdapter;
    }, [currentAdapter]);

    // --- 1. Document State ---
    const [title, setTitle] = useState<string>("");

    // --- 2. Save & Error State ---
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [error, setError] = useState<string | null>(null);

    // --- 3. Conflict State ---
    const [activeConflict, setActiveConflict] = useState<SyncConflict | null>(null);
    const [isConflictDialogOpen, setIsConflictDialogOpen] = useState<boolean>(false);
    const [isResolvingConflict, setIsResolvingConflict] = useState<boolean>(false);

    // --- 4. Server Version State & Invariants ---
    const [serverVersion, setServerVersion] = useState<number>(1);
    const [serverEtag, setServerEtag] = useState<string | null>(null);

    const fileVersionRef = useRef<number>(1);
    const fileEtagRef = useRef<string | null>(null);
    const editorGenerationRef = useRef<number>(1);
    const editorContentRef = useRef<string>("");
    const isProgrammaticUpdateRef = useRef<boolean>(false);
    const pendingRemoteUpdateRef = useRef<RemoteUpdatePayload | null>(null);
    const activeConflictRef = useRef<SyncConflict | null>(null);
    const isResolvingConflictRef = useRef<boolean>(false);
    // Synchronous mirror of the dirty flag, read by the reconciliation policy at
    // decision time without waiting for a React state flush.
    const isDirtyRef = useRef<boolean>(false);
    const autosaveRef = useRef<UseEditorAutosaveReturn | null>(null);

    const markClean = useCallback(() => {
        isDirtyRef.current = false;
        autosaveRef.current?.markClean();
    }, []);

    const markDirty = useCallback(() => {
        isDirtyRef.current = true;
        autosaveRef.current?.markDirty();
    }, []);

    const cancelAutosave = useCallback(() => {
        autosaveRef.current?.cancelAutosave();
    }, []);
    const fileIdRef = useRef<string>(fileId);
    useEffect(() => {
        fileIdRef.current = fileId;
    }, [fileId]);

    // Keep editor adapter synchronized with editorContentRef if adapter mounts post-hydration
    useEffect(() => {
        if (currentAdapter && editorContentRef.current) {
            const currentDoc = currentAdapter.getValue();
            if (!currentDoc && editorContentRef.current) {
                isProgrammaticUpdateRef.current = true;
                try {
                    currentAdapter.setValue(editorContentRef.current);
                } finally {
                    isProgrammaticUpdateRef.current = false;
                }
            }
        }
    }, [currentAdapter]);
    // File-identity tracking guard: the initial load pipeline (IDB paint + background server fetch
    // + reconciliation) must run exactly once per mounted fileId.
    const loadedFileIdRef = useRef<string | null>(null);
    // HYDRATION LIFECYCLE (sync-before-write): the editor surface stays frozen
    // until the offline-first pipeline settled. 'fatal' means NOTHING could be
    // loaded from either side (server failure AND no local snapshot).
    const hydratedRef = useRef(false);
    const loadFailureRef = useRef(false);
    const [hydration, setHydration] = useState<"hydrating" | "ready" | "fatal" | "vault_locked">("hydrating");

    // --- 5. Vault Encryption State ---
    const [isEncrypted, setIsEncrypted] = useState<boolean>(false);
    const [allowAIOnEncryptedFiles, setAllowAIOnEncryptedFiles] = useState<boolean>(false);
    const [isVaultLocked, setIsVaultLocked] = useState<boolean>(false);
    const [isUnlockModalOpen, setIsUnlockModalOpen] = useState<boolean>(false);
    const isEncryptedRef = useRef<boolean>(false);
    const allowAIOnEncryptedFilesRef = useRef<boolean>(false);
    const fileEncryptionMetadataRef = useRef<FileEncryptionMetadata | null>(null);

    useEffect(() => {
        allowAIOnEncryptedFilesRef.current = allowAIOnEncryptedFiles;
    }, [allowAIOnEncryptedFiles]);

    useEffect(() => {
        async function fetchVaultProfile() {
            try {
                const res = await getUserVaultProfile();
                if (res.success && res.data) {
                    const allowed = !!res.data.allowAIOnEncryptedFiles;
                    setAllowAIOnEncryptedFiles(allowed);
                    allowAIOnEncryptedFilesRef.current = allowed;
                }
            } catch {
                // Ignore profile load errors in offline mode
            }
        }
        fetchVaultProfile();
    }, [userId]);
    const pendingEncryptedPayloadRef = useRef<{
        content: string;
        metadata: FileEncryptionMetadata | null;
        title: string;
        version: number;
        etag: string | null;
    } | null>(null);
    // SINGLE-FLIGHT guard: the initial pipeline must never fork into competing
    // getFile server-action cycles when render-scoped identities change.
    const pipelineRef = useRef<Promise<void> | null>(null);
    const markServerPersisted = useCallback((updatedAt?: string | Date | null) => {
        setLastSaved(updatedAt ? new Date(updatedAt) : new Date());
    }, []);

    const resolveEffectiveUserId = useCallback(async (): Promise<string> => {
        let resolved = userId;
        if (!resolved || resolved.trim() === "") {
            try {
                const supabase = createClient();
                const { data: { user } } = await supabase.auth.getUser();
                resolved = user?.id || "";
            } catch {
                resolved = "";
            }
        }
        if (!resolved || resolved.trim() === "") {
            throw new Error("[Orchestrator] User ID is missing or empty; cannot derive file AAD for encrypted operations.");
        }
        return resolved.trim();
    }, [userId]);

    // Keep active conflict ref synchronized
    useEffect(() => {
        activeConflictRef.current = activeConflict;
    }, [activeConflict]);

    // Keep resolving conflict ref synchronized
    useEffect(() => {
        isResolvingConflictRef.current = isResolvingConflict;
    }, [isResolvingConflict]);

    // --- Sync Hook Integration ---
    const syncHookRef = useRef<UseSyncReturn | null>(null);
    const pendingLocalSyncRef = useRef<boolean>(false);

    const handleSyncConflict = useCallback(
        async (conflict: SyncConflict): Promise<"local" | "server" | "merge"> => {
            const effectiveUid = await resolveEffectiveUserId();

            // Decrypt server version if encrypted and not yet decrypted
            if (isEncryptedRef.current || conflict.serverVersion.isEncrypted) {
                const serverInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: conflict.serverVersion.content,
                    isEncrypted: true,
                    encryptionMetadata: conflict.serverVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                    userId: effectiveUid,
                });
                if (serverInbound.status === "decrypted") {
                    conflict.serverVersion.content = serverInbound.content;
                }
            }

            // Decrypt base version if present and encrypted
            if (conflict.baseVersion?.content && (isEncryptedRef.current || conflict.baseVersion.isEncrypted)) {
                const baseInbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: conflict.baseVersion.content,
                    isEncrypted: true,
                    encryptionMetadata: conflict.baseVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                    userId: effectiveUid,
                });
                if (baseInbound.status === "decrypted") {
                    conflict.baseVersion.content = baseInbound.content;
                }
            }

            // Auto-resolve if identical markdown content or identical ETags
            const isIdentical =
                normalizeMarkdownSource(conflict.localVersion.content) ===
                    normalizeMarkdownSource(conflict.serverVersion.content) ||
                (conflict.localVersion.etag &&
                    conflict.serverVersion.etag &&
                    conflict.localVersion.etag === conflict.serverVersion.etag);

            if (isIdentical) {
                console.log("[Orchestrator] Auto-resolving identical conflict without modal");
                if (syncHookRef.current?.isInitialized) {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: conflict.serverVersion.content,
                        version: conflict.serverVersion.version,
                        etag: conflict.serverVersion.etag,
                        isEncrypted: isEncryptedRef.current,
                        encryptionMetadata: fileEncryptionMetadataRef.current,
                        isDirty: false,
                    });
                }
                fileVersionRef.current = conflict.serverVersion.version;
                setServerVersion(conflict.serverVersion.version);
                if (conflict.serverVersion.etag) {
                    fileEtagRef.current = conflict.serverVersion.etag;
                    setServerEtag(conflict.serverVersion.etag);
                }
                activeConflictRef.current = null;
                setActiveConflict(null);
                setIsConflictDialogOpen(false);
                return "server";
            }

            activeConflictRef.current = conflict;
            setActiveConflict(conflict);
            setIsConflictDialogOpen(true);
            return "local";
        },
        [fileId, resolveEffectiveUserId]
    );

    // --- AI Stream Hook Integration ---
    const aiStream = useAIStream({
        transformCommitPayload: async (content: string) => {
            if (!isEncryptedRef.current) {
                return { content };
            }
            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) {
                setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ تعديلات الذكاء الاصطناعي المشفرة.");
                setIsVaultLocked(true);
                setIsUnlockModalOpen(true);
                throw new Error("Vault master key missing from volatile memory");
            }
            const ivBytes = await cryptoWorkerBridge.generateRandomBytes(12);
            const effectiveUid = await resolveEffectiveUserId();
            const aad = `vault:file:${effectiveUid}:${fileId}`;
            const encResult = await cryptoWorkerBridge.encryptAESGCM(
                masterKey,
                content,
                ivBytes,
                aad
            );
            const metaToSend = {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: encResult.ivBase64,
                kdfIterations: 600000,
            };
            fileEncryptionMetadataRef.current = metaToSend;
            wipeBuffer(ivBytes);
            return {
                content: encResult.ciphertextBase64,
                encryptionMetadata: metaToSend,
            };
        },
        onCommitSuccess: async ({ version, etag, committedContent, encryptionMetadata }) => {
            fileVersionRef.current = version;
            setServerVersion(version);
            fileEtagRef.current = etag;
            setServerEtag(etag);
            editorGenerationRef.current += 1;
            editorContentRef.current = adapterRef.current?.getValue() || committedContent || "";
            isDirtyRef.current = false;
            setLastSaved(new Date());

            if (syncHookRef.current?.isInitialized && adapterRef.current) {
                try {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: isEncryptedRef.current && committedContent ? committedContent : adapterRef.current.getValue(),
                        title,
                        version,
                        etag: etag || "",
                        isEncrypted: isEncryptedRef.current,
                        encryptionMetadata: isEncryptedRef.current ? (encryptionMetadata ?? fileEncryptionMetadataRef.current) : null,
                        isDirty: false,
                    });
                    pendingLocalSyncRef.current = false;
                    markClean();
                } catch (saveErr) {
                    console.error("[Orchestrator] Post-commit local IndexedDB save error:", saveErr);
                    // Defensive durability: retain dirty flag and schedule retry on tab wakeup
                    pendingLocalSyncRef.current = true;
                    markDirty();
                }
            } else {
                markClean();
            }

            broadcastCrossTabEvent({
                type: "file_saved",
                fileId,
                version,
                etag,
            });
        },
        onConflict: (svrVersion) => {
            console.warn("[Orchestrator] AI commit version conflict:", svrVersion);
        },
        onError: (err) => {
            setError(err.message);
        },
        getLatestVersion: () => fileVersionRef.current,
        getLatestETag: () => fileEtagRef.current,
        onProgrammaticTransaction: (fn) => {
            isProgrammaticUpdateRef.current = true;
            try {
                fn();
            } finally {
                isProgrammaticUpdateRef.current = false;
            }
        },
    });

    const handleRemoteUpdate = useCallback(
        async (event: RemoteUpdatePayload) => {
            if (event.fileId !== fileId) return;

            // Invariant Guards:
            // 1. Never overwrite during active unresolved conflict or active conflict resolution
            if (activeConflictRef.current !== null || isResolvingConflictRef.current) {
                return;
            }

            // 2. Never overwrite during AI generation / reservation / commit
            if (
                aiStream.isLoading ||
                aiStream.isStreaming ||
                aiStream.isCommitting ||
                aiStream.status === "reserved" ||
                aiStream.status === "preview_ready"
            ) {
                return;
            }

            // 3. Never overwrite during programmatic transactions or before hydration completes
            if (isProgrammaticUpdateRef.current || !hydratedRef.current) {
                if (!hydratedRef.current) {
                    pendingRemoteUpdateRef.current = event;
                }
                return;
            }

            let safeContent = event.content;
            if (isEncryptedRef.current || event.isEncrypted) {
                if (event.isVaultLocked || !sessionKeyStore.hasMasterKey()) {
                    console.warn("[Orchestrator] Remote update received for encrypted file while vault is locked. Preserving locked state.");
                    pendingEncryptedPayloadRef.current = {
                        content: event.content,
                        metadata: event.encryptionMetadata || fileEncryptionMetadataRef.current,
                        title: event.title || title,
                        version: event.version,
                        etag: event.etag,
                    };
                    setIsVaultLocked(true);
                    setIsUnlockModalOpen(true);
                    return;
                }

                const effectiveUid = await resolveEffectiveUserId();
                buildFileAAD(effectiveUid, fileId);
                const inbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: event.content,
                    isEncrypted: true,
                    encryptionMetadata: event.encryptionMetadata || fileEncryptionMetadataRef.current,
                    userId: effectiveUid,
                });

                if (inbound.status === "decrypted") {
                    safeContent = inbound.content;
                    if (inbound.encryptionMetadata) {
                        fileEncryptionMetadataRef.current = inbound.encryptionMetadata;
                    }
                } else if (inbound.status === "locked") {
                    setIsVaultLocked(true);
                    setIsUnlockModalOpen(true);
                    return;
                } else {
                    console.error("[Orchestrator] Remote update decryption failed:", inbound.error);
                    setError("فشل فك تشفير التحديث الوارد من الخادم.");
                    return;
                }
            }

            const currentLocalContent = adapterRef.current?.getValue() ?? editorContentRef.current ?? "";
            const localBaseline: LocalBaseline = {
                version: fileVersionRef.current,
                etag: fileEtagRef.current,
                content: currentLocalContent,
            };

            const decision = classifyRemoteUpdate({
                localBaseline,
                isDirty: isDirtyRef.current,
                remoteVersion: event.version,
                remoteEtag: event.etag,
                remoteContent: safeContent,
            });

            if (decision.action === "apply") {
                // 1. Invariant: Cancel any pending debounced auto-save timer so in-flight stale typing does not overwrite server content
                cancelAutosave();

                // 2. Synchronously reset dirty flags
                markClean();

                // 3. Generation guard: apply remote update cleanly without disrupting user
                fileVersionRef.current = event.version;
                setServerVersion(event.version);
                fileEtagRef.current = event.etag;
                setServerEtag(event.etag);
                editorGenerationRef.current += 1;

                // 4. Synchronously update memory ref
                editorContentRef.current = safeContent;

                const prevSelection = adapterRef.current?.getSelection();
                const hadFocus = adapterRef.current?.hasFocus() ?? false;

                isProgrammaticUpdateRef.current = true;
                try {
                    adapterRef.current?.setValue(safeContent);
                    if (prevSelection && hadFocus) {
                        const maxLen = safeContent.length;
                        adapterRef.current?.setSelection(
                            Math.min(prevSelection.from, maxLen),
                            Math.min(prevSelection.to, maxLen)
                        );
                    }
                } finally {
                    isProgrammaticUpdateRef.current = false;
                }

                if (event.title && event.title !== title) {
                    setTitle(event.title);
                }

                markServerPersisted(event.updatedAt);

                // 5. Atomically persist clean state and baseSnapshot into local IndexedDB
                if (syncHookRef.current?.isInitialized) {
                    try {
                        await syncHookRef.current.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? event.content : safeContent,
                            title: event.title || title,
                            version: event.version,
                            etag: event.etag || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: fileEncryptionMetadataRef.current,
                            isDirty: false,
                        });
                    } catch (idbErr) {
                        console.error("[Orchestrator] Error updating local IDB during remote update:", idbErr);
                    }
                }
            } else if (decision.action === "adopt_metadata") {
                fileVersionRef.current = event.version;
                setServerVersion(event.version);
                fileEtagRef.current = event.etag;
                setServerEtag(event.etag);
                markServerPersisted(event.updatedAt);
                if (syncHookRef.current?.isInitialized) {
                    try {
                        await syncHookRef.current.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? event.content : safeContent,
                            title: event.title || title,
                            version: event.version,
                            etag: event.etag || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: fileEncryptionMetadataRef.current,
                            isDirty: false,
                        });
                    } catch (idbErr) {
                        console.error("[Orchestrator] Error updating local IDB during adopt_metadata:", idbErr);
                    }
                }
            } else if (decision.action === "keep_local") {
                console.log(
                    `[Orchestrator] Remote update retained locally (reason: ${decision.reason}). Local edits preserved.`
                );
            }
        },
        [fileId, title, aiStream.isLoading, aiStream.isStreaming, aiStream.isCommitting, aiStream.status, markServerPersisted, resolveEffectiveUserId, cancelAutosave, markClean]
    );

    const syncHook = useSync({
        userId: userId || "",
        autoSyncInterval: 30000,
        onConflict: handleSyncConflict,
        onRemoteUpdate: handleRemoteUpdate,
    });
    useLayoutEffect(() => {
        syncHookRef.current = syncHook;
    }, [syncHook]);

    // Write State Computation
    const writeState: WriteStateType = isResolvingConflict
        ? "resolving_conflict"
        : aiStream.isCommitting
        ? "ai_committing"
        : isSaving
        ? "saving"
        : syncHook.status === "syncing"
        ? "syncing"
        : syncHook.status === "stopped"
        ? "stopped"
        : "idle";

    /**
     * AutoSave Suspension Invariants Gate & Callbacks (Phase 17)
     */
    const isBlocked = useCallback((): boolean => {
        if (isProgrammaticUpdateRef.current) return true;
        if (hydratedRef.current !== true) return true;
        if (activeConflictRef.current !== null) return true;
        if (isResolvingConflictRef.current) return true;
        if (syncHook.status === "stopped") return true;
        return false;
    }, [syncHook.status]);

    const isWriteLocked =
        aiStream.isLoading ||
        aiStream.isStreaming ||
        aiStream.isCommitting ||
        aiStream.status === "reserved" ||
        aiStream.status === "preview_ready";

    const flushOnUnmount = useCallback((content: string, targetFileId: string) => {
        if (!syncHookRef.current?.isInitialized) return;

        const performFlush = async () => {
            let contentToSave = content;
            let metaToSave = fileEncryptionMetadataRef.current;

            if (isEncryptedRef.current) {
                if (!sessionKeyStore.hasMasterKey()) {
                    console.warn(
                        `[Orchestrator] Unmount flush skipped for encrypted file ${targetFileId}: vault is locked, refusing to persist plaintext tagged as encrypted (LUGX-004).`
                    );
                    return;
                }

                try {
                    const effectiveUid = await resolveEffectiveUserId();
                    buildFileAAD(effectiveUid, targetFileId);
                    const encrypted = await SyncCryptoGateway.encryptOutbound(
                        targetFileId,
                        content,
                        effectiveUid
                    );
                    contentToSave = encrypted.ciphertextBase64;
                    metaToSave = encrypted.encryptionMetadata;
                } catch (err) {
                    console.error("[Orchestrator] Failed to encrypt outbound payload during unmount flush:", err);
                    return;
                }
            }

            try {
                await syncHookRef.current?.saveLocal({
                    id: targetFileId,
                    content: contentToSave,
                    title,
                    version: fileVersionRef.current,
                    etag: fileEtagRef.current || "",
                    isEncrypted: isEncryptedRef.current,
                    encryptionMetadata: metaToSave,
                    isDirty: true,
                });
            } catch (err) {
                console.warn("[Orchestrator] Unmount flush error:", err);
            }
        };

        performFlush();
    }, [title, resolveEffectiveUserId]);

    const onUserEdit = useCallback((content: string) => {
        const isAIActive =
            aiStream.isLoading ||
            aiStream.isStreaming ||
            aiStream.status === "reserved" ||
            aiStream.status === "preview_ready";

        if (isAIActive) {
            const ghostRange =
                typeof adapterRef.current?.getGhostRange === "function"
                    ? adapterRef.current.getGhostRange()
                    : null;

            if (!ghostRange) {
                console.warn(
                    "[Orchestrator] User manual edit collided with AI target range or entire document was modified. Aborting AI generation."
                );
                aiStream.stopStream();
            } else {
                console.log(
                    "[Orchestrator] User manual edit occurred outside AI target range. Retaining active stream at shifted range:",
                    ghostRange
                );
            }
        }

        // Touch inactivity timer upon user keystrokes / activity (AUD-04)
        sessionKeyStore.touch();

        editorContentRef.current = content;
        editorGenerationRef.current += 1;
    }, [aiStream]);

    /**
     * Centralized Server Write with ETag & Version Precondition Guard
     */
    const executeServerWrite = useCallback(
        async (content: string, targetFileId?: string) => {
            const activeTargetId = targetFileId || fileId;
            if (activeTargetId !== fileIdRef.current) {
                console.log("[Orchestrator] Auto-save skipped: target fileId mismatch with active file", {
                    activeTargetId,
                    currentFileId: fileIdRef.current,
                });
                return;
            }
            if (!hydratedRef.current) {
                console.log("[Orchestrator] Auto-save deferred: hydration not complete.");
                return;
            }
            if (isBlocked() || isWriteLocked) {
                console.log("[Orchestrator] Auto-save skipped due to active suspension gate invariant");
                return;
            }

            setIsSaving(true);

            let contentToSend = content ?? editorContentRef.current ?? "";
            let metaToSend = fileEncryptionMetadataRef.current;

            try {

                if (isEncryptedRef.current) {
                    const masterKey = sessionKeyStore.getMasterKeyRaw();
                    if (!masterKey) {
                        console.error("[Orchestrator] Cannot save encrypted file: Master key missing from memory");
                        setIsSaving(false);
                        setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ التعديلات المشفرة بأمان.");
                        setIsVaultLocked(true);
                        setIsUnlockModalOpen(true);
                        return;
                    }

                    const effectiveUid = await resolveEffectiveUserId();
                    buildFileAAD(effectiveUid, fileId);
                    const encResult = await SyncCryptoGateway.encryptOutbound(
                        fileId,
                        contentToSend,
                        effectiveUid
                    );
                    contentToSend = encResult.ciphertextBase64;
                    metaToSend = encResult.encryptionMetadata;
                    fileEncryptionMetadataRef.current = metaToSend;
                }

                const saveRes = isEncryptedRef.current
                    ? await toggleFileEncryption(fileId, true, contentToSend, metaToSend, {
                          expectedVersion: fileVersionRef.current,
                          expectedETag: fileEtagRef.current || undefined,
                      })
                    : await updateFileContent(fileId, contentToSend, {
                          expectedVersion: fileVersionRef.current,
                          expectedETag: fileEtagRef.current || undefined,
                      });

                if (saveRes.success && saveRes.version) {
                    fileVersionRef.current = saveRes.version;
                    setServerVersion(saveRes.version);
                    fileEtagRef.current = saveRes.etag || null;
                    setServerEtag(saveRes.etag || null);
                    editorGenerationRef.current += 1;
                    setLastSaved(new Date());
                    markClean();

                    // Broadcast cross-tab
                    broadcastCrossTabEvent({
                        type: "file_saved",
                        fileId,
                        version: saveRes.version,
                        etag: saveRes.etag || undefined,
                    });

                    // Update local storage clean (always store ciphertext for encrypted files)
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: saveRes.version,
                            etag: saveRes.etag || fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: false,
                        });
                    }
                } else if (saveRes.status === "conflict" && saveRes.serverVersion) {
                    const effectiveUid = await resolveEffectiveUserId();
                    buildFileAAD(effectiveUid, fileId);
                    let decryptedServerContent = saveRes.serverVersion.content || "";

                    if (isEncryptedRef.current || saveRes.serverVersion.isEncrypted) {
                        const serverInbound = await SyncCryptoGateway.decryptInbound({
                            fileId,
                            content: saveRes.serverVersion.content || "",
                            isEncrypted: true,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                            userId: effectiveUid,
                        });
                        if (serverInbound.status === "decrypted") {
                            decryptedServerContent = serverInbound.content;
                        }
                    }

                    // False conflict check with decrypted content
                    const isIdenticalContent =
                        normalizeMarkdownSource(decryptedServerContent) === normalizeMarkdownSource(content);

                    if (
                        isIdenticalContent ||
                        (saveRes.serverVersion.etag && saveRes.serverVersion.etag === fileEtagRef.current)
                    ) {
                        console.log("[Orchestrator] Server conflict has identical content, auto-synchronizing version");
                        fileVersionRef.current = saveRes.serverVersion.version || fileVersionRef.current;
                        setServerVersion(fileVersionRef.current);
                        fileEtagRef.current = saveRes.serverVersion.etag || null;
                        setServerEtag(fileEtagRef.current);

                        if (syncHook.isInitialized) {
                            await syncHook.saveLocal({
                                id: fileId,
                                content: isEncryptedRef.current ? contentToSend : content,
                                title,
                                version: saveRes.serverVersion.version ?? fileVersionRef.current,
                                etag: saveRes.serverVersion.etag || "",
                                isEncrypted: isEncryptedRef.current,
                                encryptionMetadata: metaToSend,
                                isDirty: false,
                            });
                        }
                        setIsSaving(false);
                        markClean();
                        activeConflictRef.current = null;
                        setActiveConflict(null);
                        setIsConflictDialogOpen(false);
                        return;
                    }

                    // True conflict (412 Precondition Failed)
                    console.warn("[Orchestrator] 412 Sync conflict detected during save:", saveRes.serverVersion);
                    const localFile = syncHook.isInitialized ? await syncHook.loadLocal(fileId) : null;

                    let baseContent = localFile?.baseSnapshot?.content;
                    if (baseContent && (isEncryptedRef.current || localFile?.baseSnapshot?.isEncrypted)) {
                        const baseInbound = await SyncCryptoGateway.decryptInbound({
                            fileId,
                            content: baseContent,
                            isEncrypted: true,
                            encryptionMetadata: localFile?.encryptionMetadata || fileEncryptionMetadataRef.current,
                            userId: effectiveUid,
                        });
                        if (baseInbound.status === "decrypted") {
                            baseContent = baseInbound.content;
                        }
                    }

                    const conflictObj: SyncConflict = {
                        fileId,
                        localVersion: {
                            content,
                            etag: fileEtagRef.current || "",
                            lastModified: Date.now(),
                            version: fileVersionRef.current,
                            title,
                            parentFolderId: null,
                            deleted: false,
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: fileEncryptionMetadataRef.current,
                        },
                        serverVersion: {
                            content: decryptedServerContent,
                            etag: saveRes.serverVersion.etag || "",
                            lastModified: saveRes.serverVersion.updatedAt
                                ? new Date(saveRes.serverVersion.updatedAt).getTime()
                                : Date.now(),
                            version: saveRes.serverVersion.version || 0,
                            title,
                            parentFolderId: null,
                            deleted: false,
                            isEncrypted: saveRes.serverVersion.isEncrypted ?? isEncryptedRef.current,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                        },
                        baseVersion: localFile?.baseSnapshot
                            ? {
                                  content: baseContent || "",
                                  etag: localFile.baseSnapshot.etag,
                                  lastModified: localFile.lastSyncedAt || 0,
                                  version: localFile.baseSnapshot.version,
                                  title: localFile.baseSnapshot.title,
                                  parentFolderId: localFile.baseSnapshot.parentFolderId,
                                  deleted: false,
                                  isEncrypted: isEncryptedRef.current,
                                  encryptionMetadata: localFile.encryptionMetadata,
                              }
                            : undefined,
                        operations: [],
                        detectedAt: Date.now(),
                        type: "content",
                    };

                    activeConflictRef.current = conflictObj;
                    setActiveConflict(conflictObj);
                    setIsConflictDialogOpen(true);

                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: false,
                        });
                    }
                } else {
                    // Offline / Network failure -> save dirty locally with ciphertext
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: true,
                        });
                    }
                }
            } catch (saveErr) {
                console.warn("[Orchestrator] Save failed, saving dirty to IndexedDB:", saveErr);
                if (syncHook.isInitialized) {
                    if (isEncryptedRef.current && (!metaToSend?.iv || contentToSend === content)) {
                        console.warn("[Orchestrator] Cannot save dirty encrypted file to IDB: content is not encrypted.");
                        return;
                    }
                    try {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: true,
                        });
                    } catch (dirtySaveErr) {
                        console.error("[Orchestrator] Fallback dirty save to IndexedDB failed:", dirtySaveErr);
                    }
                }
            } finally {
                setIsSaving(false);
            }
        },
        [fileId, title, isBlocked, isWriteLocked, syncHook, resolveEffectiveUserId, markClean]
    );

    const autosave = useEditorAutosave({
        fileId,
        isWriteLocked,
        isBlocked,
        persist: executeServerWrite,
        flushOnUnmount,
        getContent: () => {
            if (typeof editorContentRef.current === "string" && editorContentRef.current.length > 0) {
                return editorContentRef.current;
            }
            const adapterVal = adapterRef.current?.getValue();
            if (typeof adapterVal === "string" && adapterVal.length > 0) {
                return adapterVal;
            }
            return editorContentRef.current ?? adapterVal ?? null;
        },
        onUserEdit,
    });

    useLayoutEffect(() => {
        autosaveRef.current = autosave;
    });

    useEffect(() => {
        isDirtyRef.current = autosave.isDirty;
    }, [autosave.isDirty]);

    // Vault Unlock Handler: Decrypts pending payload and hydrates editor
    const handleVaultUnlocked = useCallback(async () => {
        setIsVaultLocked(false);
        setIsUnlockModalOpen(false);

        const pending = pendingEncryptedPayloadRef.current;
        if (!pending) {
            hydratedRef.current = true;
            setHydration("ready");
            if (adapterRef.current) adapterRef.current.setEditable(true);
            return;
        }

        const masterKey = sessionKeyStore.getMasterKeyRaw();
        let contentToDisplay = pending.content;

        if (masterKey && pending.content) {
            try {
                const effectiveUid = await resolveEffectiveUserId();
                buildFileAAD(effectiveUid, fileId);
                const inbound = await SyncCryptoGateway.decryptInbound({
                    fileId,
                    content: pending.content,
                    isEncrypted: true,
                    encryptionMetadata: pending.metadata,
                    userId: effectiveUid,
                });

                if (inbound.status === "decrypted") {
                    contentToDisplay = inbound.content;
                } else {
                    console.error("[Orchestrator] Decryption failed upon vault unlock (LUGX-048):", inbound.error);
                    setError("تعذّر فك تشفير محتوى الملف (بيانات تالفة أو مفتاح غير صالح).");
                    setHydration("fatal");
                    hydratedRef.current = false;
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }
            } catch (err) {
                console.error("[Orchestrator] Decryption error upon vault unlock (LUGX-048):", err);
                setError("تعذّر فك تشفير محتوى الملف (بيانات تالفة أو مفتاح غير صالح).");
                setHydration("fatal");
                hydratedRef.current = false;
                if (adapterRef.current) adapterRef.current.setEditable(false);
                return;
            }
        }

        setTitle(pending.title);
        fileVersionRef.current = pending.version;
        setServerVersion(pending.version);
        fileEtagRef.current = pending.etag;
        setServerEtag(pending.etag);
        editorGenerationRef.current += 1;
        editorContentRef.current = contentToDisplay;

        isProgrammaticUpdateRef.current = true;
        try {
            adapterRef.current?.setValue(contentToDisplay);
        } finally {
            isProgrammaticUpdateRef.current = false;
        }

        hydratedRef.current = true;
        setHydration("ready");
        if (adapterRef.current) adapterRef.current.setEditable(true);
        pendingEncryptedPayloadRef.current = null;
    }, [fileId, resolveEffectiveUserId]);

    // Initial Load - Offline-First with Background Server Sync
    useEffect(() => {
        let cancelled = false;

        async function loadInitialFile() {
            if (loadedFileIdRef.current === fileId) return;

            // Freeze the editor surface so nothing can be typed pre-hydration.
            hydratedRef.current = false;
            loadFailureRef.current = false;
            setHydration("hydrating");
            if (adapterRef.current) {
                adapterRef.current.setEditable(false);
            }

            const sh = syncHookRef.current;
            let localBaseline: LocalBaseline | null = null;
            let isVaultLockedExit = false;
            let isFatalExit = false;

            try {
                // Step 1: instant paint from IndexedDB (offline-first).
                if (sh?.isInitialized) {
                    const localFile = await sh.loadLocal(fileId);
                    if (!cancelled && localFile) {
                        const fileIsEncrypted = !!localFile.isEncrypted;
                        isEncryptedRef.current = fileIsEncrypted;
                        setIsEncrypted(fileIsEncrypted);
                        fileEncryptionMetadataRef.current = localFile.encryptionMetadata || null;

                        if (fileIsEncrypted && !sessionKeyStore.hasMasterKey()) {
                            isVaultLockedExit = true;
                            pendingEncryptedPayloadRef.current = {
                                content: localFile.content || "",
                                metadata: localFile.encryptionMetadata || null,
                                title: localFile.title,
                                version: localFile.version || 1,
                                etag: localFile.etag || null,
                            };
                            setTitle(localFile.title);
                            setIsVaultLocked(true);
                            setIsUnlockModalOpen(true);
                            setHydration("vault_locked");
                            if (adapterRef.current) adapterRef.current.setEditable(false);
                            return;
                        }

                        let initialContent = localFile.content || "";
                        if (fileIsEncrypted && initialContent) {
                            try {
                                const effectiveUid = await resolveEffectiveUserId();
                                buildFileAAD(effectiveUid, fileId);
                                const inbound = await SyncCryptoGateway.decryptInbound({
                                    fileId,
                                    content: initialContent,
                                    isEncrypted: true,
                                    encryptionMetadata: localFile.encryptionMetadata || null,
                                    userId: effectiveUid,
                                });

                                if (inbound.status === "decrypted") {
                                    initialContent = inbound.content;
                                    if (inbound.encryptionMetadata) {
                                        fileEncryptionMetadataRef.current = inbound.encryptionMetadata;
                                    }
                                } else if (inbound.status === "locked") {
                                    isVaultLockedExit = true;
                                    pendingEncryptedPayloadRef.current = {
                                        content: localFile.content || "",
                                        metadata: localFile.encryptionMetadata || null,
                                        title: localFile.title,
                                        version: localFile.version || 1,
                                        etag: localFile.etag || null,
                                    };
                                    setTitle(localFile.title);
                                    setIsVaultLocked(true);
                                    setIsUnlockModalOpen(true);
                                    setHydration("vault_locked");
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                } else {
                                    console.error("[Orchestrator] Local IDB decryption failure (LUGX-048):", inbound.error);
                                    setError("تعذّر فك تشفير محتوى الملف المحلي (بيانات تالفة أو مفتاح غير صالح).");
                                    isFatalExit = true;
                                    setHydration("fatal");
                                    hydratedRef.current = false;
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                }
                            } catch (decErr) {
                                console.error("[Orchestrator] Local IDB decrypt error (LUGX-048):", decErr);
                                setError("تعذّر فك تشفير محتوى الملف المحلي (بيانات تالفة أو مفتاح غير صالح).");
                                isFatalExit = true;
                                setHydration("fatal");
                                hydratedRef.current = false;
                                if (adapterRef.current) adapterRef.current.setEditable(false);
                                return;
                            }
                        }

                        localBaseline = {
                            version: localFile.version || 1,
                            etag: localFile.etag || null,
                            content: initialContent,
                        };
                        setTitle(localFile.title);
                        fileVersionRef.current = localFile.version || 1;
                        setServerVersion(localFile.version || 1);
                        fileEtagRef.current = localFile.etag || null;
                        setServerEtag(localFile.etag || null);
                        editorGenerationRef.current += 1;
                        editorContentRef.current = initialContent;

                        isProgrammaticUpdateRef.current = true;
                        try {
                            adapterRef.current?.setValue(initialContent);
                        } finally {
                            isProgrammaticUpdateRef.current = false;
                        }
                    }
                }

                // Step 2: background authoritative fetch + reconciliation.
                const result = await getFile(fileId);
                if (cancelled) return;

                if (!(result.success && result.data)) {
                    const localNow = await sh?.loadLocal(fileId);
                    if (!localNow && !isDirtyRef.current) {
                        loadFailureRef.current = true;
                    }
                    if (!localNow && onNavigate) {
                        onNavigate("/workspace");
                    }
                } else {
                    const data = result.data;
                    const remoteIsEncrypted = !!data.isEncrypted;
                    isEncryptedRef.current = remoteIsEncrypted;
                    setIsEncrypted(remoteIsEncrypted);
                    fileEncryptionMetadataRef.current = data.encryptionMetadata || null;

                    setTitle(data.title);
                    const remoteVersion = data.version ?? 1;
                    const remoteEtag = data.etag ?? null;
                    let safeContent = data.content || "";

                    if (remoteIsEncrypted) {
                        if (!sessionKeyStore.hasMasterKey()) {
                            isVaultLockedExit = true;
                            pendingEncryptedPayloadRef.current = {
                                content: safeContent,
                                metadata: data.encryptionMetadata,
                                title: data.title,
                                version: remoteVersion,
                                etag: remoteEtag,
                            };
                            setIsVaultLocked(true);
                            setIsUnlockModalOpen(true);
                            setHydration("vault_locked");
                            if (adapterRef.current) adapterRef.current.setEditable(false);
                            return;
                        }

                        if (safeContent) {
                            try {
                                const effectiveUid = await resolveEffectiveUserId();
                                buildFileAAD(effectiveUid, fileId);
                                const inbound = await SyncCryptoGateway.decryptInbound({
                                    fileId,
                                    content: safeContent,
                                    isEncrypted: true,
                                    encryptionMetadata: data.encryptionMetadata || null,
                                    userId: effectiveUid,
                                });

                                if (inbound.status === "decrypted") {
                                    safeContent = inbound.content;
                                    if (inbound.encryptionMetadata) {
                                        fileEncryptionMetadataRef.current = inbound.encryptionMetadata;
                                    }
                                } else if (inbound.status === "locked") {
                                    isVaultLockedExit = true;
                                    pendingEncryptedPayloadRef.current = {
                                        content: data.content || "",
                                        metadata: data.encryptionMetadata,
                                        title: data.title,
                                        version: remoteVersion,
                                        etag: remoteEtag,
                                    };
                                    setIsVaultLocked(true);
                                    setIsUnlockModalOpen(true);
                                    setHydration("vault_locked");
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                } else {
                                    console.error("[Orchestrator] Remote decryption failed (LUGX-048):", inbound.error);
                                    setError("تعذّر فك تشفير محتوى الملف من الخادم (بيانات تالفة أو مفتاح غير صالح).");
                                    isFatalExit = true;
                                    setHydration("fatal");
                                    hydratedRef.current = false;
                                    if (adapterRef.current) adapterRef.current.setEditable(false);
                                    return;
                                }
                            } catch (decErr) {
                                console.error("[Orchestrator] Remote decrypt error (LUGX-048):", decErr);
                                setError("تعذّر فك تشفير محتوى الملف من الخادم (بيانات تالفة أو مفتاح غير صالح).");
                                isFatalExit = true;
                                setHydration("fatal");
                                hydratedRef.current = false;
                                if (adapterRef.current) adapterRef.current.setEditable(false);
                                return;
                            }
                        }
                    }

                    const decision = classifyRemoteUpdate({
                        localBaseline,
                        isDirty: isDirtyRef.current,
                        remoteVersion,
                        remoteEtag,
                        remoteContent: safeContent,
                    });

                    const adoptAnchors = () => {
                        fileVersionRef.current = remoteVersion;
                        setServerVersion(remoteVersion);
                        fileEtagRef.current = remoteEtag;
                        setServerEtag(remoteEtag);
                    };
                    const paintServer = () => {
                        editorGenerationRef.current += 1;
                        editorContentRef.current = safeContent;
                        isProgrammaticUpdateRef.current = true;
                        try {
                            adapterRef.current?.setValue(safeContent);
                        } finally {
                            isProgrammaticUpdateRef.current = false;
                        }
                    };
                    const persistClean = async () => {
                        if (sh?.isInitialized) {
                            await sh.saveLocal({
                                id: fileId,
                                content: isEncryptedRef.current ? (data.content ?? "") : safeContent,
                                title: data.title,
                                version: remoteVersion,
                                etag: remoteEtag || "",
                                isEncrypted: isEncryptedRef.current,
                                encryptionMetadata: fileEncryptionMetadataRef.current,
                                isDirty: false,
                            });
                        }
                    };

                    switch (decision.action) {
                        case "bootstrap_server": {
                            adoptAnchors();
                            paintServer();
                            markServerPersisted(data.updatedAt);
                            markClean();
                            await persistClean();
                            break;
                        }
                        case "apply": {
                            adoptAnchors();
                            if (adapterRef.current?.getValue() !== safeContent) paintServer();
                            markServerPersisted(data.updatedAt);
                            await persistClean();
                            break;
                        }
                        case "adopt_metadata": {
                            adoptAnchors();
                            markServerPersisted(data.updatedAt);
                            await persistClean();
                            break;
                        }
                        case "adopt_metadata_keep_edits": {
                            adoptAnchors();
                            console.warn(
                                "[Orchestrator] Cold-start eager edits: adopted remote metadata anchors only; user text kept dirty."
                            );
                            break;
                        }
                        case "keep_local":
                        default:
                            console.warn(
                                `[Orchestrator] Remote update retained locally during initial load (reason: ${decision.reason}). Optimistic locking will surface a conflict if required.`
                            );
                            break;
                    }
                }
            } catch (fetchErr) {
                console.warn("[Orchestrator] Server fetch offline / failed:", fetchErr);
            } finally {
                if (cancelled) return;

                if (isVaultLockedExit) {
                    hydratedRef.current = false;
                    setHydration("vault_locked");
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }

                if (isFatalExit) {
                    hydratedRef.current = false;
                    setHydration("fatal");
                    if (adapterRef.current) adapterRef.current.setEditable(false);
                    return;
                }

                loadedFileIdRef.current = fileId;

                const nothingUsable =
                    !localBaseline && !isDirtyRef.current && loadFailureRef.current;
                if (nothingUsable) {
                    setHydration("fatal");
                    setError(
                        "تعذّر تحميل الملف من الخادم ولا توجد نسخة محلية. تحقق من الاتصال ثم أعد المحاولة."
                    );
                    hydratedRef.current = false;
                    return;
                }

                hydratedRef.current = true;
                setHydration("ready");
                if (adapterRef.current) adapterRef.current.setEditable(true);

                if (pendingRemoteUpdateRef.current) {
                    const pending = pendingRemoteUpdateRef.current;
                    pendingRemoteUpdateRef.current = null;
                    handleRemoteUpdate(pending);
                }
            }
        }

        if (!fileId || !currentAdapter) return;
        if (loadedFileIdRef.current === fileId || pipelineRef.current) return;
        const run = loadInitialFile();
        pipelineRef.current = run.finally(() => {
            pipelineRef.current = null;
        });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fileId, currentAdapter]);

    // Local SessionKeyStore lock/unlock lifecycle listener
    useEffect(() => {
        const unsubscribe = sessionKeyStore.subscribe((isUnlocked) => {
            if (!isUnlocked && isEncryptedRef.current) {
                autosaveRef.current?.cancelAutosave();
                setIsVaultLocked(true);
                setIsUnlockModalOpen(true);
                setHydration("vault_locked");
                if (adapterRef.current) {
                    adapterRef.current.setEditable(false);
                }
            }
        });
        return () => {
            unsubscribe();
        };
    }, []);

    // Cross-tab synchronization listener
    useEffect(() => {
        const unsubscribe = subscribeCrossTabSync(async (event) => {
            if (event.type === "vault_unlocked") {
                if (isEncryptedRef.current && sessionKeyStore.hasMasterKey()) {
                    setIsVaultLocked(false);
                    setIsUnlockModalOpen(false);
                    handleVaultUnlocked();
                }
                return;
            }

            if (event.type === "vault_locked") {
                // 1. Cancel pending auto-save immediately
                autosaveRef.current?.cancelAutosave();
                // 2. Purge RAM immediately (no re-broadcast)
                sessionKeyStore.lock(false);
                // 3. Update UI state
                if (isEncryptedRef.current) {
                    setIsVaultLocked(true);
                    setIsUnlockModalOpen(true);
                    setHydration("vault_locked");
                    if (adapterRef.current) {
                        adapterRef.current.setEditable(false);
                    }
                }
                return;
            }

            if (event.fileId === fileId) {
                if (event.type === "file_encrypted") {
                    autosaveRef.current?.cancelAutosave();
                    isEncryptedRef.current = true;
                    setIsEncrypted(true);
                    if (event.metadata) {
                        fileEncryptionMetadataRef.current = event.metadata as FileEncryptionMetadata;
                    }
                    if (event.version) {
                        fileVersionRef.current = event.version;
                        setServerVersion(event.version);
                    }
                    if (event.etag) {
                        fileEtagRef.current = event.etag;
                        setServerEtag(event.etag);
                    }
                    autosaveRef.current?.markClean();
                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                    return;
                }

                if (event.type === "file_decrypted") {
                    autosaveRef.current?.cancelAutosave();
                    isEncryptedRef.current = false;
                    setIsEncrypted(false);
                    fileEncryptionMetadataRef.current = null;
                    if (event.version) {
                        fileVersionRef.current = event.version;
                        setServerVersion(event.version);
                    }
                    if (event.etag) {
                        fileEtagRef.current = event.etag;
                        setServerEtag(event.etag);
                    }
                    autosaveRef.current?.markClean();
                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                    return;
                }

                const localFile = syncHook.isInitialized ? await syncHook.loadLocal(fileId) : null;
                const isLocalDirty = localFile?.isDirty || activeConflictRef.current !== null || (autosaveRef.current?.isDirty ?? false);

                if (!isLocalDirty && localFile) {
                    autosaveRef.current?.cancelAutosave();
                    autosaveRef.current?.markClean();

                    if (event.version && event.version > fileVersionRef.current) {
                        fileVersionRef.current = event.version;
                        setServerVersion(event.version);
                    }
                    if (event.etag) {
                        fileEtagRef.current = event.etag;
                        setServerEtag(event.etag);
                    }
                    editorGenerationRef.current += 1;

                    let incomingContent = localFile.content || "";
                    if (isEncryptedRef.current && sessionKeyStore.hasMasterKey() && localFile.encryptionMetadata?.iv && incomingContent) {
                        try {
                            const effectiveUid = await resolveEffectiveUserId();
                            buildFileAAD(effectiveUid, fileId);
                            const inbound = await SyncCryptoGateway.decryptInbound({
                                fileId,
                                content: incomingContent,
                                isEncrypted: true,
                                encryptionMetadata: localFile.encryptionMetadata,
                                userId: effectiveUid,
                            });
                            if (inbound.status === "decrypted") {
                                incomingContent = inbound.content;
                            } else {
                                console.error("[Orchestrator] Cross-tab decryption failed (LUGX-048):", inbound.error);
                                return;
                            }
                        } catch (decErr) {
                            console.warn("[Orchestrator] Cross-tab decryption error (LUGX-048):", decErr);
                            return;
                        }
                    }

                    editorContentRef.current = incomingContent;
                    isProgrammaticUpdateRef.current = true;
                    try {
                        adapterRef.current?.setValue(incomingContent);
                    } finally {
                        isProgrammaticUpdateRef.current = false;
                    }
                } else if (isLocalDirty) {
                    console.warn("[Orchestrator] Sibling tab saved file while local tab is dirty. Retaining local expectedVersion for optimistic conflict guard.");
                }
            }
        });

        return () => {
            unsubscribe();
        };
    }, [fileId, syncHook, handleVaultUnlocked, resolveEffectiveUserId]);

    // Navigation & Unload Guard
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (autosave.isDirty || aiStream.isCommitting || isSaving || aiStream.status === "preview_ready") {
                e.preventDefault();
                e.returnValue = "لديك تعديلات غير محفوظة، هل أنت متأكد من مغادرة الصفحة؟";
                return e.returnValue;
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", handleBeforeUnload);
        };
    }, [autosave.isDirty, aiStream.isCommitting, isSaving, aiStream.status]);

    // Tab visibility & focus auto-healing for local IndexedDB durability
    useEffect(() => {
        const handleWakeup = async () => {
            if (
                typeof document !== "undefined" &&
                document.visibilityState === "visible" &&
                pendingLocalSyncRef.current &&
                syncHookRef.current?.isInitialized &&
                adapterRef.current
            ) {
                // Synchronously consume flag before await to eliminate dual-event burst race conditions (visibilitychange + focus)
                pendingLocalSyncRef.current = false;
                console.log("[Orchestrator] Tab became active; retrying pending local IndexedDB persistence...");
                try {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: adapterRef.current.getValue(),
                        title,
                        version: fileVersionRef.current,
                        etag: fileEtagRef.current || "",
                        isDirty: isDirtyRef.current,
                    });
                    console.log("[Orchestrator] Pending local IndexedDB persistence recovered successfully on wakeup.");
                } catch (err) {
                    console.error("[Orchestrator] Wakeup retry of local IndexedDB persistence failed:", err);
                    // Revert flag on failure so subsequent wakeup or focus can retry
                    pendingLocalSyncRef.current = true;
                }
            }
        };

        window.addEventListener("visibilitychange", handleWakeup);
        window.addEventListener("focus", handleWakeup);
        return () => {
            window.removeEventListener("visibilitychange", handleWakeup);
            window.removeEventListener("focus", handleWakeup);
        };
    }, [fileId, title]);

    // AI Operation Trigger
    const startAIOperation = useCallback(
        async (operation: AIOperationType) => {
            if (!adapterRef.current) return;

            // Zero-Knowledge AI Gatekeeper: block AI operations on encrypted files if user has not opted-in
            if (isEncryptedRef.current && !allowAIOnEncryptedFilesRef.current) {
                console.warn("[Orchestrator] AI operations are prohibited on encrypted files by vault privacy policy");
                return;
            }

            // Invariant: cancel any pending auto-save before launching AI stream
            autosave.cancelAutosave();

            await aiStream.startStream({
                editor: adapterRef.current,
                operation,
                fileId,
                expectedVersion: fileVersionRef.current,
                originalEtag: fileEtagRef.current,
                editorGeneration: editorGenerationRef.current,
            });
        },
        [aiStream, fileId, autosave]
    );

    // Conflict Resolution Handler
    const handleResolveConflict = useCallback(
        async (resolution: ConflictResolutionPayload) => {
            if (!activeConflict) return;

            setIsResolvingConflict(true);
            isResolvingConflictRef.current = true;
            setError(null);

            try {
                if (resolution.strategy === "delete") {
                    if (confirm("هل أنت متأكد من تأكيد حذف الملف؟")) {
                        await deleteFile(fileId);
                        if (onNavigate) onNavigate("/workspace");
                    }
                    setIsResolvingConflict(false);
                    isResolvingConflictRef.current = false;
                    return;
                }

                let contentToSend = resolution.content;
                let metaToSend = fileEncryptionMetadataRef.current;

                if (isEncryptedRef.current) {
                    const masterKey = sessionKeyStore.getMasterKeyRaw();
                    if (!masterKey) {
                        setError("الخزنة مقفلة. يرجى فتح الخزنة لحفظ حل التعارض المشفر بأمان.");
                        setIsResolvingConflict(false);
                        isResolvingConflictRef.current = false;
                        return;
                    }
                    const effectiveUid = await resolveEffectiveUserId();
                    buildFileAAD(effectiveUid, fileId);
                    const encResult = await SyncCryptoGateway.encryptOutbound(
                        fileId,
                        resolution.content,
                        effectiveUid
                    );
                    contentToSend = encResult.ciphertextBase64;
                    metaToSend = encResult.encryptionMetadata;
                    fileEncryptionMetadataRef.current = metaToSend;
                }

                const targetExpectedVersion = activeConflict.serverVersion.version;
                const targetExpectedETag = activeConflict.serverVersion.etag || undefined;

                const saveRes = isEncryptedRef.current
                    ? await toggleFileEncryption(fileId, true, contentToSend, metaToSend, {
                          expectedVersion: targetExpectedVersion,
                          expectedETag: targetExpectedETag,
                      })
                    : await updateFileContent(fileId, contentToSend, {
                          expectedVersion: targetExpectedVersion,
                          expectedETag: targetExpectedETag,
                      });

                if (saveRes.success && saveRes.version) {
                    fileVersionRef.current = saveRes.version;
                    setServerVersion(saveRes.version);
                    fileEtagRef.current = saveRes.etag || null;
                    setServerEtag(saveRes.etag || null);
                    editorGenerationRef.current += 1;
                    editorContentRef.current = resolution.content;

                    isProgrammaticUpdateRef.current = true;
                    try {
                        adapterRef.current?.setValue(resolution.content);
                    } finally {
                        isProgrammaticUpdateRef.current = false;
                    }

                    autosaveRef.current?.cancelAutosave();

                    if (resolution.title && resolution.title !== title) {
                        setTitle(resolution.title);
                        await renameFile(fileId, resolution.title);
                    }

                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: isEncryptedRef.current ? contentToSend : resolution.content,
                            title: resolution.title || title,
                            version: saveRes.version,
                            etag: saveRes.etag || fileEtagRef.current || "",
                            isEncrypted: isEncryptedRef.current,
                            encryptionMetadata: metaToSend,
                            isDirty: false,
                        });
                    }

                    setLastSaved(new Date());
                    autosaveRef.current?.markClean();

                    broadcastCrossTabEvent({
                        type: "conflict_resolved",
                        fileId,
                        version: saveRes.version,
                        etag: saveRes.etag || undefined,
                    });

                    activeConflictRef.current = null;
                    setActiveConflict(null);
                    setIsConflictDialogOpen(false);
                } else if (saveRes.status === "conflict" && saveRes.serverVersion) {
                    let newServerContent = saveRes.serverVersion.content || "";
                    if (isEncryptedRef.current || saveRes.serverVersion.isEncrypted) {
                        const effectiveUid = await resolveEffectiveUserId();
                        buildFileAAD(effectiveUid, fileId);
                        const inbound = await SyncCryptoGateway.decryptInbound({
                            fileId,
                            content: newServerContent,
                            isEncrypted: true,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                            userId: effectiveUid,
                        });
                        if (inbound.status === "decrypted") {
                            newServerContent = inbound.content;
                        }
                    }

                    const updatedConflict: SyncConflict = {
                        ...activeConflict,
                        serverVersion: {
                            content: newServerContent,
                            etag: saveRes.serverVersion.etag || "",
                            lastModified: saveRes.serverVersion.updatedAt
                                ? new Date(saveRes.serverVersion.updatedAt).getTime()
                                : Date.now(),
                            version: saveRes.serverVersion.version || 0,
                            title: activeConflict.serverVersion.title,
                            parentFolderId: activeConflict.serverVersion.parentFolderId,
                            deleted: false,
                            isEncrypted: saveRes.serverVersion.isEncrypted ?? isEncryptedRef.current,
                            encryptionMetadata: saveRes.serverVersion.encryptionMetadata || fileEncryptionMetadataRef.current,
                        },
                        detectedAt: Date.now(),
                    };
                    activeConflictRef.current = updatedConflict;
                    setActiveConflict(updatedConflict);
                    setError("حدث تعديل جديد على الخادم أثناء حل التعارض. يرجى المراجعة والتأكيد مجدداً.");
                } else {
                    setError(saveRes.error || "فشل تأكيد حفظ حل التعارض على الخادم");
                }
            } catch (err) {
                console.error("[Orchestrator] Conflict resolution error:", err);
                const detailMessage = err instanceof Error
                    ? err.message
                    : "حدث خطأ غير متوقع أثناء حل التعارض";
                setError(detailMessage);
            } finally {
                setIsResolvingConflict(false);
                isResolvingConflictRef.current = false;
            }
        },
        [activeConflict, fileId, title, syncHook, onNavigate, resolveEffectiveUserId]
    );

    // Title Change
    const handleTitleChange = useCallback(
        async (newTitle: string) => {
            setTitle(newTitle);
            await renameFile(fileId, newTitle);
        },
        [fileId]
    );

    // Delete File
    const handleDeleteFile = useCallback(async () => {
        if (confirm("Are you sure you want to delete this document?")) {
            await deleteFile(fileId);
            if (onNavigate) onNavigate("/workspace");
        }
    }, [fileId, onNavigate]);

    return {
        title,
        setTitle,
        handleTitleChange,
        handleDeleteFile,

        aiStatus: aiStream.status,
        previewText: aiStream.previewText,
        isStreaming: aiStream.isStreaming,
        isCommitting: aiStream.isCommitting,
        isAIActive: aiStream.isLoading,
        aiError: aiStream.error,
        isAIConflict: aiStream.isConflict,
        startAIOperation,
        stopAIOperation: aiStream.stopStream,
        resetAI: aiStream.reset,
        commitAIPreview: aiStream.commitPreview,
        rejectAIPreview: aiStream.rejectPreview,
        retryAIPreview: aiStream.retryPreview,

        isDirty: autosave.isDirty,
        isSaving,
        lastSaved,
        error,
        setError,

        serverVersion,
        serverEtag,

        activeConflict,
        isConflictDialogOpen,
        setIsConflictDialogOpen,
        isResolvingConflict,
        handleResolveConflict,

        writeState,
        canAutoSave: autosave.canAutoSave,
        hydration,
        syncHook,
        handleEditorChange: autosave.handleEditorChange,

        // 7. Vault State
        isEncrypted,
        allowAIOnEncryptedFiles,
        isVaultLocked,
        isUnlockModalOpen,
        setIsUnlockModalOpen,
        handleVaultUnlocked,
    };
}
