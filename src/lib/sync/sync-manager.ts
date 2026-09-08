/**
 * Sync Manager
 * 
 * Core synchronization orchestrator that coordinates all sync operations.
 * Scoped strictly per user identity and workspace context with deterministic lifecycle teardown.
 */

import { indexedDBManager, createIndexedDBManager, IndexedDBManager } from './indexeddb';
import { IDBFile, IDBOperation, SyncQueueItem, EncryptedEnvelopeMetadata } from './idb-types';
import { connectionDetector, withBackoff } from './connection-detector';
import { concurrencyManager } from './concurrency-manager';
import { syncRollback, createSyncRollback, SyncRollback } from './rollback';
import { syncErrorHandler, SyncErrorType, isRetryableError } from './error-handler';
import { compareETags, generateEncryptedETagSync } from './etag-generator';
import { runWithConcurrency, DEFAULT_PUSH_CONCURRENCY } from './parallel';
import { sessionKeyStore } from './session-key-store';
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from './crypto-worker-bridge';
import { validateMarkdownSyntaxIntegrity } from './syntax-validator';
import { conflictResolver } from './conflict-resolver';
import { SyncCryptoGateway } from './sync-crypto-gateway';
import type { PendingEncryptedConflict } from './types/vault';

/**
 * Explicit Sync status states
 */
export type SyncStatus =
    | 'idle'
    | 'loading'
    | 'queued'
    | 'syncing'
    | 'conflict'
    | 'failed'
    | 'stopped'
    | 'offline';

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
 * Remote update event payload emitted when a newer server version is pulled cleanly
 */
export interface RemoteUpdateEvent {
    fileId: string;
    content: string;
    etag: string;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}

/**
 * Remote update callback
 */
export type RemoteUpdateCallback = (event: RemoteUpdateEvent) => void;

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
    serverVersion?: number;
    serverUpdatedAt?: string;
    isEncrypted?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}) => Promise<'local' | 'server' | 'merge'>;

/**
 * Sync Manager Configuration
 */
export interface SyncManagerConfig {
    /** User ID for sync metadata (must be non-empty string) */
    userId: string;
    /** Optional specific fileId scope */
    fileId?: string;
    /** Optional workspace scope */
    workspaceId?: string;
    /** Base URL for API calls */
    apiBaseUrl?: string;
    /** Auto-sync interval in milliseconds (0 to disable) */
    autoSyncInterval?: number;
    /** Maximum retries for failed syncs */
    maxRetries?: number;
    /** Optional injected IndexedDB manager instance */
    idb?: IndexedDBManager;
    /** Enable randomized backoff jitter (defaults to false for deterministic testing) */
    enableJitter?: boolean;
}

/**
 * Sync Manager Class
 * Manages user-scoped synchronization operations and lifecycle
 */
class SyncManager {
    private status: SyncStatus = 'stopped';
    private statusCallbacks: Set<SyncStatusCallback> = new Set();
    private remoteUpdateCallbacks: Set<RemoteUpdateCallback> = new Set();
    private conflictCallback?: ConflictCallback;
    private syncQueue: SyncQueueItem[] = [];
    private autoSyncTimer?: ReturnType<typeof setInterval>;
    private config: SyncManagerConfig | null = null;
    private initialized = false;
    private isDestroyed = false;
    private idb: IndexedDBManager;
    private ownsIdb = false;
    private rollback: SyncRollback;
    private activeAbortController: AbortController | null = null;
    private isConsumerRunning = false;
    private hasPendingOnlineConsumer = false;
    private isQueueProcessing = false;
    private maxRetries = 5;
    private baseBackoffMs = 1000;
    private maxBackoffMs = 30000;
    private enableJitter = false;
    private unsubscribeConnection?: () => void;
    private unsubscribeKeyStore?: (() => void) | null;
    private pendingEncryptedConflicts: Map<string, PendingEncryptedConflict> = new Map();
    private encryptedConflictListeners: Set<(conflict: PendingEncryptedConflict) => void> = new Set();

    constructor(initialConfig?: SyncManagerConfig) {
        if (initialConfig?.idb) {
            this.idb = initialConfig.idb;
            this.ownsIdb = false;
            this.rollback = createSyncRollback(this.idb);
            if (initialConfig.userId && initialConfig.userId.trim()) {
                this.config = { ...initialConfig, userId: initialConfig.userId.trim() };
            }
        } else if (initialConfig?.userId && initialConfig.userId.trim()) {
            this.config = { ...initialConfig, userId: initialConfig.userId.trim() };
            this.idb = createIndexedDBManager(this.config.userId);
            this.ownsIdb = true;
            this.rollback = createSyncRollback(this.idb);
        } else {
            this.idb = indexedDBManager;
            this.ownsIdb = false;
            this.rollback = syncRollback;
        }
        if (initialConfig?.maxRetries) {
            this.maxRetries = initialConfig.maxRetries;
        }
        if (initialConfig?.enableJitter !== undefined) {
            this.enableJitter = initialConfig.enableJitter;
        }
    }

    /**
     * Get active scoped userId
     */
    getUserId(): string | null {
        return this.config?.userId || null;
    }

