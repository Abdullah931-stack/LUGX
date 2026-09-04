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

import { useState, useEffect, useCallback, useRef } from "react";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { getFile, updateFileContent, renameFile, deleteFile } from "@/server/actions/file-ops";
import { debounce } from "@/lib/utils";
import { useSync, type UseSyncReturn } from "@/hooks/use-sync";
import { useAIStream } from "@/hooks/use-ai-stream";
import { AIOperationType } from "@/lib/ai/stream-handler";
import { SyncConflict } from "@/lib/sync/idb-types";
import { ConflictResolutionPayload } from "@/components/sync/conflict-dialog";
import { broadcastCrossTabEvent, subscribeCrossTabSync } from "@/lib/sync/cross-tab-sync";
import {
    classifyRemoteUpdate,
    type LocalBaseline,
} from "@/lib/sync/reconciliation";
import { AIStreamStatus } from "@/lib/ai/stream-session";
import { EDITOR_AUTOSAVE_DEBOUNCE_MS } from "@/config/editor.config";

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
    hydration: "hydrating" | "ready" | "fatal";
    syncHook: ReturnType<typeof useSync>;
    handleEditorChange: (newContent: string) => void;
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
    adapterRef.current = currentAdapter;

    // --- 1. Document State ---
    const [title, setTitle] = useState<string>("");

    // --- 2. Save & Error State ---
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [lastSaved, setLastSaved] = useState<Date | null>(null);
    const [isDirty, setIsDirty] = useState<boolean>(false);
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
    const isProgrammaticUpdateRef = useRef<boolean>(false);
    const activeConflictRef = useRef<SyncConflict | null>(null);
    const isResolvingConflictRef = useRef<boolean>(false);
    // Synchronous mirror of the dirty flag, read by the reconciliation policy at
    // decision time without waiting for a React state flush.
    const isDirtyRef = useRef<boolean>(false);
    // File-identity tracking guard: the initial load pipeline (IDB paint + background server fetch
    // + reconciliation) must run exactly once per mounted fileId.
    const loadedFileIdRef = useRef<string | null>(null);
    // HYDRATION LIFECYCLE (sync-before-write): the editor surface stays frozen
    // until the offline-first pipeline settled. 'fatal' means NOTHING could be
    // loaded from either side (server failure AND no local snapshot).
    const hydratedRef = useRef(false);
    const loadFailureRef = useRef(false);
    const [hydration, setHydration] = useState<"hydrating" | "ready" | "fatal">("hydrating");
    // SINGLE-FLIGHT guard: the initial pipeline must never fork into competing
    // getFile server-action cycles when render-scoped identities change.
    const pipelineRef = useRef<Promise<void> | null>(null);
    const markServerPersisted = useCallback((updatedAt?: string | Date | null) => {
        setLastSaved(updatedAt ? new Date(updatedAt) : new Date());
    }, []);

    // Keep active conflict ref synchronized
    useEffect(() => {
        activeConflictRef.current = activeConflict;
    }, [activeConflict]);

    // Keep dirty ref synchronized for synchronous reads during async pipelines
    useEffect(() => {
        isDirtyRef.current = isDirty;
    }, [isDirty]);

    // Keep resolving conflict ref synchronized
    useEffect(() => {
        isResolvingConflictRef.current = isResolvingConflict;
    }, [isResolvingConflict]);

    // --- Sync Hook Integration ---
    const syncHookRef = useRef<UseSyncReturn | null>(null);
    const pendingLocalSyncRef = useRef<boolean>(false);

    const handleSyncConflict = useCallback(
        async (conflict: SyncConflict): Promise<"local" | "server" | "merge"> => {
            // Auto-resolve if identical
            if (
                conflict.localVersion.content === conflict.serverVersion.content ||
                (conflict.localVersion.etag &&
                    conflict.serverVersion.etag &&
                    conflict.localVersion.etag === conflict.serverVersion.etag)
            ) {
                console.log("[Orchestrator] Auto-resolving identical conflict without modal");
                if (syncHookRef.current?.isInitialized) {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: conflict.serverVersion.content,
                        version: conflict.serverVersion.version,
                        etag: conflict.serverVersion.etag,
                        isDirty: false,
                    });
                }
                fileVersionRef.current = conflict.serverVersion.version;
                setServerVersion(conflict.serverVersion.version);
                if (conflict.serverVersion.etag) {
                    fileEtagRef.current = conflict.serverVersion.etag;
                    setServerEtag(conflict.serverVersion.etag);
                }
                return "server";
            }

            activeConflictRef.current = conflict;
            setActiveConflict(conflict);
            setIsConflictDialogOpen(true);
            return "server";
        },
        [fileId]
    );

    // --- AI Stream Hook Integration ---
    const aiStream = useAIStream({
        onCommitSuccess: async ({ version, etag }) => {
            fileVersionRef.current = version;
            setServerVersion(version);
            fileEtagRef.current = etag;
            setServerEtag(etag);
            editorGenerationRef.current += 1;
            setLastSaved(new Date());

            if (syncHookRef.current?.isInitialized && adapterRef.current) {
                try {
                    await syncHookRef.current.saveLocal({
                        id: fileId,
                        content: adapterRef.current.getValue(),
                        title,
                        version,
                        etag: etag || "",
                        isDirty: false,
                    });
                    pendingLocalSyncRef.current = false;
                    setIsDirty(false);
                } catch (saveErr) {
                    console.error("[Orchestrator] Post-commit local IndexedDB save error:", saveErr);
                    // Defensive durability: retain dirty flag and schedule retry on tab wakeup
                    pendingLocalSyncRef.current = true;
                    setIsDirty(true);
                }
            } else {
                setIsDirty(false);
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
        async (event: {
            fileId: string;
            content: string;
            etag: string;
            version: number;
            title?: string;
            parentFolderId?: string | null;
            updatedAt: string;
        }) => {
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
                return;
            }

            const currentLocalContent = adapterRef.current?.getValue() ?? "";
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
                remoteContent: event.content,
            });

            if (decision.action === "apply") {
                // Generation guard: apply remote update cleanly without disrupting user
                fileVersionRef.current = event.version;
                setServerVersion(event.version);
                fileEtagRef.current = event.etag;
                setServerEtag(event.etag);
                editorGenerationRef.current += 1;

                const prevSelection = adapterRef.current?.getSelection();
                const hadFocus = adapterRef.current?.hasFocus() ?? false;

                isProgrammaticUpdateRef.current = true;
                try {
                    adapterRef.current?.setValue(event.content);
                    if (prevSelection && hadFocus) {
                        const maxLen = event.content.length;
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
                setIsDirty(false);
            } else if (decision.action === "adopt_metadata") {
                fileVersionRef.current = event.version;
                setServerVersion(event.version);
                fileEtagRef.current = event.etag;
                setServerEtag(event.etag);
                markServerPersisted(event.updatedAt);
            } else if (decision.action === "keep_local") {
                console.log(
                    `[Orchestrator] Remote update retained locally (reason: ${decision.reason}). Local edits preserved.`
                );
            }
        },
        [fileId, title, aiStream.isLoading, aiStream.isStreaming, aiStream.isCommitting, aiStream.status, markServerPersisted]
    );

    const syncHook = useSync({
        userId: userId || "",
        autoSyncInterval: 30000,
        onConflict: handleSyncConflict,
        onRemoteUpdate: handleRemoteUpdate,
    });
    syncHookRef.current = syncHook;

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
     * AutoSave Suspension Invariants Gate (Rule: Phase 9 Step 2)
     * AutoSave MUST NOT run during:
     * - streaming / reserving
     * - preview_ready (completed AI output awaiting an explicit user decision)
     * - committing
     * - conflict (active unresolved conflict)
     * - stopped (sync stopped)
     * - programmatic updates (setValue from server / DB / conflict resolution)
     */
    const canAutoSave = useCallback((): boolean => {
        if (isProgrammaticUpdateRef.current) return false;
        if (hydratedRef.current !== true) return false;
        if (aiStream.isLoading || aiStream.isStreaming || aiStream.isCommitting) return false;
        if (
            aiStream.status === "reserved" ||
            aiStream.status === "streaming" ||
            aiStream.status === "preview_ready" ||
            aiStream.status === "committing"
        ) {
            return false;
        }
        if (activeConflictRef.current !== null) return false;
        if (isResolvingConflictRef.current) return false;
        if (syncHook.status === "stopped") return false;
        return true;
    }, [aiStream.isLoading, aiStream.isStreaming, aiStream.isCommitting, aiStream.status, syncHook.status]);

    /**
     * Centralized Server Write with ETag & Version Precondition Guard
     */
    const executeServerWrite = useCallback(
        async (content: string) => {
            if (!hydratedRef.current) {
                console.log("[Orchestrator] Auto-save deferred: hydration not complete.");
                return;
            }
            if (!canAutoSave()) {
                console.log("[Orchestrator] Auto-save skipped due to active suspension gate invariant");
                return;
            }

            setIsSaving(true);

            try {
                const saveRes = await updateFileContent(fileId, content, {
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
                    setIsDirty(false);

                    // Broadcast cross-tab
                    broadcastCrossTabEvent({
                        type: "file_saved",
                        fileId,
                        version: saveRes.version,
                        etag: saveRes.etag || undefined,
                    });

                    // Update local storage clean
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content,
                            title,
                            version: saveRes.version,
                            etag: saveRes.etag || fileEtagRef.current || "",
                            isDirty: false,
                        });
                    }
                } else if (saveRes.status === "conflict" && saveRes.serverVersion) {
                    // False conflict check
                    if (
                        content === saveRes.serverVersion.content ||
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
                                content,
                                title,
                                version: saveRes.serverVersion.version ?? fileVersionRef.current,
                                etag: saveRes.serverVersion.etag || "",
                                isDirty: false,
                            });
                        }
                        setIsSaving(false);
                        setIsDirty(false);
                        return;
                    }

                    // True conflict (412 Precondition Failed)
                    console.warn("[Orchestrator] 412 Sync conflict detected during save:", saveRes.serverVersion);
                    const localFile = syncHook.isInitialized ? await syncHook.loadLocal(fileId) : null;
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
                        },
                        serverVersion: {
                            content: saveRes.serverVersion.content || "",
                            etag: saveRes.serverVersion.etag || "",
                            lastModified: saveRes.serverVersion.updatedAt
                                ? new Date(saveRes.serverVersion.updatedAt).getTime()
                                : Date.now(),
                            version: saveRes.serverVersion.version || 0,
                            title,
                            parentFolderId: null,
                            deleted: false,
                        },
                        baseVersion: localFile?.baseSnapshot
                            ? {
                                  content: localFile.baseSnapshot.content,
                                  etag: localFile.baseSnapshot.etag,
                                  lastModified: localFile.lastSyncedAt || 0,
                                  version: localFile.baseSnapshot.version,
                                  title: localFile.baseSnapshot.title,
                                  parentFolderId: localFile.baseSnapshot.parentFolderId,
                                  deleted: false,
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
                            content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isDirty: true,
                        });
                    }
                } else {
                    // Offline / Network failure -> save dirty locally
                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
                            isDirty: true,
                        });
                    }
                }
            } catch (saveErr) {
                console.warn("[Orchestrator] Save failed, saving dirty to IndexedDB:", saveErr);
                if (syncHook.isInitialized) {
                    try {
                        await syncHook.saveLocal({
                            id: fileId,
                            content,
                            title,
                            version: fileVersionRef.current,
                            etag: fileEtagRef.current || "",
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
        [fileId, title, canAutoSave, syncHook]
    );

    const executeServerWriteRef = useRef(executeServerWrite);
    useEffect(() => {
        executeServerWriteRef.current = executeServerWrite;
    }, [executeServerWrite]);

    const debouncedAutoSaveRef = useRef(
        debounce((content: string) => {
            executeServerWriteRef.current(content);
        }, EDITOR_AUTOSAVE_DEBOUNCE_MS)
    );

    /**
     * Manual Edit Policy:
     * - If AI stream is active:
     *   - Check if an active non-colliding ghost range is maintained via adapter.getGhostRange().
     *   - If ghost range was cleared / collided (user edited the target text directly): abort stream.
     *   - If ghost range is still valid (user edited outside the target text): keep stream active.
     * - Advance editor generation.
     * - Record dirty state and schedule debounced save.
     */
    const handleEditorChange = useCallback(
        (newContent: string) => {
            if (isProgrammaticUpdateRef.current) return;
            // Sync-before-write: drop input events until hydration completed.
            if (!hydratedRef.current) return;

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

            editorGenerationRef.current += 1;
            setIsDirty(true);
            debouncedAutoSaveRef.current(newContent);
        },
        [aiStream]
    );

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

            try {
                // Step 1: instant paint from IndexedDB (offline-first).
                if (sh?.isInitialized) {
                    const localFile = await sh.loadLocal(fileId);
                    if (!cancelled && localFile) {
                        localBaseline = {
                            version: localFile.version || 1,
                            etag: localFile.etag || null,
                            content: localFile.content || "",
                        };
                        setTitle(localFile.title);
                        fileVersionRef.current = localFile.version || 1;
                        setServerVersion(localFile.version || 1);
                        fileEtagRef.current = localFile.etag || null;
                        setServerEtag(localFile.etag || null);
                        editorGenerationRef.current += 1;

                        isProgrammaticUpdateRef.current = true;
                        try {
                            adapterRef.current?.setValue(localFile.content || "");
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
                    setTitle(data.title);
                    const remoteVersion = data.version ?? 1;
                    const remoteEtag = data.etag ?? null;
                    const safeContent = data.content || "";

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
                                content: safeContent,
                                title: data.title,
                                version: remoteVersion,
                                etag: remoteEtag || "",
                                isDirty: false,
                            });
                        }
                    };

                    switch (decision.action) {
                        case "bootstrap_server": {
                            adoptAnchors();
                            paintServer();
                            markServerPersisted(data.updatedAt);
                            setIsDirty(false);
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

    // Cross-tab synchronization listener
    useEffect(() => {
        const unsubscribe = subscribeCrossTabSync(async (event) => {
            if (event.fileId === fileId) {
                const localFile = syncHook.isInitialized ? await syncHook.loadLocal(fileId) : null;
                const isLocalDirty = localFile?.isDirty || activeConflictRef.current !== null || isDirty;

                if (!isLocalDirty) {
                    if (event.version && event.version > fileVersionRef.current) {
                        fileVersionRef.current = event.version;
                        setServerVersion(event.version);
                    }
                    if (event.etag) {
                        fileEtagRef.current = event.etag;
                        setServerEtag(event.etag);
                    }
                } else {
                    console.warn("[Orchestrator] Sibling tab saved file while local tab is dirty. Retaining local expectedVersion for optimistic conflict guard.");
                }
            }
        });

        return () => {
            unsubscribe();
        };
    }, [fileId, isDirty, syncHook]);

    // Navigation & Unload Guard
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (isDirty || aiStream.isCommitting || isSaving || aiStream.status === "preview_ready") {
                e.preventDefault();
                e.returnValue = "لديك تعديلات غير محفوظة، هل أنت متأكد من مغادرة الصفحة؟";
                return e.returnValue;
            }
        };

        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => {
            window.removeEventListener("beforeunload", handleBeforeUnload);
        };
    }, [isDirty, aiStream.isCommitting, isSaving, aiStream.status]);

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

            // Invariant: cancel any pending auto-save before launching AI stream
            debouncedAutoSaveRef.current?.cancel?.();

            await aiStream.startStream({
                editor: adapterRef.current,
                operation,
                fileId,
                expectedVersion: fileVersionRef.current,
                originalEtag: fileEtagRef.current,
                editorGeneration: editorGenerationRef.current,
            });
        },
        [aiStream, fileId]
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

                const targetExpectedVersion = activeConflict.serverVersion.version;
                const targetExpectedETag = activeConflict.serverVersion.etag || undefined;

                const saveRes = await updateFileContent(fileId, resolution.content, {
                    expectedVersion: targetExpectedVersion,
                    expectedETag: targetExpectedETag,
                });

                if (saveRes.success && saveRes.version) {
                    fileVersionRef.current = saveRes.version;
                    setServerVersion(saveRes.version);
                    fileEtagRef.current = saveRes.etag || null;
                    setServerEtag(saveRes.etag || null);
                    editorGenerationRef.current += 1;

                    isProgrammaticUpdateRef.current = true;
                    try {
                        adapterRef.current?.setValue(resolution.content);
                    } finally {
                        isProgrammaticUpdateRef.current = false;
                    }

                    if (resolution.title && resolution.title !== title) {
                        setTitle(resolution.title);
                        await renameFile(fileId, resolution.title);
                    }

                    if (syncHook.isInitialized) {
                        await syncHook.saveLocal({
                            id: fileId,
                            content: resolution.content,
                            title: resolution.title || title,
                            version: saveRes.version,
                            etag: saveRes.etag || fileEtagRef.current || "",
                            isDirty: false,
                        });
                    }

                    setLastSaved(new Date());
                    setIsDirty(false);

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
                    const updatedConflict: SyncConflict = {
                        ...activeConflict,
                        serverVersion: {
                            content: saveRes.serverVersion.content || "",
                            etag: saveRes.serverVersion.etag || "",
                            lastModified: saveRes.serverVersion.updatedAt
                                ? new Date(saveRes.serverVersion.updatedAt).getTime()
                                : Date.now(),
                            version: saveRes.serverVersion.version || 0,
                            title: activeConflict.serverVersion.title,
                            parentFolderId: activeConflict.serverVersion.parentFolderId,
                            deleted: false,
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
        [activeConflict, fileId, title, syncHook, onNavigate]
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

        isDirty,
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
        canAutoSave,
        hydration,
        syncHook,
        handleEditorChange,
    };
}
