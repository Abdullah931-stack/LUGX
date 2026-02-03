/**
 * Sync System - Main Index
 */

// Types
export type { IDBFile, IDBOperation, IDBSyncMetadata, OperationType, SyncConflict, SyncQueueItem, IDBSchemaInfo } from './idb-types';
export { IDB_CONFIG } from './idb-types';

// IndexedDB
export { indexedDBManager, IndexedDBManager } from './indexeddb';

// ETag
export { generateETag, generateETagSync, isValidETag, compareETags, parseETagHeader, formatETagHeader } from './etag-generator';

// Error Handling
export { SyncErrorType, syncErrorHandler, SyncErrorHandler } from './error-handler';
export type { SyncError, ErrorCallback } from './error-handler';

// Rollback
export { syncRollback, SyncRollback } from './rollback';
export type { SyncCheckpoint } from './rollback';

// Connection
export { connectionDetector, ConnectionDetector, calculateBackoffDelay, withBackoff } from './connection-detector';
export type { ConnectionState, ConnectionCallback, BackoffConfig } from './connection-detector';

// Concurrency
export { concurrencyManager, ConcurrencyManager } from './concurrency-manager';
export type { LockStatus } from './concurrency-manager';

// Sync Manager
export { syncManager, SyncManager } from './sync-manager';
export type { SyncStatus, FileSyncResult, SyncResult, SyncStatusCallback, ConflictCallback, SyncManagerConfig } from './sync-manager';

// Conflict Resolution
export { conflictResolver, ConflictResolver } from './conflict-resolver';
export type { DiffOp, MergeResult, ResolutionStrategy } from './conflict-resolver';

// Performance
export { syncPerformanceMonitor, SyncPerformanceMonitor } from './performance-monitor';
export type { MetricType, PerformanceMetric, MetricStats, PerformanceReport } from './performance-monitor';

// GC
export { operationsGC, OperationsGarbageCollector } from './operations-gc';
export type { GCConfig, GCResult } from './operations-gc';

// Encryption
export { encryptionManager, EncryptionManager, isEncryptionSupported } from './encryption';
export type { EncryptionConfig, EncryptedData } from './encryption';
