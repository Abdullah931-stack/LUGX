/**
 * Operation Coalescing Module for Offline Sync Queue
 *
 * Implements deterministic operation deduplication and coalescing logic for
 * client-side operations in IndexedDB.
 *
 * Guarantees:
 * - Coalesces sequential edit operations strictly while in 'queued' status.
 * - Prohibits mutating operations actively 'syncing' across the network (eliminates LUGX-010).
 * - Prohibits inheriting 'conflict', 'failed', or 'dead_letter' terminal statuses (eliminates LUGX-040).
 * - Monotonically updates localRevision and resets retry backoff counters on coalesced edits.
 *
 * Remediates: LUGX-010, LUGX-040
 */

import { IDBOperation } from './idb-types';

/**
 * Determines whether an incoming operation can be coalesced with an existing operation.
 *
 * Coalescing is strictly allowed ONLY when:
 * 1. Both operations target the exact same fileId.
 * 2. The existing operation is in 'queued' status (NOT 'syncing', 'synced', 'conflict', 'failed', or 'dead_letter').
 * 3. The existing operation is unsynced (synced === false).
 * 4. The operation types are compatible (update + update, or create + update).
 *
 * @param existingOp - The operation already recorded in IndexedDB
 * @param incomingOp - The new operation being submitted
 * @returns boolean indicating if the operations should be merged
 */
export function canCoalesce(existingOp: IDBOperation, incomingOp: IDBOperation): boolean {
    if (existingOp.fileId !== incomingOp.fileId) {
        return false;
    }

    // Must be unsynced
    if (existingOp.synced) {
        return false;
    }

    // Strict state check: ONLY allow coalescing with 'queued' status.
    // In-flight operations ('syncing') must NOT be coalesced to prevent in-flight lost updates.
    // Trapped operations ('conflict', 'failed', 'dead_letter') must NOT trap fresh edits.
    const status = existingOp.status || 'queued';
    if (status !== 'queued') {
        return false;
    }

    // Compatible operation types:
    // 1. Both are 'update'
    // 2. Existing is 'create' and incoming is 'update' (subsequent edits before initial creation was pushed)
    if (existingOp.operationType === 'update' && incomingOp.operationType === 'update') {
        return true;
    }

    if (existingOp.operationType === 'create' && incomingOp.operationType === 'update') {
        return true;
    }

    return false;
}

/**
 * Merges an incoming operation into an existing queued operation.
 *
 * - Preserves initial identity and baseVersion.
 * - Adopts the latest content from the incoming operation.
 * - Retains original pre-operation snapshot if present.
 * - Monotonically updates localRevision to the maximum of both.
 * - Resets attempt count and backoff timers so fresh edits are attempted promptly.
 *
 * @param existingOp - Existing operation in 'queued' status
 * @param incomingOp - Incoming operation with newer content
 * @returns Merged IDBOperation
 */
export function coalesceOperations(existingOp: IDBOperation, incomingOp: IDBOperation): IDBOperation {
    const mergedRevision = Math.max(
        existingOp.localRevision ?? 0,
        incomingOp.localRevision ?? 0
    );

    return {
        ...existingOp,
        content: incomingOp.content,
        timestamp: incomingOp.timestamp || Date.now(),
        localRevision: mergedRevision > 0 ? mergedRevision : undefined,
        status: 'queued',
        attempts: 0,
        nextRetryAt: undefined,
        lastError: undefined,
        synced: false,
        isEncrypted: incomingOp.isEncrypted !== undefined ? incomingOp.isEncrypted : existingOp.isEncrypted,
        snapshot: existingOp.snapshot || incomingOp.snapshot,
    };
}
