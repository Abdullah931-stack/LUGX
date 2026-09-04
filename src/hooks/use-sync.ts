"use client";

/**
 * React Hook for Sync System Integration
 * 
 * Manages user-scoped synchronization lifecycle, clean resource teardown,
 * and reactive status integration with UI components using isolated instances.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    createSyncManager,
    SyncManager,
    SyncStatus,
    SyncResult,
    connectionDetector,
    ConnectionState,
    createIndexedDBManager,
    IndexedDBManager,
    IDBFile,
    SyncConflict,
    createOperationsGC,
    OperationsGarbageCollector,
    normalizeMarkdownSource,
    RemoteUpdateEvent,
    sessionKeyStore,
} from '@/lib/sync';

export interface UseSyncOptions {
    userId?: string | null;
    autoSyncInterval?: number;
    onConflict?: (conflict: SyncConflict) => Promise<'local' | 'server' | 'merge'>;
    onRemoteUpdate?: (event: RemoteUpdateEvent) => void;
}

export interface UseSyncReturn {
    status: SyncStatus;
    connectionState: ConnectionState;
    isInitialized: boolean;
    lastSyncResult: SyncResult | null;
    pendingCount: number;
    sync: () => Promise<SyncResult>;
    syncFile: (fileId: string) => Promise<void>;
    saveLocal: (file: Partial<IDBFile> & { id: string; content: string }) => Promise<void>;
    loadLocal: (fileId: string) => Promise<IDBFile | null>;
    markDirty: (fileId: string) => Promise<void>;
}

export function useSync(options: UseSyncOptions): UseSyncReturn {
    const { userId, autoSyncInterval = 30000, onConflict, onRemoteUpdate } = options;

    const [status, setStatus] = useState<SyncStatus>(() => (userId?.trim() ? 'idle' : 'stopped'));
    const [connectionState, setConnectionState] = useState<ConnectionState>(() => connectionDetector.getState());
    const [isInitialized, setIsInitialized] = useState(false);
    const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);
    const [pendingCount, setPendingCount] = useState(0);

    const syncManagerRef = useRef<SyncManager | null>(null);
    const idbManagerRef = useRef<IndexedDBManager | null>(null);
    const gcRef = useRef<OperationsGarbageCollector | null>(null);

    const onConflictRef = useRef(onConflict);
    useEffect(() => {
        onConflictRef.current = onConflict;
    }, [onConflict]);

    const onRemoteUpdateRef = useRef(onRemoteUpdate);
    useEffect(() => {
        onRemoteUpdateRef.current = onRemoteUpdate;
    }, [onRemoteUpdate]);

    // Unified scoped lifecycle effect
    useEffect(() => {
        const normalizedUserId = userId?.trim();

        // If no valid userId is provided, stay in stopped state with no active resources
        if (!normalizedUserId) {
            if (syncManagerRef.current) {
                syncManagerRef.current.destroy();
                syncManagerRef.current = null;
            }
            if (idbManagerRef.current) {
                idbManagerRef.current.close();
                idbManagerRef.current = null;
            }
            if (gcRef.current) {
                gcRef.current.cleanup();
                gcRef.current = null;
            }
            sessionKeyStore.purgeKeys();
            const resetTimer = setTimeout(() => {
                setStatus('stopped');
                setIsInitialized(false);
                setPendingCount(0);
            }, 0);
            return () => clearTimeout(resetTimer);
        }

        let isCancelled = false;
        let stopGC: (() => void) | undefined;
        let pendingInterval: ReturnType<typeof setInterval> | undefined;

        // Instantiate dedicated scoped instances for this user sharing the exact same IndexedDBManager
        const scopedIdb = createIndexedDBManager(normalizedUserId);
        const scopedSyncManager = createSyncManager({ userId: normalizedUserId, autoSyncInterval, idb: scopedIdb });
        const scopedGC = createOperationsGC(scopedIdb);

        idbManagerRef.current = scopedIdb;
        syncManagerRef.current = scopedSyncManager;
        gcRef.current = scopedGC;

        const initManager = async () => {
            try {
                // Initialize user-scoped IndexedDB and SyncManager
                await scopedIdb.init(normalizedUserId);
                await scopedSyncManager.init({ userId: normalizedUserId, autoSyncInterval, idb: scopedIdb });

                if (isCancelled) {
                    scopedSyncManager.destroy();
                    scopedIdb.close();
                    return;
                }

                if (onConflictRef.current) {
                    scopedSyncManager.setConflictCallback(async (conflict) => {
                        const file = await scopedIdb.getFile(conflict.fileId);
                        const syncConflict: SyncConflict = {
                            fileId: conflict.fileId,
                            localVersion: {
                                content: conflict.localContent,
                                etag: conflict.localEtag,
                                lastModified: file?.lastModified || Date.now(),
                                version: file?.version || 0,
                                title: file?.title,
                                parentFolderId: file?.parentFolderId,
                                deleted: false,
                            },
                            serverVersion: {
                                content: conflict.serverContent,
                                etag: conflict.serverEtag,
                                lastModified: conflict.serverUpdatedAt ? new Date(conflict.serverUpdatedAt).getTime() : Date.now(),
                                version: conflict.serverVersion ?? ((file?.version || 0) + 1),
                                title: file?.title,
                                parentFolderId: file?.parentFolderId,
                                deleted: false,
                            },
                            baseVersion: file?.baseSnapshot ? {
                                content: file.baseSnapshot.content,
                                etag: file.baseSnapshot.etag,
                                lastModified: file.lastSyncedAt || 0,
                                version: file.baseSnapshot.version,
                                title: file.baseSnapshot.title,
                                parentFolderId: file.baseSnapshot.parentFolderId,
                                deleted: false,
                            } : undefined,
                            operations: [],
                            detectedAt: Date.now(),
                            type: 'content',
                        };
                        return onConflictRef.current ? onConflictRef.current(syncConflict) : 'local';
                    });
                }

                // Schedule garbage collection and hold teardown handler
                stopGC = scopedGC.schedule(10 * 60 * 1000);

                // Initial pending count refresh
                const dirtyFiles = await scopedIdb.getDirtyFiles();
                if (!isCancelled) {
                    setPendingCount(dirtyFiles.length);
                    setIsInitialized(true);
                    setStatus(scopedSyncManager.getStatus());
                }

                // Periodic dirty file check
                pendingInterval = setInterval(async () => {
                    if (isCancelled) return;
                    try {
                        const updatedDirty = await scopedIdb.getDirtyFiles();
                        if (!isCancelled) {
                            setPendingCount(updatedDirty.length);
                        }
                    } catch {
                        // Suppress background poll errors
                    }
                }, 5000);

            } catch (error) {
                console.error('[useSync] Initialization failed:', error);
                if (!isCancelled) {
                    setStatus('failed');
                    setIsInitialized(false);
                }
            }
        };

        initManager();

        // Subscribe to status and connection updates
        const unsubscribeStatus = scopedSyncManager.onStatusChange((newStatus) => {
            if (!isCancelled) setStatus(newStatus);
        });

        const unsubscribeConnection = connectionDetector.onChange((state) => {
            if (!isCancelled) setConnectionState(state);
        });

        const unsubscribeRemoteUpdate = scopedSyncManager.onRemoteUpdate((event) => {
            if (!isCancelled) {
                onRemoteUpdateRef.current?.(event);
            }
        });

        return () => {
            isCancelled = true;
            unsubscribeStatus();
            unsubscribeConnection();
            unsubscribeRemoteUpdate();

            if (pendingInterval) {
                clearInterval(pendingInterval);
            }

            if (stopGC) {
                stopGC();
            }

            scopedGC.cleanup();
            scopedSyncManager.destroy();
            scopedIdb.close();
            sessionKeyStore.purgeKeys();

            if (syncManagerRef.current === scopedSyncManager) {
                syncManagerRef.current = null;
            }
            if (idbManagerRef.current === scopedIdb) {
                idbManagerRef.current = null;
            }
            if (gcRef.current === scopedGC) {
                gcRef.current = null;
            }

            setIsInitialized(false);
            setStatus('stopped');
        };
    }, [userId, autoSyncInterval]);

    const sync = useCallback(async (): Promise<SyncResult> => {
        const activeManager = syncManagerRef.current;
        if (!userId?.trim() || !isInitialized || !activeManager) {
            return {
                success: false,
                filesProcessed: 0,
                filesPushed: 0,
                filesPulled: 0,
                conflicts: [],
                errors: ['Sync not initialized or unauthenticated'],
                timestamp: Date.now(),
            };
        }
        const result = await activeManager.sync();
        setLastSyncResult(result);
        return result;
    }, [userId, isInitialized]);

    const syncFile = useCallback(async (fileId: string): Promise<void> => {
        const activeManager = syncManagerRef.current;
        if (!userId?.trim() || !isInitialized || !activeManager) return;
        await activeManager.syncFile(fileId);
    }, [userId, isInitialized]);

    const saveLocal = useCallback(async (file: Partial<IDBFile> & { id: string; content: string }): Promise<void> => {
        const activeIdb = idbManagerRef.current;
        if (!userId?.trim() || !activeIdb) return;
        const existingFile = await activeIdb.getFile(file.id);
        const normalizedContent = normalizeMarkdownSource(file.content);

        // Preserve or compute baseSnapshot before the file is edited
        let baseSnapshot = file.baseSnapshot || existingFile?.baseSnapshot;
        if (!baseSnapshot && existingFile && !existingFile.isDirty) {
            // First dirty modification on a clean file: record the pristine base snapshot
            baseSnapshot = {
                content: normalizeMarkdownSource(existingFile.content),
                etag: existingFile.etag,
                version: existingFile.version,
                title: existingFile.title,
                parentFolderId: existingFile.parentFolderId,
            };
        } else if (file.isDirty === false) {
            // Clean file: baseSnapshot matches confirmed state
            baseSnapshot = {
                content: normalizedContent,
                etag: file.etag !== undefined ? file.etag : (existingFile?.etag || ''),
                version: file.version !== undefined ? file.version : (existingFile?.version || 0),
                title: file.title || existingFile?.title || 'Untitled',
                parentFolderId: file.parentFolderId || existingFile?.parentFolderId || null,
            };
        }

        const idbFile: IDBFile = {
            id: file.id,
            content: normalizedContent,
            title: file.title || existingFile?.title || 'Untitled',
            etag: file.etag !== undefined ? file.etag : (existingFile?.etag || ''),
            version: file.version !== undefined ? file.version : (existingFile?.version || 0),
            parentFolderId: file.parentFolderId || existingFile?.parentFolderId || null,
            isFolder: file.isFolder ?? existingFile?.isFolder ?? false,
            lastModified: Date.now(),
            lastSyncedAt: file.isDirty === false ? Date.now() : (existingFile?.lastSyncedAt || 0),
            isDirty: file.isDirty !== undefined ? file.isDirty : true,
            baseSnapshot,
        };
        await activeIdb.saveFile(idbFile);

        // Record operation in IDB if file has uncommitted local edits (coalesce sequential edits)
        if (idbFile.isDirty) {
            const opId = `op_${userId}_${file.id}_${Date.now()}`;
            await activeIdb.coalesceOperation({
                id: opId,
                operationId: opId,
                userId,
                fileId: file.id,
                baseVersion: baseSnapshot?.version || existingFile?.version || 1,
                status: 'queued',
                attempts: 0,
                operationType: 'update',
                position: 0,
                content: normalizedContent,
                previousContent: baseSnapshot?.content || (existingFile ? normalizeMarkdownSource(existingFile.content) : ''),
                timestamp: Date.now(),
                synced: false,
                snapshot: baseSnapshot ? {
                    content: baseSnapshot.content,
                    etag: baseSnapshot.etag,
                    version: baseSnapshot.version,
                } : undefined,
            });
        } else {
            // When marking clean, mark all operations for this file as synced to prevent re-sync loops
            const ops = await activeIdb.getOperations(file.id);
            for (const op of ops) {
                if (!op.synced) {
                    await activeIdb.updateOperationStatus(op.id, 'synced', { synced: true });
                }
            }
        }

        const dirtyFiles = await activeIdb.getDirtyFiles();
        setPendingCount(dirtyFiles.length);
    }, [userId]);

    const loadLocal = useCallback(async (fileId: string): Promise<IDBFile | null> => {
        const activeIdb = idbManagerRef.current;
        if (!userId?.trim() || !activeIdb) return null;
        return (await activeIdb.getFile(fileId)) || null;
    }, [userId]);

    const markDirty = useCallback(async (fileId: string): Promise<void> => {
        const activeIdb = idbManagerRef.current;
        if (!userId?.trim() || !activeIdb) return;
        await activeIdb.markFileDirty(fileId);
        const dirtyFiles = await activeIdb.getDirtyFiles();
        setPendingCount(dirtyFiles.length);
    }, [userId]);

    return {
        status,
        connectionState,
        isInitialized,
        lastSyncResult,
        pendingCount,
        sync,
        syncFile,
        saveLocal,
        loadLocal,
        markDirty,
    };
}
