/**
 * Sync Manager
 * 
 * Core synchronization orchestrator that coordinates all sync operations.
 * Handles pull/push operations, queue management, and sync state tracking.
 */

import { indexedDBManager } from './indexeddb';
import { IDBFile, IDBSyncMetadata, SyncQueueItem } from './idb-types';
import { connectionDetector, withBackoff } from './connection-detector';
import { concurrencyManager } from './concurrency-manager';
import { syncRollback } from './rollback';
import { syncErrorHandler, SyncErrorType } from './error-handler';
import { compareETags } from './etag-generator';

/**
 * Sync status
 */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * Sync result for a single file
 */
export interface FileSyncResult {
    fileId: string;
    success: boolean;
    action: 'pushed' | 'pulled' | 'conflict' | 'skipped';
    error?: string;
    newEtag?: string;
}

/**
 * Full sync result
 */
export interface SyncResult {
    success: boolean;
    filesProcessed: number;
    filesPushed: number;
    filesPulled: number;
    conflicts: string[];
    errors: string[];
    timestamp: number;
}

/**
 * Sync status callback
 */
export type SyncStatusCallback = (status: SyncStatus, progress?: number) => void;

/**
 * Conflict callback for UI integration
 */
export type ConflictCallback = (conflict: {
    fileId: string;
    localContent: string;
    serverContent: string;
    localEtag: string;
    serverEtag: string;
}) => Promise<'local' | 'server' | 'merge'>;

/**
 * Sync Manager Configuration
 */
export interface SyncManagerConfig {
    /** User ID for sync metadata */
    userId: string;
    /** Base URL for API calls */
    apiBaseUrl?: string;
    /** Auto-sync interval in milliseconds (0 to disable) */
    autoSyncInterval?: number;
    /** Maximum retries for failed syncs */
    maxRetries?: number;
}

/**
 * Sync Manager Class
 * Singleton that manages all synchronization operations
 */
class SyncManager {
    private status: SyncStatus = 'idle';
    private statusCallbacks: Set<SyncStatusCallback> = new Set();
    private conflictCallback?: ConflictCallback;
    private syncQueue: SyncQueueItem[] = [];
    private autoSyncTimer?: ReturnType<typeof setInterval>;
    private config: SyncManagerConfig | null = null;
    private initialized = false;

    /**
     * Initialize the sync manager
     */
    async init(config: SyncManagerConfig): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.config = config;

        // Initialize IndexedDB
        await indexedDBManager.init();

        // Initialize connection detector
        connectionDetector.init();

        // Listen for connection changes
        connectionDetector.onChange((state) => {
            if (state === 'online' && this.status === 'offline') {
                console.log('[SyncManager] Back online, triggering sync');
                this.sync();
            } else if (state === 'offline') {
                this.setStatus('offline');
            }
        });

        // Set initial status based on connection
        if (!connectionDetector.isOnline()) {
            this.setStatus('offline');
        }

        // Start auto-sync if configured
        if (config.autoSyncInterval && config.autoSyncInterval > 0) {
            this.startAutoSync(config.autoSyncInterval);
        }

