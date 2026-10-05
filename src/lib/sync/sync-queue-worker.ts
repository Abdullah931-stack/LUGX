/**
 * Sync Queue Worker
 * 
 * Extracts and handles local queue operations, dirty file push batches,
 * exponential backoff retry calculations, and concurrency-locked file uploads.
 */

import { IndexedDBManager } from './indexeddb';
import { IDBFile, IDBOperation, EncryptedEnvelopeMetadata, ConflictFileState } from './idb-types';
import { connectionDetector, withBackoff } from './connection-detector';
import { concurrencyManager } from './concurrency-manager';
import { SyncRollback } from './rollback';
import { syncErrorHandler, isRetryableError } from './error-handler';
import { compareETags } from './etag-generator';
import { runWithConcurrency, DEFAULT_PUSH_CONCURRENCY } from './parallel';
import { sessionKeyStore } from './session-key-store';
import { SyncCryptoGateway } from './sync-crypto-gateway';
import { ConflictStore } from '../idb/conflict-store';
import type { PendingEncryptedConflict } from './types/vault';
import { SyncEncryptedConflictStore } from './sync-encrypted-conflict-store';
import {
    type ConflictCallback,
    type FileSyncResult,
} from './sync-manager.types';

export interface ServerConflictPayload {
    content?: string;
    rawCiphertext?: string;
    etag?: string;
    version?: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt?: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}

/**
 * Configuration options for SyncQueueWorker
 */
export interface SyncQueueWorkerOptions {
    userId: string;
    apiBaseUrl?: string;
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    enableJitter?: boolean;
    idb: IndexedDBManager;
    rollback: SyncRollback;
    conflictStore: ConflictStore;
    encryptedConflictStore: SyncEncryptedConflictStore;
    getConflictCallback?: () => ConflictCallback | undefined;
    onConflictQuarantined?: (file: IDBFile, serverVersion: ServerConflictPayload) => Promise<void>;
}

/**
 * Worker responsible for deterministic queue processing, retry backoff,
 * and pushing dirty files to the remote server.
 */
export class SyncQueueWorker {
    private userId: string;
    private apiBaseUrl?: string;
    private maxRetries: number;
    private baseBackoffMs: number;
    private maxBackoffMs: number;
    private enableJitter: boolean;
    private idb: IndexedDBManager;
    private rollback: SyncRollback;
    private conflictStore: ConflictStore;
    private encryptedConflictStore: SyncEncryptedConflictStore;
    private getConflictCallback?: () => ConflictCallback | undefined;
    private onConflictQuarantined?: (file: IDBFile, serverVersion: ServerConflictPayload) => Promise<void>;

    public isQueueProcessing = false;
    private isDestroyed = false;

    constructor(options: SyncQueueWorkerOptions) {
        this.userId = options.userId;
        this.apiBaseUrl = options.apiBaseUrl;
        this.maxRetries = options.maxRetries ?? 5;
        this.baseBackoffMs = options.baseBackoffMs ?? 1000;
        this.maxBackoffMs = options.maxBackoffMs ?? 30000;
        this.enableJitter = options.enableJitter ?? false;
        this.idb = options.idb;
        this.rollback = options.rollback;
        this.conflictStore = options.conflictStore;
        this.encryptedConflictStore = options.encryptedConflictStore;
        this.getConflictCallback = options.getConflictCallback;
        this.onConflictQuarantined = options.onConflictQuarantined;
    }

    /**
     * Dynamically update active dependencies and configuration
     */
    updateConfig(options: Partial<SyncQueueWorkerOptions>): void {
        if (options.userId !== undefined) this.userId = options.userId;
        if (options.apiBaseUrl !== undefined) this.apiBaseUrl = options.apiBaseUrl;
        if (options.maxRetries !== undefined) this.maxRetries = options.maxRetries;
        if (options.baseBackoffMs !== undefined) this.baseBackoffMs = options.baseBackoffMs;
        if (options.maxBackoffMs !== undefined) this.maxBackoffMs = options.maxBackoffMs;
        if (options.enableJitter !== undefined) this.enableJitter = options.enableJitter;
        if (options.idb !== undefined) this.idb = options.idb;
        if (options.rollback !== undefined) this.rollback = options.rollback;
        if (options.conflictStore !== undefined) this.conflictStore = options.conflictStore;
        if (options.encryptedConflictStore !== undefined) this.encryptedConflictStore = options.encryptedConflictStore;
        if (options.getConflictCallback !== undefined) this.getConflictCallback = options.getConflictCallback;
        if (options.onConflictQuarantined !== undefined) this.onConflictQuarantined = options.onConflictQuarantined;
        this.isDestroyed = false;
    }

    /**
     * Destroy worker and reset reentrancy lock
     */
    destroy(): void {
        this.isDestroyed = true;
        this.isQueueProcessing = false;
    }

