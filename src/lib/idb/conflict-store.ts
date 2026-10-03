/**
 * Durable IndexedDB Conflict Store
 * 
 * Manages persistent conflict quarantine for files across page reloads and browser sessions.
 * Guarantees that conflicts detected via HTTP 412/409 or background divergence cannot be
 * silently overwritten by background pulls or tombstone sweeps until resolved.
 * 
 * Remediates: LUGX-003, LUGX-089, LUGX-101
 */

import { IDBFile, SyncConflict, ConflictFileState } from '../sync/idb-types';
import { IndexedDBManager, indexedDBManager } from '../sync/indexeddb';

export interface DurableConflictPayload {
    fileId: string;
    serverVersion: ConflictFileState;
    localVersion: ConflictFileState;
    baseVersion?: ConflictFileState;
    detectedAt?: number;
}

export class ConflictStore {
    private idb: IndexedDBManager;

    constructor(idbInstance?: IndexedDBManager) {
        this.idb = idbInstance || indexedDBManager;
    }

    /**
     * Put a file into durable conflict quarantine in IndexedDB.
     * Persists server, local, and base versions so conflict state survives page reloads.
     */
    async quarantineConflict(payload: DurableConflictPayload): Promise<void> {
        const detectedAt = payload.detectedAt || Date.now();
        const file = await this.idb.getFile(payload.fileId);

        const conflictData: NonNullable<IDBFile['conflictData']> = {
            serverVersion: payload.serverVersion,
            localVersion: payload.localVersion,
            baseVersion: payload.baseVersion,
            detectedAt,
        };

        if (file) {
            file.syncStatus = 'conflict';
            file.conflictData = conflictData;
            file.isDirty = true;
            if (payload.localVersion.content !== undefined) {
                file.content = payload.localVersion.content;
            }
            await this.idb.saveFile(file);
        } else {
            // If local file record wasn't present, create one in quarantined state
            const newFile: IDBFile = {
                id: payload.fileId,
                content: payload.localVersion.content,
                etag: payload.localVersion.etag,
                lastModified: payload.localVersion.lastModified || Date.now(),
                lastSyncedAt: 0,
                isDirty: true,
                syncStatus: 'conflict',
                version: payload.localVersion.version || 1,
                title: payload.localVersion.title || 'Untitled',
                parentFolderId: payload.localVersion.parentFolderId ?? null,
                isFolder: false,
                isEncrypted: payload.localVersion.isEncrypted,
                encryptionMetadata: payload.localVersion.encryptionMetadata,
                conflictData,
            };
            await this.idb.saveFile(newFile);
        }
    }

    /**
     * Check if a file is currently under conflict quarantine.
     */
    async isConflicted(fileId: string): Promise<boolean> {
        const file = await this.idb.getFile(fileId);
        return file?.syncStatus === 'conflict' || !!file?.conflictData;
    }

    /**
     * Retrieve the persistent conflict for a file, if any.
     */
    async getConflict(fileId: string): Promise<SyncConflict | null> {
        const file = await this.idb.getFile(fileId);
        if (!file || (file.syncStatus !== 'conflict' && !file.conflictData)) {
            return null;
        }

        const data = file.conflictData || {
            serverVersion: {
                content: file.content,
                etag: file.etag,
                lastModified: file.lastModified,
                version: file.version,
            },
            localVersion: {
                content: file.content,
                etag: file.etag,
                lastModified: file.lastModified,
                version: file.version,
            },
            detectedAt: file.lastModified,
        };

        const ops = await this.idb.getOperations(fileId);

        return {
            fileId,
            localVersion: data.localVersion,
            serverVersion: data.serverVersion,
            baseVersion: data.baseVersion,
            operations: ops,
            detectedAt: data.detectedAt,
            type: 'content',
        };
    }

    /**
     * Retrieve all quarantined conflicts across all files in the current user database.
     */
    async getAllConflicts(): Promise<SyncConflict[]> {
        const conflictedFiles = typeof this.idb.getConflictedFiles === 'function'
            ? await this.idb.getConflictedFiles()
            : (typeof this.idb.getAllFiles === 'function' ? (await this.idb.getAllFiles()).filter(f => f.syncStatus === 'conflict' || !!f.conflictData) : []);
        const conflicts: SyncConflict[] = [];

        for (const file of conflictedFiles) {
            const conflict = await this.getConflict(file.id);
            if (conflict) {
                conflicts.push(conflict);
            }
        }

        return conflicts;
    }

    /**
     * Remove conflict quarantine after successful resolution.
     */
    async clearConflict(fileId: string): Promise<void> {
        if (typeof this.idb.clearFileConflict === 'function') {
            await this.idb.clearFileConflict(fileId);
        } else {
            const file = await this.idb.getFile(fileId);
            if (file) {
                file.syncStatus = file.isDirty ? 'dirty' : 'synced';
                file.conflictData = undefined;
                await this.idb.saveFile(file);
            }
        }
    }

    /**
     * Apply explicit resolution to a conflicted file.
     */
    async resolveConflict(
        fileId: string,
        resolution: 'local' | 'server' | 'merge',
        resolvedContent?: string
    ): Promise<void> {
        const file = await this.idb.getFile(fileId);
        if (!file) return;

        const conflictData = file.conflictData;

        if (resolution === 'server' && conflictData) {
            file.content = conflictData.serverVersion.content;
            file.etag = conflictData.serverVersion.etag;
            file.version = conflictData.serverVersion.version;
            file.isDirty = false;
            file.syncStatus = 'synced';
            file.conflictData = undefined;
            file.lastSyncedAt = Date.now();
            await this.idb.saveFile(file);
        } else if (resolution === 'local') {
            // Retain local content, clear conflict quarantine, keep dirty for next push
            if (conflictData?.localVersion?.content !== undefined) {
                file.content = conflictData.localVersion.content;
            }
            file.isDirty = true;
            file.syncStatus = 'dirty';
            file.conflictData = undefined;
            file.lastModified = Date.now();
            await this.idb.saveFile(file);
        } else if (resolution === 'merge') {
            if (resolvedContent !== undefined) {
                file.content = resolvedContent;
            }
            file.isDirty = true;
            file.syncStatus = 'dirty';
            file.conflictData = undefined;
            file.lastModified = Date.now();
            await this.idb.saveFile(file);
        }
    }
}

export const conflictStore = new ConflictStore();
