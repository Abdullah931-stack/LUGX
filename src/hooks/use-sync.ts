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
} from '@/lib/sync';

export interface UseSyncOptions {
    userId?: string | null;
    autoSyncInterval?: number;
    onConflict?: (conflict: SyncConflict) => Promise<'local' | 'server' | 'merge'>;
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
    const { userId, autoSyncInterval = 30000, onConflict } = options;

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
            setStatus('stopped');
            setIsInitialized(false);
            setPendingCount(0);
            return;
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
                        const syncConflict: SyncConflict = {
                            fileId: conflict.fileId,
                            localVersion: {
                                content: conflict.localContent,
                                etag: conflict.localEtag,
                                lastModified: Date.now(),
                                version: 0,
                            },
                            serverVersion: {
                                content: conflict.serverContent,
                                etag: conflict.serverEtag,
                                lastModified: Date.now(),
                                version: 0,
                            },
                            operations: [],
                            detectedAt: Date.now(),
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

        return () => {
            isCancelled = true;
            unsubscribeStatus();
            unsubscribeConnection();

            if (pendingInterval) {
                clearInterval(pendingInterval);
            }

            if (stopGC) {
                stopGC();
            }

            scopedGC.cleanup();
            scopedSyncManager.destroy();
            scopedIdb.close();

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
        const idbFile: IDBFile = {
            id: file.id,
            content: file.content,
            title: file.title || existingFile?.title || 'Untitled',
            etag: file.etag !== undefined ? file.etag : (existingFile?.etag || ''),
            version: file.version !== undefined ? file.version : (existingFile?.version || 0),
            parentFolderId: file.parentFolderId || existingFile?.parentFolderId || null,
            isFolder: file.isFolder ?? existingFile?.isFolder ?? false,
            lastModified: Date.now(),
            lastSyncedAt: existingFile?.lastSyncedAt || 0,
            isDirty: file.isDirty !== undefined ? file.isDirty : true,
        };
        await activeIdb.saveFile(idbFile);
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
