/**
 * Sync Rollback Manager
 * 
 * Provides checkpoint creation and rollback capabilities for sync operations.
 * Ensures data safety during sync by allowing recovery to previous states.
 */

import { indexedDBManager, IndexedDBManager } from './indexeddb';
import { IDBFile, IDBOperation } from './idb-types';

/**
 * Checkpoint data structure
 */
export interface SyncCheckpoint {
    /** Unique checkpoint ID */
    id: string;
    /** File ID this checkpoint belongs to */
    fileId: string;
    /** Associated operation ID if linked to an operation */
    operationId?: string;
    /** Snapshot of file content */
    content: string;
    /** ETag at checkpoint time */
    etag: string;
    /** Version at checkpoint time */
    version: number;
    /** Timestamp when checkpoint was created */
    createdAt: number;
    /** Reason for creating checkpoint */
    reason: 'pre_sync' | 'pre_merge' | 'manual';
}

/**
 * In-memory checkpoint storage
 * Checkpoints are temporary and don't persist across page reloads
 */
const checkpoints = new Map<string, SyncCheckpoint>();

/**
 * Maximum age for checkpoints before auto-cleanup (1 hour)
 */
const MAX_CHECKPOINT_AGE_MS = 60 * 60 * 1000;

/**
 * Maximum number of checkpoints to keep
 */
const MAX_CHECKPOINTS = 50;

/**
 * Sync Rollback Class
 * Manages checkpoint creation, operation snapshot restoration and rollback recovery
 */
export class SyncRollback {
    private idb: IndexedDBManager;

    constructor(idb?: IndexedDBManager) {
        this.idb = idb || indexedDBManager;
    }

    /**
     * Create a checkpoint before a sync operation
     * 
     * @param fileId - File ID to checkpoint
     * @param reason - Reason for creating checkpoint
     * @param operationId - Optional associated operation ID
     * @returns Checkpoint ID
     */
    async createCheckpoint(
        fileId: string,
        reason: SyncCheckpoint['reason'] = 'pre_sync',
        operationId?: string
    ): Promise<string> {
        // Get current file state from IndexedDB
        const file = await this.idb.getFile(fileId);
        if (!file) {
            throw new Error(`Cannot create checkpoint: file ${fileId} not found`);
        }

        // Generate unique checkpoint ID with random component for guaranteed uniqueness
        const randomId = Math.random().toString(36).substring(2, 9);
        const checkpointId = `checkpoint_${fileId}_${Date.now()}_${randomId}`;

        // Create checkpoint
        const checkpoint: SyncCheckpoint = {
            id: checkpointId,
            fileId,
            operationId,
            content: file.content,
            etag: file.etag,
            version: file.version,
            createdAt: Date.now(),
            reason,
        };

        // Store checkpoint
        checkpoints.set(checkpointId, checkpoint);

        // Cleanup old checkpoints if we have too many
        this.cleanupOldCheckpoints();

        console.log(`[Rollback] Created checkpoint ${checkpointId} for file ${fileId}`);
        return checkpointId;
    }

    /**
     * Rollback a file to a previous checkpoint
     * 
     * @param checkpointId - Checkpoint ID to rollback to
     * @param operationId - Optional operation ID to update status on failure
     * @returns true if rollback succeeded, false otherwise
     */
    async rollback(checkpointId: string, operationId?: string): Promise<boolean> {
        const checkpoint = checkpoints.get(checkpointId);
        const targetOpId = operationId || checkpoint?.operationId;

        if (!checkpoint) {
            // Fallback: Check if operation has a persistent snapshot in IndexedDB
            if (targetOpId) {
                const op = await this.idb.getOperation(targetOpId).catch(() => undefined);
                if (op?.snapshot) {
                    console.log(`[Rollback] In-memory checkpoint ${checkpointId} missing, restoring from IDBOperation snapshot for ${targetOpId}`);
                    return this.rollbackOperation(op);
                }

                await this.idb.updateOperationStatus(targetOpId, 'rollback_failed', {
                    lastError: `Checkpoint ${checkpointId} not found and no snapshot available for rollback`,
                }).catch(err => console.error('[Rollback] Failed to record rollback_failed state:', err));
            } else {
                console.error(`[Rollback] Checkpoint ${checkpointId} not found`);
            }
            return false;
        }

        try {
            // Get current file
            const currentFile = await this.idb.getFile(checkpoint.fileId);
            if (!currentFile) {
                console.error(`[Rollback] File ${checkpoint.fileId} not found`);
                if (targetOpId) {
                    await this.idb.updateOperationStatus(targetOpId, 'rollback_failed', {
                        lastError: `File ${checkpoint.fileId} not found for rollback`,
                    });
                }
                return false;
            }

            // Restore file to checkpoint state
            const restoredFile: IDBFile = {
                ...currentFile,
                content: checkpoint.content,
                etag: checkpoint.etag,
                version: checkpoint.version,
                lastModified: Date.now(),
                isDirty: true, // Mark as dirty so it syncs again
            };

            await this.idb.saveFile(restoredFile);

            // Remove used checkpoint
            checkpoints.delete(checkpointId);

            console.log(`[Rollback] Rolled back file ${checkpoint.fileId} to checkpoint ${checkpointId}`);
            return true;
        } catch (error) {
            console.error(`[Rollback] Rollback execution failed for ${checkpointId}:`, error);
            if (targetOpId) {
                await this.idb.updateOperationStatus(targetOpId, 'rollback_failed', {
                    lastError: error instanceof Error ? error.message : 'Rollback execution failed',
                }).catch(err => console.error('[Rollback] Failed to record rollback_failed state:', err));
            }
            return false;
        }
    }