        this.initialized = true;
        console.log('[SyncManager] Initialized');
    }

    /**
     * Destroy the sync manager
     */
    destroy(): void {
        this.stopAutoSync();
        connectionDetector.destroy();
        this.statusCallbacks.clear();
        this.syncQueue = [];
        this.initialized = false;
    }

    /**
     * Set conflict callback for UI integration
     */
    setConflictCallback(callback: ConflictCallback): void {
        this.conflictCallback = callback;
    }

    /**
     * Update sync status and notify callbacks
     */
    private setStatus(status: SyncStatus, progress?: number): void {
        this.status = status;
        for (const callback of this.statusCallbacks) {
            try {
                callback(status, progress);
            } catch (error) {
                console.error('[SyncManager] Status callback error:', error);
            }
        }
    }

    /**
     * Get current sync status
     */
    getStatus(): SyncStatus {
        return this.status;
    }

    /**
     * Register status change callback
     */
    onStatusChange(callback: SyncStatusCallback): () => void {
        this.statusCallbacks.add(callback);
        return () => this.statusCallbacks.delete(callback);
    }

    /**
     * Start auto-sync timer
     */
    private startAutoSync(intervalMs: number): void {
        this.stopAutoSync();
        this.autoSyncTimer = setInterval(() => {
            if (connectionDetector.isOnline() && this.status === 'idle') {
                this.sync();
            }
        }, intervalMs);
    }

    /**
     * Stop auto-sync timer
     */
    private stopAutoSync(): void {
        if (this.autoSyncTimer) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = undefined;
        }
    }

    /**
     * Perform full sync (push + pull)
     */
    async sync(): Promise<SyncResult> {
        if (!this.config) {
            throw new Error('SyncManager not initialized');
        }

        if (this.status === 'syncing') {
            console.log('[SyncManager] Sync already in progress');
            return {
                success: false,
                filesProcessed: 0,
                filesPushed: 0,
                filesPulled: 0,
                conflicts: [],
                errors: ['Sync already in progress'],
                timestamp: Date.now(),
            };
        }

        if (!connectionDetector.isOnline()) {
            this.setStatus('offline');
            return {
                success: false,
                filesProcessed: 0,
                filesPushed: 0,
                filesPulled: 0,
                conflicts: [],
                errors: ['Offline'],
                timestamp: Date.now(),
            };
        }

        this.setStatus('syncing', 0);

        const result: SyncResult = {
            success: true,
            filesProcessed: 0,
            filesPushed: 0,
            filesPulled: 0,
            conflicts: [],
            errors: [],
            timestamp: Date.now(),
        };

        try {
            // Step 1: Push dirty files
            const pushResult = await this.pushDirtyFiles();
            result.filesPushed = pushResult.pushed;
            result.conflicts.push(...pushResult.conflicts);
            result.errors.push(...pushResult.errors);

            // Step 2: Pull updates from server
            const pullResult = await this.pullUpdates();
            result.filesPulled = pullResult.pulled;
            result.conflicts.push(...pullResult.conflicts);
            result.errors.push(...pullResult.errors);

            result.filesProcessed = result.filesPushed + result.filesPulled;
            result.success = result.errors.length === 0;

            // Update last synced timestamp
            await indexedDBManager.updateLastSyncedAt(this.config.userId);

            this.setStatus('idle');
            console.log('[SyncManager] Sync complete:', result);

        } catch (error) {
            const syncError = syncErrorHandler.fromException(error, 'Full sync');
            await syncErrorHandler.handle(syncError);

            result.success = false;
            result.errors.push(syncError.message);

            this.setStatus(syncError.type === SyncErrorType.NETWORK_ERROR ? 'offline' : 'error');
        }

        return result;
    }

    /**
     * Push all dirty files to server
     */
    private async pushDirtyFiles(): Promise<{
        pushed: number;
        conflicts: string[];
        errors: string[];
    }> {
        const result = { pushed: 0, conflicts: [] as string[], errors: [] as string[] };

        const dirtyFiles = await indexedDBManager.getDirtyFiles();
        console.log(`[SyncManager] Pushing ${dirtyFiles.length} dirty files`);

        for (const file of dirtyFiles) {
            const fileResult = await this.pushFile(file);

            if (fileResult.success) {
                result.pushed++;
            } else if (fileResult.action === 'conflict') {
                result.conflicts.push(file.id);
            } else if (fileResult.error) {
                result.errors.push(`${file.id}: ${fileResult.error}`);
            }
        }

        return result;
    }

    /**
     * Push a single file to server
     */
    private async pushFile(file: IDBFile): Promise<FileSyncResult> {
        return concurrencyManager.withLock(file.id, async () => {
            // Create checkpoint before sync
            const checkpointId = await syncRollback.createCheckpoint(file.id, 'pre_sync');

            try {
                const response = await withBackoff(async () => {
                    return fetch(`/api/files/${file.id}`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'If-Match': `"${file.etag}"`,
                        },
                        body: JSON.stringify({
                            content: file.content,
                            title: file.title,
                        }),
                    });
                }, 3);

                if (response.status === 412) {
                    // Conflict detected
                    const serverData = await response.json();
                    await this.handleConflict(file, serverData.serverVersion);

                    return {
                        fileId: file.id,
                        success: false,
                        action: 'conflict' as const,
                    };
                }

                if (!response.ok) {
                    throw new Error(`Push failed: ${response.status}`);
                }

                const data = await response.json();

                // Mark file as clean with new ETag
                await indexedDBManager.markFileClean(file.id, data.etag);

                // Remove checkpoint
                syncRollback.removeCheckpoint(checkpointId);

                return {
                    fileId: file.id,
                    success: true,
                    action: 'pushed' as const,
                    newEtag: data.etag,
                };

            } catch (error) {
                // Rollback on error
                await syncRollback.rollback(checkpointId);

                return {
                    fileId: file.id,
                    success: false,
                    action: 'skipped' as const,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        });
    }

    /**
     * Pull updates from server
     */
    private async pullUpdates(): Promise<{
        pulled: number;
        conflicts: string[];
        errors: string[];
    }> {
        const result = { pulled: 0, conflicts: [] as string[], errors: [] as string[] };

        if (!this.config) return result;

        // Get last sync timestamp
        const metadata = await indexedDBManager.getSyncMetadata(this.config.userId);
        const lastSyncedAt = metadata?.lastSyncedAt
            ? new Date(metadata.lastSyncedAt).toISOString()
            : undefined;

        try {
            let hasMore = true;
            let cursor: string | undefined;

            while (hasMore) {
                const url = new URL('/api/files/sync', window.location.origin);
                if (lastSyncedAt) url.searchParams.set('updated_after', lastSyncedAt);
                if (cursor) url.searchParams.set('cursor', cursor);
                url.searchParams.set('limit', '50');

                const response = await withBackoff(async () => {
                    return fetch(url.toString());
                }, 3);

                if (!response.ok) {
                    throw new Error(`Pull failed: ${response.status}`);
                }

                const data = await response.json();

                // Process each file
                for (const serverFile of data.files) {
                    const pullResult = await this.pullFile(serverFile);

                    if (pullResult.success && pullResult.action === 'pulled') {
                        result.pulled++;
                    } else if (pullResult.action === 'conflict') {
                        result.conflicts.push(serverFile.id);
                    }
                }

                hasMore = data.has_more;
                cursor = data.next_cursor;
            }

        } catch (error) {
            result.errors.push(error instanceof Error ? error.message : 'Pull failed');
        }

        return result;
    }

    /**
     * Pull and merge a single file from server
     */
    private async pullFile(serverFile: {
        id: string;
        content: string;
        etag: string;
        version: number;
        title: string;
        parentFolderId: string | null;
        isFolder: boolean;
        updatedAt: string;
    }): Promise<FileSyncResult> {
        const localFile = await indexedDBManager.getFile(serverFile.id);

        // New file from server
        if (!localFile) {
            const newFile: IDBFile = {
                id: serverFile.id,
                content: serverFile.content,
                etag: serverFile.etag,
                version: serverFile.version,
                title: serverFile.title,
                parentFolderId: serverFile.parentFolderId,
                isFolder: serverFile.isFolder,
                lastModified: new Date(serverFile.updatedAt).getTime(),
                lastSyncedAt: Date.now(),
                isDirty: false,
            };
            await indexedDBManager.saveFile(newFile);

            return { fileId: serverFile.id, success: true, action: 'pulled' };
        }

        // Check if server has newer version
        if (compareETags(localFile.etag, serverFile.etag)) {
            // Same version, skip
            return { fileId: serverFile.id, success: true, action: 'skipped' };
        }

        // Local file is dirty - conflict
        if (localFile.isDirty) {
            await this.handleConflict(localFile, {
                content: serverFile.content,
                etag: serverFile.etag,
                version: serverFile.version,
                updatedAt: serverFile.updatedAt,
            });

            return { fileId: serverFile.id, success: false, action: 'conflict' };
        }

        // Safe to update local file
        const updatedFile: IDBFile = {
            ...localFile,
            content: serverFile.content,
            etag: serverFile.etag,
            version: serverFile.version,
            title: serverFile.title,
            lastModified: new Date(serverFile.updatedAt).getTime(),
            lastSyncedAt: Date.now(),
            isDirty: false,
        };
        await indexedDBManager.saveFile(updatedFile);

        return { fileId: serverFile.id, success: true, action: 'pulled', newEtag: serverFile.etag };
    }

    /**
     * Handle conflict between local and server versions
     */
    private async handleConflict(
        localFile: IDBFile,
        serverVersion: { content: string; etag: string; version: number; updatedAt: string }
    ): Promise<void> {
        console.log(`[SyncManager] Conflict detected for file ${localFile.id}`);

        if (this.conflictCallback) {
            const resolution = await this.conflictCallback({
                fileId: localFile.id,
                localContent: localFile.content,
                serverContent: serverVersion.content,
                localEtag: localFile.etag,
                serverEtag: serverVersion.etag,
            });

            if (resolution === 'local') {
                // Keep local, force push
                localFile.etag = serverVersion.etag; // Use server etag to avoid conflict
                await indexedDBManager.saveFile(localFile);
                await this.pushFile(localFile);
            } else if (resolution === 'server') {
                // Accept server version
                const updatedFile: IDBFile = {
                    ...localFile,
                    content: serverVersion.content,
                    etag: serverVersion.etag,
                    version: serverVersion.version,
                    lastSyncedAt: Date.now(),
                    isDirty: false,
                };
                await indexedDBManager.saveFile(updatedFile);
            }
            // 'merge' case should be handled by the conflict dialog
        }
    }

    /**
     * Queue a file for sync with priority
     */
    queueSync(fileId: string, priority: 1 | 2 | 3 = 2): void {
        // Remove if already in queue
        this.syncQueue = this.syncQueue.filter(item => item.fileId !== fileId);

        // Add with priority
        this.syncQueue.push({
            fileId,
            priority,
            addedAt: Date.now(),
            retryCount: 0,
        });

        // Sort by priority
        this.syncQueue.sort((a, b) => a.priority - b.priority);
    }

    /**
     * Force sync a specific file immediately
     */
    async syncFile(fileId: string): Promise<FileSyncResult> {
        const file = await indexedDBManager.getFile(fileId);
        if (!file) {
            return { fileId, success: false, action: 'skipped', error: 'File not found' };
        }

        if (file.isDirty) {
            return this.pushFile(file);
        }

        return { fileId, success: true, action: 'skipped' };
    }
}

// Export singleton instance
export const syncManager = new SyncManager();

// Export class for testing
export { SyncManager };
