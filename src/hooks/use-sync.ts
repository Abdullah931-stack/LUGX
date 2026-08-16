"use client";

/**
 * React Hook for Sync System Integration
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    syncManager,
    SyncStatus,
    SyncResult,
    connectionDetector,
    ConnectionState,
    indexedDBManager,
    IDBFile,
    SyncConflict,
    operationsGC,
} from '@/lib/sync';

export interface UseSyncOptions {
    userId: string;
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

    const [status, setStatus] = useState<SyncStatus>('idle');
    const [connectionState, setConnectionState] = useState<ConnectionState>('unknown');
    const [isInitialized, setIsInitialized] = useState(false);
    const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);
    const [pendingCount, setPendingCount] = useState(0);

    const initializingRef = useRef(false);

    useEffect(() => {
        if (initializingRef.current) return;
        initializingRef.current = true;

        const init = async () => {
            try {
                await syncManager.init({ userId, autoSyncInterval });

                if (onConflict) {
                    syncManager.setConflictCallback(async (conflict) => {
                        const syncConflict: SyncConflict = {
                            fileId: conflict.fileId,
                            localVersion: { content: conflict.localContent, etag: conflict.localEtag, lastModified: Date.now(), version: 0 },
                            serverVersion: { content: conflict.serverContent, etag: conflict.serverEtag, lastModified: Date.now(), version: 0 },
                            operations: [],
                            detectedAt: Date.now(),
                        };
                        return onConflict(syncConflict);
                    });
                }

                operationsGC.schedule(10 * 60 * 1000);
                setIsInitialized(true);
            } catch (error) {
                console.error('[useSync] Initialization failed:', error);
            }
        };

        init();
        return () => { syncManager.destroy(); };
    }, [userId, autoSyncInterval, onConflict]);

    useEffect(() => {
        const unsubscribeStatus = syncManager.onStatusChange((newStatus) => setStatus(newStatus));
        const unsubscribeConnection = connectionDetector.onChange((state) => setConnectionState(state));
        setStatus(syncManager.getStatus());
        setConnectionState(connectionDetector.getState());
        return () => { unsubscribeStatus(); unsubscribeConnection(); };
    }, []);

    useEffect(() => {
        const updatePendingCount = async () => {
            const dirtyFiles = await indexedDBManager.getDirtyFiles();
            setPendingCount(dirtyFiles.length);
        };
        updatePendingCount();
        const interval = setInterval(updatePendingCount, 5000);
        return () => clearInterval(interval);
    }, []);

    const sync = useCallback(async (): Promise<SyncResult> => {
        const result = await syncManager.sync();
        setLastSyncResult(result);
        return result;
    }, []);

    const syncFile = useCallback(async (fileId: string): Promise<void> => {
        await syncManager.syncFile(fileId);
    }, []);

    const saveLocal = useCallback(async (file: Partial<IDBFile> & { id: string; content: string }): Promise<void> => {
        const existingFile = await indexedDBManager.getFile(file.id);
        const idbFile: IDBFile = {
            id: file.id,
            content: file.content,
            title: file.title || existingFile?.title || 'Untitled',
            etag: existingFile?.etag || '',
            version: existingFile?.version || 0,
            parentFolderId: file.parentFolderId || existingFile?.parentFolderId || null,
            isFolder: file.isFolder ?? existingFile?.isFolder ?? false,
            lastModified: Date.now(),
            lastSyncedAt: existingFile?.lastSyncedAt || 0,
            isDirty: true,
        };
        await indexedDBManager.saveFile(idbFile);
    }, []);

    const loadLocal = useCallback(async (fileId: string): Promise<IDBFile | null> => {
        return (await indexedDBManager.getFile(fileId)) || null;
    }, []);

    const markDirty = useCallback(async (fileId: string): Promise<void> => {
        await indexedDBManager.markFileDirty(fileId);
    }, []);

    return { status, connectionState, isInitialized, lastSyncResult, pendingCount, sync, syncFile, saveLocal, loadLocal, markDirty };
}