    /**
     * Initialize the sync manager with a valid, non-empty userId
     */
    async init(config: SyncManagerConfig): Promise<void> {
        if (!config || !config.userId || !config.userId.trim()) {
            this.setStatus('stopped');
            throw new Error('SyncManager requires a valid, non-empty userId');
        }

        const normalizedUserId = config.userId.trim();

        // If already initialized for the same user, do not re-run
        if (this.initialized && !this.isDestroyed && this.config?.userId === normalizedUserId) {
            return;
        }

        // If switching user, destroy previous state first
        if (this.initialized && this.config?.userId !== normalizedUserId) {
            this.destroy();
        }

        // Close previously owned internal IDB connection if being replaced
        if (this.ownsIdb && this.idb && this.idb !== config.idb && this.idb !== indexedDBManager) {
            this.idb.close();
        }

        this.isDestroyed = false;
        this.config = { ...config, userId: normalizedUserId };

        // Initialize user-scoped IndexedDB (use injected instance or create/reuse owned instance)
        if (config.idb) {
            this.idb = config.idb;
            this.ownsIdb = false;
        } else if (this.ownsIdb && this.idb && this.idb !== indexedDBManager && this.idb.getUserId?.() === normalizedUserId) {
            // Reuse existing owned instance
        } else {
            this.idb = createIndexedDBManager(this.config.userId);
            this.ownsIdb = true;
        }
        await this.idb.init(this.config.userId);
        this.rollback = createSyncRollback(this.idb);

        // Crash recovery: reset any operations stuck in 'syncing' back to 'queued'
        await this.idb.resetSyncingOperations();

        if (config.maxRetries) {
            this.maxRetries = config.maxRetries;
        }

        // Initialize connection detector
        connectionDetector.init();

        // Single-flight online consumer connection
        this.unsubscribeConnection = connectionDetector.onChange(async (state) => {
            if (this.isDestroyed) return;
            if (state === 'online') {
                if (this.status === 'offline') {
                    this.setStatus('idle');
                }
                await this.triggerOnlineConsumer();
            } else if (state === 'offline') {
                this.setStatus('offline');
            }
        });

        // Set initial status based on connection
        if (!connectionDetector.isOnline()) {
            this.setStatus('offline');
        } else {
            this.setStatus('idle');
        }

        // Start auto-sync if configured
        if (config.autoSyncInterval && config.autoSyncInterval > 0) {
            this.startAutoSync(config.autoSyncInterval);
        }

        // Reactive subscription to vault unlock for auto-resolving isolated CONFLICT_LOCKED files
        this.unsubscribeKeyStore = sessionKeyStore.subscribe(async (isUnlocked) => {
            if (this.isDestroyed || !this.initialized) return;
            if (isUnlocked && this.pendingEncryptedConflicts.size > 0) {
                const pendingIds = Array.from(this.pendingEncryptedConflicts.keys());
                console.log(`[SyncManager] Vault unlocked: auto-resolving ${pendingIds.length} pending encrypted conflicts`);
                for (const fileId of pendingIds) {
                    try {
                        await this.resolvePendingEncryptedConflict(fileId);
                    } catch (err) {
                        console.error(`[SyncManager] Auto-resolution failed for ${fileId}:`, err);
                    }
                }
            }
        });

        this.initialized = true;
        console.log(`[SyncManager] Initialized for user: ${this.config.userId}`);
    }

    /**
     * Destroy the sync manager and clean up all subscriptions and active loops
     */
    destroy(): void {
        this.isDestroyed = true;
        this.initialized = false;
        this.stopAutoSync();

        if (this.activeAbortController) {
            try {
                this.activeAbortController.abort();
            } catch {
                // Ignore abort error on destroy
            }
            this.activeAbortController = null;
        }

        if (this.unsubscribeConnection) {
            this.unsubscribeConnection();
            this.unsubscribeConnection = undefined;
        }

        if (this.unsubscribeKeyStore) {
            this.unsubscribeKeyStore();
            this.unsubscribeKeyStore = null;
        }

        this.idb?.close();
        this.statusCallbacks.clear();
        this.remoteUpdateCallbacks.clear();
        this.syncQueue = [];
        this.conflictCallback = undefined;
        this.isConsumerRunning = false;
        this.hasPendingOnlineConsumer = false;
        this.isQueueProcessing = false;
        this.pendingEncryptedConflicts.clear();
        this.encryptedConflictListeners.clear();
        this.rollback?.clearAll();
        this.setStatus('stopped');
        console.log('[SyncManager] Destroyed and resources released');
    }

    /**
     * Set conflict callback for UI integration
     */
    setConflictCallback(callback: ConflictCallback): void {
        this.conflictCallback = callback;
    }

    /**
     * Register remote update callback to notify when clean files are pulled
     */
    onRemoteUpdate(callback: RemoteUpdateCallback): () => void {
        this.remoteUpdateCallbacks.add(callback);
        return () => this.remoteUpdateCallbacks.delete(callback);
    }

    /**
     * Get all currently isolated encrypted conflicts waiting for vault unlock
     */
    getPendingEncryptedConflicts(): PendingEncryptedConflict[] {
        return Array.from(this.pendingEncryptedConflicts.values());
    }

    /**
     * Get a specific isolated encrypted conflict by file ID
     */
    getPendingEncryptedConflict(fileId: string): PendingEncryptedConflict | undefined {
        return this.pendingEncryptedConflicts.get(fileId);
    }

    /**
     * Check whether a file is currently isolated in CONFLICT_LOCKED state
     */
    isEncryptedConflictLocked(fileId: string): boolean {
        return this.pendingEncryptedConflicts.has(fileId);
    }

    /**
     * Register a listener for newly isolated encrypted conflicts
     */
    onEncryptedConflictLocked(callback: (conflict: PendingEncryptedConflict) => void): () => void {
        this.encryptedConflictListeners.add(callback);
        return () => {
            this.encryptedConflictListeners.delete(callback);
        };
    }

    /**
     * Notify listeners that an encrypted conflict was isolated pending vault unlock
     */
    private notifyEncryptedConflictLocked(conflict: PendingEncryptedConflict): void {
        for (const listener of this.encryptedConflictListeners) {
            try {
                listener(conflict);
            } catch (err) {
                console.error('[SyncManager] Error in encrypted conflict listener:', err);
            }
        }
    }