    /**
     * Compute exponential backoff delay with optional jitter
     */
    calculateBackoffDelay(attempts: number): number {
        const baseDelay = Math.min(
            this.baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)),
            this.maxBackoffMs
        );
        const jitterMultiplier = this.enableJitter ? (0.85 + 0.3 * Math.random()) : 1;
        return Math.round(baseDelay * jitterMultiplier);
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

        if (this.isDestroyed || this.isQueueProcessing || !connectionDetector.isOnline()) {
            return stats;
        }

        this.isQueueProcessing = true;

        try {
            const dueOperations = await this.idb.getDueOperations(Date.now(), this.maxRetries);
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
            console.error('[SyncQueueWorker] Error in operations queue processor:', error);
        } finally {
            this.isQueueProcessing = false;
        }

        return stats;
    }

    /**
     * Process a single queued operation with file-level concurrency locking, error handling and rollback
     */
    async processSingleOperation(op: IDBOperation, signal?: AbortSignal): Promise<FileSyncResult> {
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
            const maxAllowedRetries = this.maxRetries;

            try {
                const reqHeaders: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'X-Operation-ID': op.operationId || op.id,
                };
                if (file.etag) {
                    reqHeaders['If-Match'] = `"${file.etag}"`;
                }

                const url = this.apiBaseUrl ? `${this.apiBaseUrl}/api/files/${op.fileId}` : `/api/files/${op.fileId}`;
                const response = await withBackoff(async () => {
                    return fetch(url, {
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
                            console.log(`[SyncQueueWorker] False conflict for ${file.id} (identical content/ETag), auto-adopting server version`);
                            const sentRevision = op.localRevision ?? file.localRevision;
                            await this.idb.commitFileAndOperationSync(
                                file.id,
                                serverData.serverVersion.etag,
                                op.id,
                                currentAttempts,
                                serverData.serverVersion.version,
                                sentRevision
                            );
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
                        console.warn(`[SyncQueueWorker] Encrypted file ${file.id} 412 conflict isolated as CONFLICT_LOCKED while vault is locked.`);
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

                        this.encryptedConflictStore.quarantineEncryptedConflict(pendingConflict);
                        await this.idb.updateOperationStatus(op.id, 'conflict', {
                            attempts: currentAttempts,
                            lastError: 'Encrypted conflict isolated: waiting for vault unlock (CONFLICT_LOCKED)',
                        });
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
                        await this.quarantineServerConflict(file, serverData.serverVersion);
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

                // Atomically mark file clean and operation synced in a single multi-store transaction with Lean CAS gating
                const sentRevision = op.localRevision ?? file.localRevision;
                await this.idb.commitFileAndOperationSync(
                    file.id,
                    data.etag,
                    op.id,
                    currentAttempts,
                    data.version,
                    sentRevision
                );

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
                    const delay = this.calculateBackoffDelay(currentAttempts);
                    const nextRetryAt = Date.now() + delay;

                    await this.idb.updateOperationStatus(op.id, 'failed', {
                        attempts: currentAttempts,
                        nextRetryAt,
                        lastError: errorMessage,
                    });
                }

                // Preserve local edits on network push failure (LUGX-013); do not rollback
                this.rollback.removeCheckpoint(checkpointId);

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
    async pushDirtyFiles(signal?: AbortSignal): Promise<{
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
        const filesToPush = dirtyFiles.filter(f => !pendingFileIds.has(f.id) && !this.encryptedConflictStore.isEncryptedConflictLocked(f.id));

        if (filesToPush.length === 0) {
            return result;
        }

        console.log(`[SyncQueueWorker] Pushing ${filesToPush.length} standalone dirty files for ${this.userId}`);

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
    async pushFile(file: IDBFile, signal?: AbortSignal): Promise<FileSyncResult> {
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

                const url = this.apiBaseUrl ? `${this.apiBaseUrl}/api/files/${file.id}` : `/api/files/${file.id}`;
                const response = await withBackoff(async () => {
                    return fetch(url, {
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
                            console.warn(`[SyncQueueWorker] Encrypted file ${file.id} 412 conflict isolated as CONFLICT_LOCKED while vault is locked.`);
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

                            this.encryptedConflictStore.quarantineEncryptedConflict(pendingConflict);
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
                                userId: this.userId,
                            });
                            if (inbound.status === 'decrypted') {
                                serverContent = inbound.content;
                            }
                        }

                        await this.quarantineServerConflict(file, serverData.serverVersion);
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

                // Mark file as clean with new ETag & version in user-scoped IDB, guarded by Lean CAS check
                const sentRevision = file.localRevision;
                if (sentRevision !== undefined || data.version !== undefined) {
                    await this.idb.markFileClean(file.id, data.etag, data.version, sentRevision);
                } else {
                    await this.idb.markFileClean(file.id, data.etag);
                }

                // Remove checkpoint
                this.rollback.removeCheckpoint(checkpointId);

                return {
                    fileId: file.id,
                    success: true,
                    action: 'pushed' as const,
                    newEtag: data.etag,
                };

            } catch (error) {
                // Preserve local edits on network push failure (LUGX-013); do not rollback
                this.rollback.removeCheckpoint(checkpointId);

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
     * Put a file into durable conflict quarantine in IndexedDB upon HTTP 412/409.
     */
    async quarantineServerConflict(
        file: IDBFile,
        serverVersion: ServerConflictPayload
    ): Promise<void> {
        const localState: ConflictFileState = {
            content: file.content,
            etag: file.etag,
            lastModified: file.lastModified,
            version: file.version,
            title: file.title,
            parentFolderId: file.parentFolderId,
            isEncrypted: file.isEncrypted,
            encryptionMetadata: file.encryptionMetadata,
        };
        const serverState: ConflictFileState = {
            content: serverVersion.content || '',
            etag: serverVersion.etag || '',
            lastModified: new Date(serverVersion.updatedAt || Date.now()).getTime(),
            version: serverVersion.version || 0,
            title: serverVersion.title || file.title,
            parentFolderId: serverVersion.parentFolderId ?? file.parentFolderId,
            isEncrypted: serverVersion.isEncrypted,
            encryptionMetadata: serverVersion.encryptionMetadata,
        };
        const baseState: ConflictFileState | undefined = file.baseSnapshot ? {
            content: file.baseSnapshot.content,
            etag: file.baseSnapshot.etag,
            lastModified: file.lastModified,
            version: file.baseSnapshot.version,
            title: file.baseSnapshot.title,
            parentFolderId: file.baseSnapshot.parentFolderId,
            isEncrypted: file.baseSnapshot.isEncrypted,
            encryptionMetadata: file.baseSnapshot.encryptionMetadata,
        } : undefined;

        await this.conflictStore.quarantineConflict({
            fileId: file.id,
            localVersion: localState,
            serverVersion: serverState,
            baseVersion: baseState,
            detectedAt: Date.now(),
        });

        if (this.onConflictQuarantined) {
            await this.onConflictQuarantined(file, serverVersion);
        }
    }

    /**
     * Handle conflict between local and server versions
     */
    async handleConflict(
        localFile: IDBFile,
        serverVersion: {
            content: string;
            rawCiphertext?: string;
            etag: string;
            version: number;
            updatedAt?: string;
            isEncrypted?: boolean;
            encryptionMetadata?: EncryptedEnvelopeMetadata | null;
        }
    ): Promise<void> {
        console.log(`[SyncQueueWorker] Conflict checking for file ${localFile.id}`);

        let localPlaintext = localFile.content;
        if (localFile.isEncrypted) {
            const localInbound = await SyncCryptoGateway.decryptInbound({
                fileId: localFile.id,
                content: localFile.content,
                isEncrypted: true,
                encryptionMetadata: localFile.encryptionMetadata,
                userId: this.userId,
            });
            if (localInbound.status === 'decrypted') {
                localPlaintext = localInbound.content;
            }
        }

        const serverPlaintext = serverVersion.content;

        // If local content and server content are identical, or ETags match: auto-resolve
        if (localPlaintext === serverPlaintext || compareETags(localFile.etag, serverVersion.etag)) {
            console.log(`[SyncQueueWorker] Content/ETags match for file ${localFile.id}, auto-clearing conflict`);
            await this.conflictStore.clearConflict(localFile.id);
            const cleanFile: IDBFile = {
                ...localFile,
                etag: serverVersion.etag,
                version: serverVersion.version,
                lastSyncedAt: Date.now(),
                isDirty: false,
                syncStatus: 'synced',
                conflictData: undefined,
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

        const conflictCb = this.getConflictCallback ? this.getConflictCallback() : undefined;
        if (conflictCb) {
            const resolution = await conflictCb({
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
                await this.conflictStore.clearConflict(localFile.id);
                const updatedFile: IDBFile = {
                    ...localFile,
                    content: serverVersion.rawCiphertext || serverVersion.content,
                    etag: serverVersion.etag,
                    version: serverVersion.version,
                    lastSyncedAt: Date.now(),
                    isDirty: false,
                    syncStatus: 'synced',
                    conflictData: undefined,
                };
                await this.idb.saveFile(updatedFile);
                const ops = await this.idb.getOperations(localFile.id);
                for (const op of ops) {
                    if (!op.synced) {
                        await this.idb.updateOperationStatus(op.id, 'synced', { synced: true });
                    }
                }
            } else if (resolution === 'local') {
                await this.conflictStore.clearConflict(localFile.id);
                const refreshedFile = await this.idb.getFile(localFile.id);
                if (refreshedFile) {
                    refreshedFile.isDirty = true;
                    refreshedFile.syncStatus = 'dirty';
                    refreshedFile.conflictData = undefined;
                    refreshedFile.lastModified = Date.now();
                    await this.idb.saveFile(refreshedFile);
                }
                const ops = await this.idb.getOperations(localFile.id);
                for (const op of ops) {
                    if (!op.synced) {
                        await this.idb.updateOperationStatus(op.id, 'queued');
                    }
                }
            }
        }
    }
}
