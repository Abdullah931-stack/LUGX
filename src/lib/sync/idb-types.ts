/**
 * IndexedDB Type Definitions for Sync System
 * 
 * This module defines all TypeScript interfaces used by the IndexedDB layer
 * for offline storage and synchronization.
 */

/**
 * Authoritative source text format across editor, sync layer, and backend
 */
export type MarkdownSource = string;

/**
 * Metadata for end-to-end encrypted envelopes (Zero-Knowledge Vault)
 */
export interface EncryptedEnvelopeMetadata {
    version: number;
    algorithm: string;
    keyId: string;
    salt: string;
    iv: string;
    kdfIterations?: number;
}

/**
 * Represents a file stored in IndexedDB for offline access
 */
export interface IDBFile {
    /** Unique file identifier (matches server-side UUID) */
    id: string;
    /** File content (Normalized Markdown text in-memory) */
    content: MarkdownSource;
    /** ETag for change detection (SHA-256 hash, first 32 chars) */
    etag: string;
    /** Last modification timestamp (local) */
    lastModified: number;
    /** Last successful sync timestamp */
    lastSyncedAt: number;
    /** Whether file has unsynced local changes */
    isDirty: boolean;
    /** Monotonically increasing version number */
    version: number;
    /** File title */
    title: string;
    /** Parent folder ID (null for root) */
    parentFolderId: string | null;
    /** Whether this is a folder */
    isFolder: boolean;
    /** Whether this file is end-to-end encrypted (Zero-Knowledge Vault file) */
    isEncrypted?: boolean;
    /** Envelope encryption metadata if isEncrypted is true */
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
    /** Pristine base snapshot before local uncommitted edits were made */
    baseSnapshot?: {
        content: MarkdownSource;
        etag: string;
        version: number;
        title?: string;
        parentFolderId?: string | null;
        isEncrypted?: boolean;
        encryptionMetadata?: EncryptedEnvelopeMetadata | null;
    };
}

/**
 * Types of operations that can be recorded
 */
export type OperationType = 'insert' | 'delete' | 'update' | 'create' | 'rename' | 'move';

/**
 * Status lifecycle of a sync operation
 */
export type OperationStatus =
    | 'queued'
    | 'syncing'
    | 'synced'
    | 'failed'
    | 'conflict'
    | 'rollback_failed'
    | 'dead_letter';

/**
 * Represents a single edit operation for Operation Log
 * Used for deterministic queueing, delta sync, conflict resolution and rollback
 */
export interface IDBOperation {
    /** Unique operation identifier (keyPath in IndexedDB) */
    id: string;
    /** Unique idempotent operation identifier (matches id) */
    operationId?: string;
    /** Owner user ID for security and isolation */
    userId?: string;
    /** File this operation belongs to */
    fileId: string;
    /** Base version expected for optimistic concurrency control */
    baseVersion?: number;
    /** Current lifecycle status of the operation */
    status?: OperationStatus;
    /** Number of sync attempts executed */
    attempts?: number;
    /** Next retry timestamp in ms (for exponential backoff) */
    nextRetryAt?: number;
    /** Last error message if failed */
    lastError?: string;
    /** Type of operation performed */
    operationType: OperationType;
    /** Position in content where operation occurred */
    position: number;
    /** Content involved in the operation (MarkdownSource) */
    content: MarkdownSource;
    /** Timestamp when operation was performed */
    timestamp: number;
    /** Whether operation has been synced to server */
    synced: boolean;
    /** Previous content (for undo/conflict resolution) */
    previousContent?: MarkdownSource;
    /** Whether operation belongs to an encrypted file */
    isEncrypted?: boolean;
    /** Pre-operation snapshot for safe rollback on failure */
    snapshot?: {
        content: MarkdownSource;
        etag: string;
        version: number;
    };
}

/**
 * Error raised when a local encrypted IndexedDB record cannot be decrypted
 */
export class CorruptedLocalRecordError extends Error {
    readonly code = 'CORRUPTED_LOCAL_RECORD';
    constructor(
        public readonly storeName: string,
        public readonly recordId: string,
        message = 'Local record decryption failed: ciphertext corrupted or auth tag mismatch'
    ) {
        super(`[${storeName}:${recordId}] ${message}`);
        this.name = 'CorruptedLocalRecordError';
        Object.setPrototypeOf(this, CorruptedLocalRecordError.prototype);
    }
}

/**
 * Sync metadata stored per-user for tracking sync state
 */
export interface IDBSyncMetadata {
    /** User identifier */
    id: string;
    /** Last successful full sync timestamp */
    lastSyncedAt: number;
    /** Cursor for paginated sync (if any) */
    syncCursor?: string;
    /** Whether a sync is currently in progress */
    syncInProgress: boolean;
    /** Number of pending operations awaiting sync */
    pendingOperationsCount: number;
}

/**
 * State snapshot of a file version involved in a conflict
 */
export interface ConflictFileState {
    content: MarkdownSource;
    etag: string;
    lastModified: number;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    deleted?: boolean;
}

/**
 * Conflict data structure for resolution UI
 */
export interface SyncConflict {
    /** File ID with conflict */
    fileId: string;
    /** Local version of the file */
    localVersion: ConflictFileState;
    /** Server version of the file */
    serverVersion: ConflictFileState;
    /** Pristine base version before local modifications occurred */
    baseVersion?: ConflictFileState;
    /** Operations performed locally since last sync */
    operations: IDBOperation[];
    /** Timestamp when conflict was detected */
    detectedAt: number;
    /** Conflict classification */
    type?: 'content' | 'metadata' | 'delete_conflict';
}

/**
 * Sync queue item for prioritized synchronization
 */
export interface SyncQueueItem {
    /** Unique operation identifier */
    operationId?: string;
    /** File ID to sync */
    fileId: string;
    /** Priority level (1 = highest, 3 = lowest) */
    priority: 1 | 2 | 3;
    /** Timestamp when item was added to queue */
    addedAt: number;
    /** Number of retry attempts */
    retryCount: number;
    /** Last error message if any */
    lastError?: string;
}

/**
 * Database schema version info
 */
export interface IDBSchemaInfo {
    /** Current schema version */
    version: number;
    /** Last migration applied */
    lastMigration: string;
    /** Timestamp of last migration */
    migratedAt: number;
}

/**
 * Constants for IndexedDB configuration
 */
export const IDB_CONFIG = {
    /** Default database name prefix */
    DB_NAME_PREFIX: 'textai_db',
    /** Default database name for backward compatibility */
    DB_NAME: 'textai_db',
    /** Current database version */
    DB_VERSION: 1,
    /** Object store names */
    STORES: {
        FILES: 'files',
        OPERATIONS: 'operations',
        SYNC_METADATA: 'sync_metadata',
    },
    /** Maximum age for operations before garbage collection (7 days) */
    MAX_OPERATION_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    /** Maximum operations per file before compaction */
    MAX_OPERATIONS_PER_FILE: 1000,
} as const;

/**
 * Get user-scoped database name
 * 
 * @param userId - Unique user identifier
 * @returns Partitioned database name for the user
 */
export function getDatabaseName(userId?: string): string {
    if (!userId || !userId.trim()) {
        throw new Error('Valid userId is required for IndexedDB operations');
    }
    return `${IDB_CONFIG.DB_NAME_PREFIX}_${userId.trim()}`;
}