    /**
     * Resolves an isolated encrypted conflict once the vault has been unlocked by user.
     * Fetches, decrypts 3-way in RAM, runs Diff3, verifies syntax integrity, re-encrypts with fresh IV,
     * and updates the server.
     */
    async resolvePendingEncryptedConflict(fileId: string): Promise<FileSyncResult> {
        return concurrencyManager.withLock(fileId, async () => {
            const conflict = this.pendingEncryptedConflicts.get(fileId);
            if (!conflict) {
                return { fileId, success: false, action: 'skipped', error: 'No pending encrypted conflict found' };
            }

            const masterKey = sessionKeyStore.getMasterKeyRaw();
            if (!masterKey) {
                return { fileId, success: false, action: 'skipped', error: 'Vault is still locked' };
            }

            const userId = this.config?.userId || '';
            const aad = `vault:file:${userId}:${fileId}`;

            try {
                let remoteText = '';
                let localText = '';
                let baseText = '';

                if (conflict.remoteEnvelope.ciphertext) {
                    const iv = base64ToUint8Array(conflict.remoteEnvelope.iv);
                    remoteText = await cryptoWorkerBridge.decryptAESGCM(masterKey, conflict.remoteEnvelope.ciphertext, iv, aad);
                    wipeBuffer(iv);
                }
                if (conflict.localEnvelope.ciphertext) {
                    const iv = base64ToUint8Array(conflict.localEnvelope.iv);
                    localText = await cryptoWorkerBridge.decryptAESGCM(masterKey, conflict.localEnvelope.ciphertext, iv, aad);
                    wipeBuffer(iv);
                }
                if (conflict.baseEnvelope.ciphertext) {
                    const iv = base64ToUint8Array(conflict.baseEnvelope.iv);
                    baseText = await cryptoWorkerBridge.decryptAESGCM(masterKey, conflict.baseEnvelope.ciphertext, iv, aad);
                    wipeBuffer(iv);
                } else {
                    baseText = remoteText;
                }

                // 3-way diff3 merge
                const mergeResult = conflictResolver.attemptThreeWayMerge({
                    base: { content: baseText },
                    local: { content: localText },
                    remote: { content: remoteText },
                });

                // Post-merge Markdown syntax integrity check
                const syntaxResult = (mergeResult.success && mergeResult.content)
                    ? validateMarkdownSyntaxIntegrity(mergeResult.content)
                    : { isValid: false, sanitizedContent: '' };

                if (!mergeResult.success || !mergeResult.content || !syntaxResult.isValid) {
                    if (this.conflictCallback) {
                        const localEtag = conflict.localEnvelope.ciphertext ? generateEncryptedETagSync(conflict.localEnvelope) : '';
                        const resolution = await this.conflictCallback({
                            fileId,
                            localContent: localText,
                            serverContent: remoteText,
                            localEtag,
                            serverEtag: conflict.remoteEtag,
                            serverVersion: 0,
                            serverUpdatedAt: new Date(conflict.detectedAt).toISOString(),
                        });

                        if (resolution === 'server') {
                            this.pendingEncryptedConflicts.delete(fileId);
                            const localFile = await this.idb.getFile(fileId);
                            if (localFile) {
                                localFile.content = conflict.remoteEnvelope.ciphertext;
                                localFile.encryptionMetadata = {
                                    version: 1,
                                    algorithm: 'AES-GCM-256',
                                    keyId: conflict.remoteEnvelope.keyId || 'master-v1',
                                    iv: conflict.remoteEnvelope.iv,
                                    salt: conflict.remoteEnvelope.salt,
                                    kdfIterations: conflict.remoteEnvelope.kdfIterations,
                                };
                                localFile.etag = conflict.remoteEtag;
                                localFile.isDirty = false;
                                localFile.lastSyncedAt = Date.now();
                                await this.idb.saveFile(localFile);
                            }
                            return { fileId, success: true, action: 'pulled', newEtag: conflict.remoteEtag };
                        }
                    }
                    return { fileId, success: false, action: 'conflict', error: 'CONFLICT_MANUAL' };
                }

                // Re-encrypt merged content with a fresh random IV
                const newIvBytes = await cryptoWorkerBridge.generateRandomBytes(12);
                const { ciphertextBase64, ivBase64 } = await cryptoWorkerBridge.encryptAESGCM(
                    masterKey,
                    syntaxResult.sanitizedContent,
                    newIvBytes,
                    aad
                );
                wipeBuffer(newIvBytes);

                const newMetadata = {
                    version: 1,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    salt: '',
                    iv: ivBase64,
                    kdfIterations: 600000,
                };

                const serializedEnvelope = JSON.stringify({
                    ...newMetadata,
                    ciphertext: ciphertextBase64,
                });
                const newEtag = generateEncryptedETagSync(serializedEnvelope);

                const res = await fetch(`/api/files/${fileId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'If-Match': `"${conflict.remoteEtag}"`,
                    },
                    body: JSON.stringify({
                        content: ciphertextBase64,
                        isEncrypted: true,
                        encryptionMetadata: newMetadata,
                    }),
                });

                if (!res.ok) {
                    // Evict from locked conflicts quarantine so regular sync engine treats it as standard conflict in subsequent cycle
                    this.pendingEncryptedConflicts.delete(fileId);
                    return { fileId, success: false, action: 'skipped', error: `Server rejected push: ${res.status}` };
                }

                const resData = await res.json().catch(() => ({}));
                this.pendingEncryptedConflicts.delete(fileId);

                // Update local IndexedDB record with the newly merged ciphertext and metadata
                const localFile = await this.idb.getFile(fileId);
                const finalEtag = resData.etag || newEtag;
                const finalVersion = resData.version ?? (localFile?.version ? localFile.version + 1 : 1);

                if (localFile) {
                    localFile.content = ciphertextBase64;
                    localFile.encryptionMetadata = newMetadata;
                    localFile.etag = finalEtag;
                    localFile.version = finalVersion;
                    localFile.isDirty = false;
                    localFile.lastSyncedAt = Date.now();
                    localFile.baseSnapshot = {
                        content: ciphertextBase64,
                        etag: finalEtag,
                        version: finalVersion,
                        title: localFile.title,
                        parentFolderId: localFile.parentFolderId,
                        isEncrypted: true,
                        encryptionMetadata: newMetadata,
                    };
                    await this.idb.saveFile(localFile);
                } else {
                    await this.idb.markFileClean(fileId, finalEtag);
                }

                // Mark any queued/syncing operations for this file as synced
                const ops = await this.idb.getOperations(fileId);
                for (const op of ops) {
                    if (!op.synced) {
                        await this.idb.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }

                return {
                    fileId,
                    success: true,
                    action: 'pushed',
                    newEtag: finalEtag,
                };
            } catch (err) {
                console.error(`[SyncManager] Error resolving encrypted conflict for ${fileId}:`, err);
                return {
                    fileId,
                    success: false,
                    action: 'skipped',
                    error: err instanceof Error ? err.message : 'Unknown error during encrypted conflict resolution',
                };
            }
        });
    }


    /**
     * Update sync status and notify callbacks
     */
    private setStatus(status: SyncStatus, progress?: number): void {
        // Prevent transitioning to active states if destroyed or stopped
        if (this.isDestroyed && status !== 'stopped') {
            return;
        }

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
            if (this.isDestroyed) return;
            if (connectionDetector.isOnline() && (this.status === 'idle' || this.status === 'queued')) {
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
     * Single-flight online consumer guard to prevent duplicate concurrent runs
     */
    private async triggerOnlineConsumer(): Promise<void> {
        if (this.isDestroyed || !this.initialized || !connectionDetector.isOnline()) return;

        if (this.isConsumerRunning) {
            this.hasPendingOnlineConsumer = true;
            return;
        }

        this.isConsumerRunning = true;
        try {
            console.log('[SyncManager] Online transition, running single consumer');
            await this.sync();
        } catch (err) {
            console.error('[SyncManager] Online consumer error:', err);
        } finally {
            this.isConsumerRunning = false;
            if (this.hasPendingOnlineConsumer && !this.isDestroyed && connectionDetector.isOnline()) {
                this.hasPendingOnlineConsumer = false;
                this.triggerOnlineConsumer();
            }
        }
    }

    /**
     * Perform full sync (push + pull)
     */
    async sync(): Promise<SyncResult> {
        if (this.isDestroyed || this.status === 'stopped') {
            return {
                success: false,
                filesProcessed: 0,
                filesPushed: 0,
                filesPulled: 0,
                conflicts: [],
                errors: ['SyncManager is stopped or uninitialized'],
                timestamp: Date.now(),
            };
        }

        if (!this.config || !this.config.userId) {
            throw new Error('SyncManager not initialized with valid userId');
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

        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;

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
            // Step 1: Process queued operations deterministically
            const queueResult = await this.processOperationsQueue(signal);
            result.filesPushed += queueResult.succeeded;
            result.conflicts.push(...queueResult.conflicts);
            if (queueResult.failed > 0) {
                result.errors.push(`Failed to sync ${queueResult.failed} queued operations`);
            }

            if (signal.aborted) {
                throw new Error('Sync aborted');
            }

            // Step 2: Push dirty files
            const pushResult = await this.pushDirtyFiles(signal);
            result.filesPushed += pushResult.pushed;
            result.conflicts.push(...pushResult.conflicts);
            result.errors.push(...pushResult.errors);

            if (signal.aborted) {
                throw new Error('Sync aborted');
            }

            // Step 3: Pull updates from server
            const pullResult = await this.pullUpdates(signal);
            result.filesPulled = pullResult.pulled;
            result.conflicts.push(...pullResult.conflicts);
            result.errors.push(...pullResult.errors);

            result.filesProcessed = result.filesPushed + result.filesPulled;
            result.success = result.errors.length === 0;

            // Update last synced timestamp
            await this.idb.updateLastSyncedAt(this.config.userId);

            if (!this.isDestroyed) {
                this.setStatus('idle');
            }
            console.log('[SyncManager] Sync complete:', result);

        } catch (error) {
            if (signal.aborted || this.isDestroyed) {
                result.success = false;
                result.errors.push('Sync aborted');
                this.setStatus('stopped');
                return result;
            }

            const syncError = syncErrorHandler.fromException(error, 'Full sync');
            await syncErrorHandler.handle(syncError);

            result.success = false;
            result.errors.push(syncError.message);

            this.setStatus(syncError.type === SyncErrorType.NETWORK_ERROR ? 'offline' : 'failed');
        } finally {
            this.activeAbortController = null;
        }

        return result;
    }

    /**
     * Deterministically process pending operations in the queue with exponential backoff & dead-lettering
     */
    async processOperationsQueue(signal?: AbortSignal): Promise<{
        processed: number;
        succeeded: number;
        failed: number;
        conflicts: string[];
    }> {
        const stats = { processed: 0, succeeded: 0, failed: 0, conflicts: [] as string[] };

        if (this.isDestroyed || !this.initialized || this.status === 'stopped') {
            return stats;
        }

        if (this.isQueueProcessing) {
            return stats;
        }

        if (!connectionDetector.isOnline()) {
            return stats;
        }

        this.isQueueProcessing = true;

        try {
            const dueOperations = await this.idb.getDueOperations(Date.now(), this.config?.maxRetries || this.maxRetries);
            if (dueOperations.length === 0) {
                return stats;
            }

            for (const op of dueOperations) {
                if (signal?.aborted || this.isDestroyed || !connectionDetector.isOnline()) {
                    break;
                }

                stats.processed++;

                // Mark operation as actively syncing
                await this.idb.updateOperationStatus(op.id, 'syncing');

                const opResult = await this.processSingleOperation(op, signal);

                if (opResult.success) {
                    stats.succeeded++;
                } else if (opResult.action === 'conflict') {
                    stats.conflicts.push(op.fileId);
                } else {
                    stats.failed++;
                }
            }
        } catch (error) {
            console.error('[SyncManager] Error in operations queue processor:', error);
        } finally {
            this.isQueueProcessing = false;
        }

        return stats;
    }

    /**
     * Process a single queued operation with file-level concurrency locking, error handling and rollback
     */
    private async processSingleOperation(op: IDBOperation, signal?: AbortSignal): Promise<FileSyncResult> {
        return concurrencyManager.withLock(op.fileId, async () => {
            if (signal?.aborted || this.isDestroyed) {
                await this.idb.updateOperationStatus(op.id, 'queued');
                return { fileId: op.fileId, success: false, action: 'skipped', error: 'Aborted' };
            }

            const checkpointId = await this.rollback.createCheckpoint(op.fileId, 'pre_sync', op.id);
            const file = await this.idb.getFile(op.fileId);

            if (!file) {
                await this.idb.updateOperationStatus(op.id, 'failed', {
                    lastError: 'Local file not found for operation',
                });
                return { fileId: op.fileId, success: false, action: 'skipped', error: 'Local file not found' };
            }

            const currentAttempts = (op.attempts || 0) + 1;
            const maxAllowedRetries = this.config?.maxRetries || this.maxRetries;

            try {
                const reqHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'X-Operation-ID': op.operationId || op.id,
                };
                if (file.etag) {
                    reqHeaders['If-Match'] = `"${file.etag}"`;
                }

                const response = await withBackoff(async () => {
                    return fetch(`/api/files/${op.fileId}`, {
                        method: 'PUT',
                        headers: reqHeaders,
                        body: JSON.stringify({
                            content: file.content,
                            title: file.title,
                            isEncrypted: file.isEncrypted ?? false,
                            encryptionMetadata: file.encryptionMetadata ?? null,
                            operationId: op.operationId || op.id,
                            baseVersion: op.baseVersion ?? file.version,
                            expectedVersion: op.baseVersion ?? file.version,
                        }),
                        signal,
                    });
                }, 1, undefined, signal);

                if (response.status === 412 || response.status === 409) {
                    const serverData = await response.json().catch(() => ({}));
                    if (serverData.serverVersion) {
                        // Check if content or ETag is actually identical (false conflict)
                        if (file.content === serverData.serverVersion.content || compareETags(file.etag, serverData.serverVersion.etag)) {
                            console.log(`[SyncManager] False conflict for ${file.id} (identical content/ETag), auto-adopting server version`);
                            await this.idb.commitFileAndOperationSync(file.id, serverData.serverVersion.etag, op.id, currentAttempts);
                            const updatedFile = await this.idb.getFile(file.id);
                            if (updatedFile) {
                                updatedFile.version = serverData.serverVersion.version;
                                updatedFile.isDirty = false;
                                await this.idb.saveFile(updatedFile);
                            }
                            this.rollback.removeCheckpoint(checkpointId);
                            return {
                                fileId: op.fileId,
                                success: true,
                                action: 'pushed' as const,
                                newEtag: serverData.serverVersion.etag,
                            };
                        }
                    }

                    if (file.isEncrypted && !sessionKeyStore.isVaultUnlocked()) {
                        console.warn(`[SyncManager] Encrypted file ${file.id} 412 conflict isolated as CONFLICT_LOCKED while vault is locked.`);
                        const pendingConflict: PendingEncryptedConflict = {
                            fileId: file.id,
                            remoteEnvelope: {
                                version: 1,
                                algorithm: 'AES-GCM-256' as const,
                                keyId: 'master-v1',
                                iv: serverData.serverVersion?.encryptionMetadata?.iv || '',
                                salt: serverData.serverVersion?.encryptionMetadata?.salt || '',
                                ciphertext: serverData.serverVersion?.content || '',
                                kdfIterations: serverData.serverVersion?.encryptionMetadata?.kdfIterations || 600000,
                            },
                            baseEnvelope: {
                                version: 1,
                                algorithm: 'AES-GCM-256' as const,
                                keyId: 'master-v1',
                                iv: file.baseSnapshot?.isEncrypted ? (file.encryptionMetadata?.iv || '') : '',
                                salt: file.encryptionMetadata?.salt || '',
                                ciphertext: file.baseSnapshot?.content || '',
                                kdfIterations: 600000,
                            },
                            localEnvelope: {
                                version: 1,
                                algorithm: 'AES-GCM-256' as const,
                                keyId: 'master-v1',
                                iv: file.encryptionMetadata?.iv || '',
                                salt: file.encryptionMetadata?.salt || '',
                                ciphertext: file.content || '',
                                kdfIterations: 600000,
                            },
                            remoteEtag: serverData.serverVersion?.etag || '',
                            detectedAt: new Date(),
                        };

                        this.pendingEncryptedConflicts.set(file.id, pendingConflict);
                        await this.idb.updateOperationStatus(op.id, 'conflict', {
                            attempts: currentAttempts,
                            lastError: 'Encrypted conflict isolated: waiting for vault unlock (CONFLICT_LOCKED)',
                        });
                        this.notifyEncryptedConflictLocked(pendingConflict);
                        this.rollback.removeCheckpoint(checkpointId);

                        return {
                            fileId: op.fileId,
                            success: false,
                            action: 'conflict' as const,
                            error: 'CONFLICT_LOCKED',
                        };
                    }

                    await this.idb.updateOperationStatus(op.id, 'conflict', {
                        attempts: currentAttempts,
                        lastError: 'Conflict detected on server',
                    });
                    if (serverData.serverVersion) {
                        await this.handleConflict(file, serverData.serverVersion);
                    }
                    return {
                        fileId: op.fileId,
                        success: false,
                        action: 'conflict' as const,
                    };
                }

                if (response.status === 404) {
                    // File deleted on server -> non-retryable fatal failure
                    await this.idb.updateOperationStatus(op.id, 'failed', {
                        attempts: currentAttempts,
                        lastError: 'File deleted on server (404)',
                    });
                    return {
                        fileId: op.fileId,
                        success: false,
                        action: 'skipped' as const,
                        error: 'File not found on server',
                    };
                }

                if (!response.ok) {
                    const syncErr = await syncErrorHandler.fromResponse(response, `Operation ${op.id}`);
                    throw new Error(syncErr.message);
                }

                const data = await response.json();

                // Atomically mark file clean and operation synced in a single multi-store transaction
                await this.idb.commitFileAndOperationSync(file.id, data.etag, op.id, currentAttempts);

                // Remove checkpoint
                this.rollback.removeCheckpoint(checkpointId);

                return {
                    fileId: op.fileId,
                    success: true,
                    action: 'pushed' as const,
                    newEtag: data.etag,
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown operation sync error';
                const isRetryable = isRetryableError(error);

                if (currentAttempts >= maxAllowedRetries || !isRetryable) {
                    // Move to dead_letter / fatal failed status
                    await this.idb.updateOperationStatus(op.id, isRetryable ? 'dead_letter' : 'failed', {
                        attempts: currentAttempts,
                        lastError: `Max retries exceeded or fatal error: ${errorMessage}`,
                    });
                } else {
                    // Exponential backoff with optional jitter
                    const baseDelay = Math.min(
                        this.baseBackoffMs * Math.pow(2, currentAttempts - 1),
                        this.maxBackoffMs
                    );
                    const jitterMultiplier = this.enableJitter ? (0.85 + 0.3 * Math.random()) : 1;
                    const delay = Math.round(baseDelay * jitterMultiplier);
                    const nextRetryAt = Date.now() + delay;

                    await this.idb.updateOperationStatus(op.id, 'failed', {
                        attempts: currentAttempts,
                        nextRetryAt,
                        lastError: errorMessage,
                    });
                }

                // Execute rollback to restore safe state
                await this.rollback.rollback(checkpointId, op.id);

                return {
                    fileId: op.fileId,
                    success: false,
                    action: 'skipped' as const,
                    error: errorMessage,
                };
            }
        });
    }

    /**
     * Push all dirty files to server (filtering out files already tracked in pending operations to avoid double-pushes)
     */
    private async pushDirtyFiles(signal?: AbortSignal): Promise<{
        pushed: number;
        conflicts: string[];
        errors: string[];
    }> {
        const result = { pushed: 0, conflicts: [] as string[], errors: [] as string[] };

        const dirtyFiles = await this.idb.getDirtyFiles();
        if (dirtyFiles.length === 0) return result;

        // Filter out files that already have active/queued operations to prevent double-pushing
        const queuedOps = await this.idb.getOperationsByStatus('queued');
        const syncingOps = await this.idb.getOperationsByStatus('syncing');
        const pendingFileIds = new Set([...queuedOps, ...syncingOps].map(o => o.fileId));
        const filesToPush = dirtyFiles.filter(f => !pendingFileIds.has(f.id) && !this.pendingEncryptedConflicts.has(f.id));

        if (filesToPush.length === 0) {
            return result;
        }

        console.log(`[SyncManager] Pushing ${filesToPush.length} standalone dirty files for ${this.config?.userId}`);

        const { results, errors } = await runWithConcurrency(
            filesToPush.map((file) => () => this.pushFile(file, signal)),
            DEFAULT_PUSH_CONCURRENCY
        );

        for (let i = 0; i < filesToPush.length; i++) {
            const fileResult = results[i];
            if (fileResult?.success) {
                result.pushed++;
            } else if (fileResult?.action === 'conflict') {
                result.conflicts.push(filesToPush[i].id);
            } else {
                const message = fileResult?.error ?? errors[i]?.message ?? 'Unknown push error';
                result.errors.push(`${filesToPush[i].id}: ${message}`);
            }
        }

        return result;
    }

    /**
     * Push a single file to server with file-level concurrency lock
     */
    private async pushFile(file: IDBFile, signal?: AbortSignal): Promise<FileSyncResult> {
        return concurrencyManager.withLock(file.id, async () => {
            if (signal?.aborted || this.isDestroyed) {
                return { fileId: file.id, success: false, action: 'skipped', error: 'Aborted' };
            }

            const checkpointId = await this.rollback.createCheckpoint(file.id, 'pre_sync');

            try {
                const reqHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                };
                if (file.etag) {
                    reqHeaders['If-Match'] = `"${file.etag}"`;
                }

                const response = await withBackoff(async () => {
                    return fetch(`/api/files/${file.id}`, {
                        method: 'PUT',
                        headers: reqHeaders,
                        body: JSON.stringify({
                            content: file.content,
                            title: file.title,
                            isEncrypted: file.isEncrypted ?? false,
                            encryptionMetadata: file.encryptionMetadata ?? null,
                            expectedVersion: file.version ?? 1,
                        }),
                        signal,
                    });
                }, 3, undefined, signal);

                if (response.status === 412 || response.status === 409) {
                    const serverData = await response.json().catch(() => ({}));
                    if (serverData.serverVersion) {
                        if (file.isEncrypted && !sessionKeyStore.isVaultUnlocked()) {
                            console.warn(`[SyncManager] Encrypted file ${file.id} 412 conflict isolated as CONFLICT_LOCKED while vault is locked.`);
                            const pendingConflict: PendingEncryptedConflict = {
                                fileId: file.id,
                                remoteEnvelope: {
                                    version: 1,
                                    algorithm: 'AES-GCM-256' as const,
                                    keyId: 'master-v1',
                                    iv: serverData.serverVersion?.encryptionMetadata?.iv || '',
                                    salt: serverData.serverVersion?.encryptionMetadata?.salt || '',
                                    ciphertext: serverData.serverVersion?.content || '',
                                    kdfIterations: serverData.serverVersion?.encryptionMetadata?.kdfIterations || 600000,
                                },
                                baseEnvelope: {
                                    version: 1,
                                    algorithm: 'AES-GCM-256' as const,
                                    keyId: 'master-v1',
                                    iv: file.baseSnapshot?.isEncrypted ? (file.encryptionMetadata?.iv || '') : '',
                                    salt: file.encryptionMetadata?.salt || '',
                                    ciphertext: file.baseSnapshot?.content || '',
                                    kdfIterations: 600000,
                                },
                                localEnvelope: {
                                    version: 1,
                                    algorithm: 'AES-GCM-256' as const,
                                    keyId: 'master-v1',
                                    iv: file.encryptionMetadata?.iv || '',
                                    salt: file.encryptionMetadata?.salt || '',
                                    ciphertext: file.content || '',
                                    kdfIterations: 600000,
                                },
                                remoteEtag: serverData.serverVersion?.etag || '',
                                detectedAt: new Date(),
                            };

                            this.pendingEncryptedConflicts.set(file.id, pendingConflict);
                            this.notifyEncryptedConflictLocked(pendingConflict);
                            this.rollback.removeCheckpoint(checkpointId);

                            return {
                                fileId: file.id,
                                success: false,
                                action: 'conflict' as const,
                                error: 'CONFLICT_LOCKED',
                            };
                        }

                        let serverContent = serverData.serverVersion.content;
                        if (file.isEncrypted) {
                            const inbound = await SyncCryptoGateway.decryptInbound({
                                fileId: file.id,
                                content: serverData.serverVersion.content,
                                isEncrypted: true,
                                encryptionMetadata: serverData.serverVersion.encryptionMetadata,
                                userId: this.config?.userId,
                            });
                            if (inbound.status === 'decrypted') {
                                serverContent = inbound.content;
                            }
                        }

                        await this.handleConflict(file, {
                            ...serverData.serverVersion,
                            content: serverContent,
                            rawCiphertext: serverData.serverVersion.content,
                        });
                    }

                    return {
                        fileId: file.id,
                        success: false,
                        action: 'conflict' as const,
                    };
                }

                if (response.status === 404) {
                    // File deleted or non-existent on server -> mark clean locally so queue ceases retrying
                    await this.idb.markFileClean(file.id, file.etag || '');
                    this.rollback.removeCheckpoint(checkpointId);
                    return {
                        fileId: file.id,
                        success: false,
                        action: 'skipped' as const,
                        error: 'File not found on server',
                    };
                }

                if (!response.ok) {
                    throw new Error(`Push failed: ${response.status}`);
                }

                const data = await response.json();

                // Mark file as clean with new ETag in user-scoped IDB
                await this.idb.markFileClean(file.id, data.etag);

                // Remove checkpoint
                this.rollback.removeCheckpoint(checkpointId);

                return {
                    fileId: file.id,
                    success: true,
                    action: 'pushed' as const,
                    newEtag: data.etag,
                };

            } catch (error) {
                // Rollback on error
                await this.rollback.rollback(checkpointId);

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
    private async pullUpdates(signal?: AbortSignal): Promise<{
        pulled: number;
        conflicts: string[];
        errors: string[];
    }> {
        const result = { pulled: 0, conflicts: [] as string[], errors: [] as string[] };

        if (!this.config) return result;

        const metadata = await this.idb.getSyncMetadata(this.config.userId);
        const lastSyncedAt = metadata?.lastSyncedAt
            ? new Date(metadata.lastSyncedAt).toISOString()
            : undefined;

        try {
            let hasMore = true;
            let cursor: string | undefined;

            const baseUrl = this.config.apiBaseUrl ||
                (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'http://localhost:3000');

            while (hasMore) {
                if (signal?.aborted || this.isDestroyed) break;

                const url = new URL('/api/files/sync', baseUrl);
                if (lastSyncedAt) url.searchParams.set('updated_after', lastSyncedAt);
                if (cursor) url.searchParams.set('cursor', cursor);
                url.searchParams.set('limit', '50');

                const response = await withBackoff(async () => {
                    return fetch(url.toString(), { signal });
                }, 3, undefined, signal);

                if (!response.ok) {
                    throw new Error(`Pull failed: ${response.status}`);
                }

                const data = await response.json();

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
     * Pull and merge a single file from server with tombstone (soft-deletion) handling
     */
    private async pullFile(serverFile: {
        id: string;
        content: string;
        etag: string;
        version: number;
        title: string;
        parentFolderId: string | null;
        isFolder: boolean;
        deletedAt?: string | null;
        updatedAt: string;
        isEncrypted?: boolean;
        encryptionMetadata?: EncryptedEnvelopeMetadata | null;
    }): Promise<FileSyncResult> {
        // Handle server tombstone (soft-deleted file)
        if (serverFile.deletedAt) {
            const localFile = await this.idb.getFile(serverFile.id);
            if (localFile) {
                // DATA-SAFETY GUARD: never silently discard unsaved local edits.
                // If the local copy carries unpushed user edits (isDirty), keep it
                // intact and surface a conflict instead of deleting it, so the user
                // decides what happens to their content.
                if (localFile.isDirty) {
                    const dirtyOps = await this.idb.getOperations(serverFile.id);
                    for (const op of dirtyOps) {
                        if (op.status === 'queued' || op.status === 'syncing') {
                            await this.idb.updateOperationStatus(op.id, 'failed', {
                                lastError: 'Server deleted file with unsaved local edits (tombstone received)',
                            });
                        }
                    }
                    return {
                        fileId: serverFile.id,
                        success: false,
                        action: 'conflict',
                        error: 'Server deleted file with unsaved local edits',
                    };
                }

                await this.idb.deleteFile(serverFile.id);
                // Mark any pending operations for the deleted file as failed
                const ops = await this.idb.getOperations(serverFile.id);
                for (const op of ops) {
                    if (op.status === 'queued' || op.status === 'syncing') {
                        await this.idb.updateOperationStatus(op.id, 'failed', {
                            lastError: 'File deleted on server (tombstone received)',
                        });
                    }
                }
            }
            return { fileId: serverFile.id, success: true, action: 'pulled' };
        }

        const localFile = await this.idb.getFile(serverFile.id);
        const isFileEncrypted = serverFile.isEncrypted ?? false;
        const inbound = await SyncCryptoGateway.decryptInbound({
            fileId: serverFile.id,
            content: serverFile.content,
            isEncrypted: isFileEncrypted,
            encryptionMetadata: serverFile.encryptionMetadata,
            userId: this.config?.userId,
        });

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
                isEncrypted: serverFile.isEncrypted ?? false,
                encryptionMetadata: serverFile.encryptionMetadata ?? null,
                lastModified: new Date(serverFile.updatedAt).getTime(),
                lastSyncedAt: Date.now(),
                isDirty: false,
            };
            await this.idb.saveFile(newFile);

            for (const cb of this.remoteUpdateCallbacks) {
                try {
                    cb({
                        fileId: serverFile.id,
                        content: inbound.content,
                        etag: serverFile.etag,
                        version: serverFile.version,
                        title: serverFile.title,
                        parentFolderId: serverFile.parentFolderId,
                        updatedAt: serverFile.updatedAt,
                        isEncrypted: inbound.isEncrypted,
                        isVaultLocked: inbound.isVaultLocked,
                        encryptionMetadata: inbound.encryptionMetadata,
                    });
                } catch (err) {
                    console.error('[SyncManager] Remote update callback error:', err);
                }
            }

            return { fileId: serverFile.id, success: true, action: 'pulled' };
        }

        // Check if server has newer version
        if (compareETags(localFile.etag, serverFile.etag)) {
            return { fileId: serverFile.id, success: true, action: 'skipped' };
        }

        // Local file is dirty - conflict
        if (localFile.isDirty) {
            if (localFile.isEncrypted && !sessionKeyStore.isVaultUnlocked()) {
                console.warn(`[SyncManager] Encrypted file ${localFile.id} pull conflict isolated as CONFLICT_LOCKED while vault is locked.`);
                const pendingConflict: PendingEncryptedConflict = {
                    fileId: localFile.id,
                    remoteEnvelope: {
                        version: 1,
                        algorithm: 'AES-GCM-256' as const,
                        keyId: 'master-v1',
                        iv: serverFile.encryptionMetadata?.iv || '',
                        salt: serverFile.encryptionMetadata?.salt || '',
                        ciphertext: serverFile.content || '',
                        kdfIterations: serverFile.encryptionMetadata?.kdfIterations || 600000,
                    },
                    baseEnvelope: {
                        version: 1,
                        algorithm: 'AES-GCM-256' as const,
                        keyId: 'master-v1',
                        iv: localFile.baseSnapshot?.isEncrypted ? (localFile.encryptionMetadata?.iv || '') : '',
                        salt: localFile.encryptionMetadata?.salt || '',
                        ciphertext: localFile.baseSnapshot?.content || '',
                        kdfIterations: 600000,
                    },
                    localEnvelope: {
                        version: 1,
                        algorithm: 'AES-GCM-256' as const,
                        keyId: 'master-v1',
                        iv: localFile.encryptionMetadata?.iv || '',
                        salt: localFile.encryptionMetadata?.salt || '',
                        ciphertext: localFile.content || '',
                        kdfIterations: 600000,
                    },
                    remoteEtag: serverFile.etag || '',
                    detectedAt: new Date(),
                };

                this.pendingEncryptedConflicts.set(localFile.id, pendingConflict);
                this.notifyEncryptedConflictLocked(pendingConflict);

                return { fileId: serverFile.id, success: false, action: 'conflict' as const, error: 'CONFLICT_LOCKED' };
            }

            await this.handleConflict(localFile, {
                content: inbound.content,
                rawCiphertext: serverFile.content,
                etag: serverFile.etag,
                version: serverFile.version,
                updatedAt: serverFile.updatedAt,
                isEncrypted: inbound.isEncrypted,
                encryptionMetadata: inbound.encryptionMetadata,
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
            isEncrypted: serverFile.isEncrypted !== undefined ? serverFile.isEncrypted : localFile.isEncrypted,
            encryptionMetadata: serverFile.encryptionMetadata !== undefined ? serverFile.encryptionMetadata : localFile.encryptionMetadata,
            lastModified: new Date(serverFile.updatedAt).getTime(),
            lastSyncedAt: Date.now(),
            isDirty: false,
        };
        await this.idb.saveFile(updatedFile);

        for (const cb of this.remoteUpdateCallbacks) {
            try {
                cb({
                    fileId: serverFile.id,
                    content: inbound.content,
                    etag: serverFile.etag,
                    version: serverFile.version,
                    title: serverFile.title,
                    parentFolderId: serverFile.parentFolderId,
                    updatedAt: serverFile.updatedAt,
                    isEncrypted: inbound.isEncrypted,
                    isVaultLocked: inbound.isVaultLocked,
                    encryptionMetadata: inbound.encryptionMetadata,
                });
            } catch (err) {
                console.error('[SyncManager] Remote update callback error:', err);
            }
        }

        return { fileId: serverFile.id, success: true, action: 'pulled', newEtag: serverFile.etag };
    }

    /**
     * Handle conflict between local and server versions
     */
    private async handleConflict(
        localFile: IDBFile,
        serverVersion: {
            content: string;
            rawCiphertext?: string;
            etag: string;
            version: number;
            updatedAt: string;
            isEncrypted?: boolean;
            encryptionMetadata?: EncryptedEnvelopeMetadata | null;
        }
    ): Promise<void> {
        console.log(`[SyncManager] Conflict checking for file ${localFile.id}`);

        let localPlaintext = localFile.content;
        if (localFile.isEncrypted) {
            const localInbound = await SyncCryptoGateway.decryptInbound({
                fileId: localFile.id,
                content: localFile.content,
                isEncrypted: true,
                encryptionMetadata: localFile.encryptionMetadata,
                userId: this.config?.userId,
            });
            if (localInbound.status === 'decrypted') {
                localPlaintext = localInbound.content;
            }
        }

        const serverPlaintext = serverVersion.content;

        // If local content and server content are identical, or ETags match: auto-resolve
        if (localPlaintext === serverPlaintext || compareETags(localFile.etag, serverVersion.etag)) {
            console.log(`[SyncManager] Content/ETags match for file ${localFile.id}, auto-clearing conflict`);
            const cleanFile: IDBFile = {
                ...localFile,
                etag: serverVersion.etag,
                version: serverVersion.version,
                lastSyncedAt: Date.now(),
                isDirty: false,
            };
            await this.idb.saveFile(cleanFile);

            const ops = await this.idb.getOperations(localFile.id);
            for (const op of ops) {
                if (!op.synced) {
                    await this.idb.updateOperationStatus(op.id, 'synced', { synced: true });
                }
            }
            return;
        }

        if (this.conflictCallback) {
            const resolution = await this.conflictCallback({
                fileId: localFile.id,
                localContent: localPlaintext,
                serverContent: serverPlaintext,
                localEtag: localFile.etag,
                serverEtag: serverVersion.etag,
                serverVersion: serverVersion.version,
                serverUpdatedAt: serverVersion.updatedAt,
                isEncrypted: localFile.isEncrypted || serverVersion.isEncrypted,
                encryptionMetadata: serverVersion.encryptionMetadata || localFile.encryptionMetadata,
            });

            if (resolution === 'server') {
                const updatedFile: IDBFile = {
                    ...localFile,
                    content: serverVersion.rawCiphertext || serverVersion.content,
                    etag: serverVersion.etag,
                    version: serverVersion.version,
                    lastSyncedAt: Date.now(),
                    isDirty: false,
                };
                await this.idb.saveFile(updatedFile);
                const ops = await this.idb.getOperations(localFile.id);
                for (const op of ops) {
                    if (!op.synced) {
                        await this.idb.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            } else if (resolution === 'local') {
                // When local resolution is selected, clear dirty flag and mark all operations as synced
                const refreshedFile = await this.idb.getFile(localFile.id);
                if (refreshedFile) {
                    refreshedFile.isDirty = false;
                    refreshedFile.lastSyncedAt = Date.now();
                    await this.idb.saveFile(refreshedFile);
                }
                const ops = await this.idb.getOperations(localFile.id);
                for (const op of ops) {
                    if (!op.synced) {
                        await this.idb.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            }
        }
    }

    /**
     * Queue a file for sync with priority and deterministic operation tracking
     */
    async queueSync(fileId: string, priority: 1 | 2 | 3 = 2, operationId?: string): Promise<void> {
        if (this.isDestroyed || !this.initialized) {
            return;
        }

        this.syncQueue = this.syncQueue.filter(item => item.fileId !== fileId);

        const opId = operationId || `op_${this.config?.userId || 'anon'}_${fileId}_${Date.now()}`;

        this.syncQueue.push({
            operationId: opId,
            fileId,
            priority,
            addedAt: Date.now(),
            retryCount: 0,
        });

        this.syncQueue.sort((a, b) => a.priority - b.priority);
        this.setStatus('queued');

        // Record operation in IDB if file exists
        const file = await this.idb.getFile(fileId);
        const newOp: IDBOperation = {
            id: opId,
            operationId: opId,
            userId: this.config?.userId || 'anon',
            fileId,
            baseVersion: file?.version || 1,
            status: 'queued',
            attempts: 0,
            operationType: 'update',
            position: 0,
            content: file?.content || '',
            timestamp: Date.now(),
            synced: false,
            snapshot: file ? { content: file.content, etag: file.etag, version: file.version } : undefined,
        };
        await this.idb.addOperation(newOp);

        if (connectionDetector.isOnline() && (this.status === 'idle' || this.status === 'queued')) {
            this.processOperationsQueue().catch(err => {
                console.error('[SyncManager] Error running queue consumer:', err);
            });
        }
    }

    /**
     * Force sync a specific file immediately
     */
    async syncFile(fileId: string): Promise<FileSyncResult> {
        if (this.isDestroyed || !this.initialized) {
            return { fileId, success: false, action: 'skipped', error: 'SyncManager is not initialized' };
        }

        const file = await this.idb.getFile(fileId);
        if (!file) {
            return { fileId, success: false, action: 'skipped', error: 'File not found' };
        }

        if (file.isDirty) {
            return this.pushFile(file);
        }

        return { fileId, success: true, action: 'skipped' };
    }
}

/**
 * Factory for creating user-scoped SyncManager instances
 */
export function createSyncManager(config?: SyncManagerConfig): SyncManager {
    return new SyncManager(config);
}

// Export singleton instance for backward compatibility
export const syncManager = new SyncManager();

// Export class for testing
export { SyncManager };
