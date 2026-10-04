/**
 * Sync Encrypted Conflict Store
 * 
 * Manages in-memory quarantine, FIFO capacity enforcement, diagnostics,
 * and 3-way Diff3 merge resolution for encrypted conflicts locked while vault is locked.
 */

import { IndexedDBManager } from './indexeddb';
import { IDBFile, EncryptedEnvelopeMetadata } from './idb-types';
import { SyncRollback } from './rollback';
import { ConflictStore } from '../idb/conflict-store';
import type { PendingEncryptedConflict } from './types/vault';
import { concurrencyManager } from './concurrency-manager';
import { sessionKeyStore } from './session-key-store';
import { cryptoWorkerBridge, wipeBuffer, base64ToUint8Array } from './crypto-worker-bridge';
import { conflictResolver } from './conflict-resolver';
import { validateMarkdownSyntaxIntegrity } from './syntax-validator';
import { generateEncryptedETagSync } from './etag-generator';
import { sanitizeLogValue } from './log-sanitizer';

import {
    MAX_QUARANTINED_CONFLICTS,
    type QuarantineDiagnostics,
    type FileSyncResult,
    type ConflictCallback,
} from './sync-manager.types';

export {
    MAX_QUARANTINED_CONFLICTS,
    type QuarantineDiagnostics,
    type FileSyncResult,
    type ConflictCallback,
};

/**
 * Options for configuring SyncEncryptedConflictStore
 */
export interface SyncEncryptedConflictStoreOptions {
    userId?: string;
    idb: IndexedDBManager;
    conflictStore: ConflictStore;
    rollback?: SyncRollback;
    conflictCallback?: ConflictCallback;
    pushResolved?: (file: IDBFile) => Promise<FileSyncResult>;
}

/**
 * In-memory store and orchestrator for locked encrypted sync conflicts
 */
export class SyncEncryptedConflictStore {
    private pendingEncryptedConflicts: Map<string, PendingEncryptedConflict> = new Map();
    private encryptedConflictListeners: Set<(conflict: PendingEncryptedConflict) => void> = new Set();
    private userId?: string;
    private idb: IndexedDBManager;
    private conflictStore: ConflictStore;
    private rollback?: SyncRollback;
    private conflictCallback?: ConflictCallback;
    private pushResolved?: (file: IDBFile) => Promise<FileSyncResult>;

    constructor(options: SyncEncryptedConflictStoreOptions) {
        this.userId = options.userId;
        this.idb = options.idb;
        this.conflictStore = options.conflictStore;
        this.rollback = options.rollback;
        this.conflictCallback = options.conflictCallback;
        this.pushResolved = options.pushResolved;
    }

    /**
     * Underlying Map reference for backward compatibility with reflection-based test hooks
     */
    get rawMap(): Map<string, PendingEncryptedConflict> {
        return this.pendingEncryptedConflicts;
    }

    /**
     * Update active context dependencies (e.g. on re-initialization or user switch)
     */
    updateContext(options: Partial<SyncEncryptedConflictStoreOptions>): void {
        if (options.userId !== undefined) this.userId = options.userId;
        if (options.idb !== undefined) this.idb = options.idb;
        if (options.conflictStore !== undefined) this.conflictStore = options.conflictStore;
        if (options.rollback !== undefined) this.rollback = options.rollback;
        if (options.conflictCallback !== undefined) this.conflictCallback = options.conflictCallback;
        if (options.pushResolved !== undefined) this.pushResolved = options.pushResolved;
    }

    /**
     * Set conflict callback for UI integration
     */
    setConflictCallback(callback?: ConflictCallback): void {
        this.conflictCallback = callback;
    }

