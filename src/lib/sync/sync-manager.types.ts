/**
 * Sync Manager Types
 * 
 * Core domain types, callback signatures, and configuration interfaces
 * for synchronization coordination and conflict management.
 */

import type { IndexedDBManager } from './indexeddb';
import type { EncryptedEnvelopeMetadata } from './idb-types';

/**
 * Maximum number of quarantined encrypted conflicts held in-memory before backpressure eviction
 */
export const MAX_QUARANTINED_CONFLICTS = 100;

/**
 * Diagnostics and metrics for isolated encrypted conflicts
 */
export interface QuarantineDiagnostics {
    totalQuarantined: number;
    staleCount: number;             // Conflicts quarantined for longer than 24 hours
    oldestQuarantinedAt: number | null;  // Timestamp ms
    newestQuarantinedAt: number | null;  // Timestamp ms
    isAtCapacity: boolean;          // True if quarantine has reached capacity limit
}

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
