/**
 * Sync System - Main Index
 */

// Types
export type { IDBFile, IDBOperation, IDBSyncMetadata, OperationType, OperationStatus, SyncConflict, SyncQueueItem, IDBSchemaInfo, MarkdownSource } from './idb-types';
export { IDB_CONFIG, getDatabaseName } from './idb-types';

// IndexedDB
export { indexedDBManager, IndexedDBManager, createIndexedDBManager } from './indexeddb';

// ETag & Markdown Normalization
export { generateETag, generateETagSync, isValidETag, compareETags, parseETagHeader, formatETagHeader, normalizeMarkdownSource } from './etag-generator';

// Error Handling
export { SyncErrorType, syncErrorHandler, SyncErrorHandler, isRetryableError } from './error-handler';
export type { SyncError, ErrorCallback } from './error-handler';

// Rollback
export { syncRollback, SyncRollback, createSyncRollback } from './rollback';
export type { SyncCheckpoint } from './rollback';

// Connection
export { connectionDetector, ConnectionDetector, calculateBackoffDelay, withBackoff } from './connection-detector';
export type { ConnectionState, ConnectionCallback, BackoffConfig } from './connection-detector';

// Concurrency
export { concurrencyManager, ConcurrencyManager } from './concurrency-manager';
export type { LockStatus } from './concurrency-manager';

// Sync Manager
export { syncManager, SyncManager, createSyncManager } from './sync-manager';
export type { SyncStatus, FileSyncResult, SyncResult, SyncStatusCallback, ConflictCallback, SyncManagerConfig } from './sync-manager';


// Conflict Resolution
export { conflictResolver, ConflictResolver } from './conflict-resolver';
export type { DiffOp, MergeResult, ResolutionStrategy } from './conflict-resolver';

// Performance
export { syncPerformanceMonitor, SyncPerformanceMonitor } from './performance-monitor';
export type { MetricType, PerformanceMetric, MetricStats, PerformanceReport } from './performance-monitor';

// GC
export { operationsGC, OperationsGarbageCollector, createOperationsGC } from './operations-gc';
export type { GCConfig, GCResult } from './operations-gc';

// Encryption
export { encryptionManager, EncryptionManager, isEncryptionSupported } from './encryption';
export type { EncryptionConfig, EncryptedData } from './encryption';