    /**
     * Clear all in-memory conflicts and listeners
     */
    clear(): void {
        this.pendingEncryptedConflicts.clear();
        this.encryptedConflictListeners.clear();
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
    notifyEncryptedConflictLocked(conflict: PendingEncryptedConflict): void {
        for (const listener of this.encryptedConflictListeners) {
            try {
                listener(conflict);
            } catch (err) {
                console.error('[SyncEncryptedConflictStore] Error in encrypted conflict listener:', err);
            }
        }
    }

    /**
     * Add an encrypted conflict to quarantine with deterministic capacity enforcement (FIFO eviction of oldest).
     */
    quarantineEncryptedConflict(conflict: PendingEncryptedConflict): void {
        const isNewConflict = !this.pendingEncryptedConflicts.has(conflict.fileId);
        if (isNewConflict && this.pendingEncryptedConflicts.size >= MAX_QUARANTINED_CONFLICTS) {
            let oldestKey: string | null = null;
            let oldestTime = Infinity;

            for (const [key, item] of this.pendingEncryptedConflicts.entries()) {
                const rawDate = item.detectedAt;
                const time = rawDate instanceof Date ? rawDate.getTime() : new Date(rawDate).getTime();
                if (time < oldestTime) {
                    oldestTime = time;
                    oldestKey = key;
                }
            }

            if (oldestKey) {
                console.warn(`[SyncEncryptedConflictStore] Quarantine at capacity (${MAX_QUARANTINED_CONFLICTS}), evicting oldest: ${oldestKey}`);
                this.pendingEncryptedConflicts.delete(oldestKey);
            }
        }
        this.pendingEncryptedConflicts.set(conflict.fileId, conflict);
        this.notifyEncryptedConflictLocked(conflict);
    }

    /**
     * Get diagnostics and backpressure metrics for quarantined encrypted conflicts.
     */
    getQuarantineDiagnostics(): QuarantineDiagnostics {
        const conflicts = Array.from(this.pendingEncryptedConflicts.values());
        const totalQuarantined = conflicts.length;

        if (totalQuarantined === 0) {
            return {
                totalQuarantined: 0,
                staleCount: 0,
                oldestQuarantinedAt: null,
                newestQuarantinedAt: null,
                isAtCapacity: false,
            };
        }

        const now = Date.now();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
        let staleCount = 0;
        let oldest = Infinity;
        let newest = -Infinity;

        for (const conflict of conflicts) {
            const rawDate = conflict.detectedAt;
            const time = rawDate instanceof Date ? rawDate.getTime() : new Date(rawDate).getTime();
            if (!Number.isNaN(time)) {
                if (now - time > TWENTY_FOUR_HOURS_MS) {
                    staleCount++;
                }
                if (time < oldest) oldest = time;
                if (time > newest) newest = time;
            }
        }

        return {
            totalQuarantined,
            staleCount,
            oldestQuarantinedAt: Number.isFinite(oldest) ? oldest : null,
            newestQuarantinedAt: Number.isFinite(newest) ? newest : null,
            isAtCapacity: totalQuarantined >= MAX_QUARANTINED_CONFLICTS,
        };
    }

    /**
     * Safely discard an isolated encrypted conflict, cleaning up memory, rollback checkpoints,
     * and marking associated operations in IndexedDB as discarded under concurrency lock.
     */
    async discardPendingEncryptedConflict(fileId: string): Promise<void> {
        return concurrencyManager.withLock(fileId, async () => {
            // 1. Remove conflict from RAM map
            this.pendingEncryptedConflicts.delete(fileId);

            // 2. Clean up associated checkpoints
            if (this.rollback) {
                const checkpoints = this.rollback.getFileCheckpoints(fileId);
                for (const cp of checkpoints) {
                    this.rollback.removeCheckpoint(cp.id);
                }
            }

            // 3. Clean up associated operations in IndexedDB
            try {
                const operations = await this.idb.getOperations(fileId);
                for (const op of operations) {
                    const opId = op.operationId || op.id;
                    if (op.status === 'conflict' || op.status === 'queued' || (op.status as string) === 'pending') {
                        await this.idb.updateOperationStatus(opId, 'discarded');
                    }
                }
            } catch (idbError) {
                console.warn(`[SyncEncryptedConflictStore] IDB cleanup failed for discarded conflict ${fileId}:`, idbError);
            }
        });
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

            const userId = this.userId || '';
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
                            await this.conflictStore.clearConflict(fileId);
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
                                localFile.syncStatus = 'synced';
                                localFile.conflictData = undefined;
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
                await this.conflictStore.clearConflict(fileId);

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
                    localFile.syncStatus = 'synced';
                    localFile.conflictData = undefined;
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
                console.error(`[SyncEncryptedConflictStore] Error resolving encrypted conflict for ${fileId}:`, sanitizeLogValue(err));
                return {
                    fileId,
                    success: false,
                    action: 'skipped',
                    error: err instanceof Error ? err.message : 'Unknown error during encrypted conflict resolution',
                };
            }
        });
    }
}
