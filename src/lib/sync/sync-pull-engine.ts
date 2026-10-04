/**
 * Sync Pull Engine
 * 
 * Encapsulates remote pull synchronization, server tombstone propagation,
 * incoming file conflict quarantine, and 3-way conflict negotiation.
 */

import type { IndexedDBManager } from './indexeddb';
import type { IDBFile, EncryptedEnvelopeMetadata, ConflictFileState } from './idb-types';
import { withBackoff } from './connection-detector';
import type { SyncRollback } from './rollback';
import { compareETags } from './etag-generator';
import { sessionKeyStore } from './session-key-store';
import { SyncCryptoGateway } from './sync-crypto-gateway';
import type { ConflictStore } from '../idb/conflict-store';
import type { PendingEncryptedConflict } from './types/vault';
import type { SyncEncryptedConflictStore } from './sync-encrypted-conflict-store';
import type {
    FileSyncResult,
    RemoteUpdateEvent,
    ConflictCallback,
} from './sync-manager.types';

/**
 * Injected options and dependencies for SyncPullEngine
 */
export interface SyncPullEngineOptions {
    userId: string;
    apiBaseUrl?: string;
    idb: IndexedDBManager;
    rollback: SyncRollback;
    conflictStore: ConflictStore;
    encryptedConflictStore: SyncEncryptedConflictStore;
    getConflictCallback?: () => ConflictCallback | undefined;
    onRemoteUpdate?: (event: RemoteUpdateEvent) => void;
    signal?: AbortSignal;
}

/**
 * Pull engine orchestrating incremental remote updates, conflict quarantine,
 * and inbound payload decryption.
 */
export class SyncPullEngine {
    private userId: string;
    private apiBaseUrl?: string;
    private idb: IndexedDBManager;
    private rollback: SyncRollback;
    private conflictStore: ConflictStore;
    private encryptedConflictStore: SyncEncryptedConflictStore;
    private getConflictCallback?: () => ConflictCallback | undefined;
    private onRemoteUpdate?: (event: RemoteUpdateEvent) => void;
    private isDestroyed = false;

    constructor(options: SyncPullEngineOptions) {
        this.userId = options.userId;
        this.apiBaseUrl = options.apiBaseUrl;
        this.idb = options.idb;
        this.rollback = options.rollback;
        this.conflictStore = options.conflictStore;
        this.encryptedConflictStore = options.encryptedConflictStore;
        this.getConflictCallback = options.getConflictCallback;
        this.onRemoteUpdate = options.onRemoteUpdate;
    }

    /**
     * Dynamically update active configuration and dependencies
     */
    updateConfig(options: Partial<SyncPullEngineOptions>): void {
        if (options.userId !== undefined) this.userId = options.userId;
        if (options.apiBaseUrl !== undefined) this.apiBaseUrl = options.apiBaseUrl;
        if (options.idb !== undefined) this.idb = options.idb;
        if (options.rollback !== undefined) this.rollback = options.rollback;
        if (options.conflictStore !== undefined) this.conflictStore = options.conflictStore;
        if (options.encryptedConflictStore !== undefined) this.encryptedConflictStore = options.encryptedConflictStore;
        if (options.getConflictCallback !== undefined) this.getConflictCallback = options.getConflictCallback;
        if (options.onRemoteUpdate !== undefined) this.onRemoteUpdate = options.onRemoteUpdate;
        this.isDestroyed = false;
    }

    /**
     * Teardown engine state
     */
    destroy(): void {
        this.isDestroyed = true;
    }