    /**
     * Rollback directly from an IDBOperation snapshot
     */
    async rollbackOperation(operation: IDBOperation): Promise<boolean> {
        const opId = operation.operationId || operation.id;
        if (!operation.snapshot) {
            console.warn(`[Rollback] Operation ${opId} has no snapshot to rollback to`);
            await this.idb.updateOperationStatus(opId, 'rollback_failed', {
                lastError: 'Operation contains no snapshot for rollback',
            }).catch(err => console.error('[Rollback] Failed to set rollback_failed:', err));
            return false;
        }

        try {
            const currentFile = await this.idb.getFile(operation.fileId);
            if (!currentFile) {
                await this.idb.updateOperationStatus(opId, 'rollback_failed', {
                    lastError: `File ${operation.fileId} not found during operation rollback`,
                });
                return false;
            }

            const restoredFile: IDBFile = {
                ...currentFile,
                content: operation.snapshot.content,
                etag: operation.snapshot.etag,
                version: operation.snapshot.version,
                lastModified: Date.now(),
                isDirty: true,
            };

            await this.idb.saveFile(restoredFile);
            console.log(`[Rollback] Successfully rolled back operation ${opId} snapshot for file ${operation.fileId}`);
            return true;
        } catch (error) {
            console.error(`[Rollback] Operation snapshot rollback failed for ${opId}:`, error);
            await this.idb.updateOperationStatus(opId, 'rollback_failed', {
                lastError: error instanceof Error ? error.message : 'Operation snapshot rollback failed',
            }).catch(err => console.error('[Rollback] Failed to record rollback_failed:', err));
            return false;
        }
    }

    /**
     * Remove a checkpoint (after successful sync)
     */
    removeCheckpoint(checkpointId: string): void {
        checkpoints.delete(checkpointId);
    }

    /**
     * Get checkpoint by ID
     */
    getCheckpoint(checkpointId: string): SyncCheckpoint | undefined {
        return checkpoints.get(checkpointId);
    }

    /**
     * Get all checkpoints for a file
     */
    getFileCheckpoints(fileId: string): SyncCheckpoint[] {
        return Array.from(checkpoints.values())
            .filter(cp => cp.fileId === fileId)
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Get the latest checkpoint for a file
     */
    getLatestCheckpoint(fileId: string): SyncCheckpoint | undefined {
        const fileCheckpoints = this.getFileCheckpoints(fileId);
        return fileCheckpoints[0];
    }

    /**
     * Cleanup old checkpoints
     */
    private cleanupOldCheckpoints(): void {
        const now = Date.now();
        const toDelete: string[] = [];

        // Find expired checkpoints
        for (const [id, checkpoint] of checkpoints) {
            if (now - checkpoint.createdAt > MAX_CHECKPOINT_AGE_MS) {
                toDelete.push(id);
            }
        }

        // Delete expired checkpoints
        for (const id of toDelete) {
            checkpoints.delete(id);
        }

        // If still too many, remove oldest
        if (checkpoints.size > MAX_CHECKPOINTS) {
            const sorted = Array.from(checkpoints.entries())
                .sort((a, b) => a[1].createdAt - b[1].createdAt);

            const toRemove = sorted.slice(0, checkpoints.size - MAX_CHECKPOINTS);
            for (const [id] of toRemove) {
                checkpoints.delete(id);
            }
        }
    }

    /**
     * Clear all checkpoints
     */
    clearAll(): void {
        checkpoints.clear();
    }

    /**
     * Get checkpoint count
     */
    getCount(): number {
        return checkpoints.size;
    }
}

/**
 * Factory for creating scoped SyncRollback instances
 */
export function createSyncRollback(idb?: IndexedDBManager): SyncRollback {
    return new SyncRollback(idb);
}

// Export singleton instance
export const syncRollback = new SyncRollback();