    /**
     * Pull remote updates from server incrementally using cursor-based pagination
     */
    async pullUpdates(signal?: AbortSignal): Promise<{
        pulled: number;
        conflicts: string[];
        errors: string[];
    }> {
        const result = { pulled: 0, conflicts: [] as string[], errors: [] as string[] };

        if (!this.userId) return result;

        const metadata = await this.idb.getSyncMetadata(this.userId);
        const lastSyncedAt = metadata?.lastSyncedAt
            ? new Date(metadata.lastSyncedAt).toISOString()
            : undefined;

        try {
            let hasMore = true;
            let cursor: string | undefined;

            const baseUrl = this.apiBaseUrl ||
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
                    const pullResult = await this.pullFile(serverFile, signal);

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
     * Pull and merge a single file from server with tombstone (soft-deletion) and quarantine safeguards
     */
    async pullFile(serverFile: {
        id: string;
        content: string;
        etag: string;
        version: number;
        title: string;
        parentFolderId: string | null;
        isFolder?: boolean;
        deletedAt?: string | null;
        updatedAt: string;
        isEncrypted?: boolean;
        encryptionMetadata?: EncryptedEnvelopeMetadata | null;
    }, signal?: AbortSignal): Promise<FileSyncResult> {
        if (signal?.aborted || this.isDestroyed) {
            return { fileId: serverFile.id, success: false, action: 'skipped', error: 'Aborted' };
        }

        // Handle server tombstone (soft-deleted file)
        if (serverFile.deletedAt) {
            const localFile = await this.idb.getFile(serverFile.id);
            if (localFile) {
                // DATA-SAFETY GUARD: never silently discard unsaved local edits or conflicted files.
                // If the local copy carries unpushed user edits (isDirty) or is in conflict quarantine,
                // keep it intact and surface a conflict instead of deleting it.
                if (localFile.isDirty || localFile.syncStatus === 'conflict' || (await this.conflictStore.isConflicted(serverFile.id))) {
                    const dirtyOps = await this.idb.getOperations(serverFile.id);
                    for (const op of dirtyOps) {
                        if (op.status === 'queued' || op.status === 'syncing') {
                            await this.idb.updateOperationStatus(op.id, 'failed', {
                                lastError: 'Server deleted file with unsaved local edits or conflict (tombstone received)',
                            });
                        }
                    }
                    return {
                        fileId: serverFile.id,
                        success: false,
                        action: 'conflict',
                        error: 'Server deleted file with unsaved local edits or conflict',
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

        // DATA-SAFETY GUARD: If file is in durable conflict quarantine,
        // strictly refuse to overwrite or replace it during background server pull!
        if (localFile?.syncStatus === 'conflict' || (localFile && await this.conflictStore.isConflicted(serverFile.id))) {
            console.warn(`[SyncPullEngine] pullFile skipped for ${serverFile.id}: file is in durable conflict quarantine`);
            return {
                fileId: serverFile.id,
                success: false,
                action: 'conflict',
                error: 'DURABLE_CONFLICT_QUARANTINE',
            };
        }

        const isFileEncrypted = serverFile.isEncrypted ?? false;
        const inbound = await SyncCryptoGateway.decryptInbound({
            fileId: serverFile.id,
            content: serverFile.content,
            isEncrypted: isFileEncrypted,
            encryptionMetadata: serverFile.encryptionMetadata,
            userId: this.userId,
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
                isFolder: serverFile.isFolder ?? false,
                isEncrypted: serverFile.isEncrypted ?? false,
                encryptionMetadata: serverFile.encryptionMetadata ?? null,
                lastModified: new Date(serverFile.updatedAt).getTime(),
                lastSyncedAt: Date.now(),
                isDirty: false,
                syncStatus: 'synced',
                baseSnapshot: {
                    content: serverFile.content,
                    etag: serverFile.etag,
                    version: serverFile.version,
                    title: serverFile.title,
                    parentFolderId: serverFile.parentFolderId,
                    isEncrypted: serverFile.isEncrypted ?? false,
                    encryptionMetadata: serverFile.encryptionMetadata ?? null,
                },
            };
            await this.idb.saveFile(newFile);

            if (this.onRemoteUpdate) {
                try {
                    this.onRemoteUpdate({
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
                    console.error('[SyncPullEngine] Remote update callback error:', err);
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
                console.warn(`[SyncPullEngine] Encrypted file ${localFile.id} pull conflict isolated as CONFLICT_LOCKED while vault is locked.`);
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

                this.encryptedConflictStore.quarantineEncryptedConflict(pendingConflict);

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
            syncStatus: 'synced',
            conflictData: undefined,
            baseSnapshot: {
                content: serverFile.content,
                etag: serverFile.etag,
                version: serverFile.version,
                title: serverFile.title,
                parentFolderId: serverFile.parentFolderId,
                isEncrypted: serverFile.isEncrypted ?? false,
                encryptionMetadata: serverFile.encryptionMetadata ?? null,
            },
        };
        await this.idb.saveFile(updatedFile);

        if (this.onRemoteUpdate) {
            try {
                this.onRemoteUpdate({
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
                console.error('[SyncPullEngine] Remote update callback error:', err);
            }
        }

        return { fileId: serverFile.id, success: true, action: 'pulled', newEtag: serverFile.etag };
    }

    /**
     * Put a file into durable conflict quarantine in IndexedDB upon HTTP 412/409
     */
    async quarantineServerConflict(
        file: IDBFile,
        serverVersion: {
            content?: string;
            etag?: string;
            version?: number;
            title?: string;
            parentFolderId?: string | null;
            updatedAt?: string;
            isEncrypted?: boolean;
            encryptionMetadata?: EncryptedEnvelopeMetadata | null;
        }
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
    }

    /**
     * Handle conflict negotiation between local and server versions
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
        console.log(`[SyncPullEngine] Conflict checking for file ${localFile.id}`);

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

        // Auto-resolve if contents or ETags match
        if (localPlaintext === serverPlaintext || compareETags(localFile.etag, serverVersion.etag)) {
            console.log(`[SyncPullEngine] Content/ETags match for file ${localFile.id}, auto-clearing conflict`);
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
