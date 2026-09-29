/**
 * Synchronization Data Contracts & Runtime Validation Schemas
 *
 * Formalizes explicit versioning, revision tracking, and batch sync contracts
 * across the client IndexedDB layer and remote API endpoints.
 *
 * Remediates: LUGX-004, LUGX-019, LUGX-174, LUGX-175
 */

import { z } from 'zod';
import { fileEncryptionMetadataSchema } from './storage-payload';
import type { FileEncryptionMetadata } from '@/lib/db/schema';

/**
 * Permissible operation types in the synchronization log
 */
export type SyncOperationType = 'insert' | 'delete' | 'update' | 'create' | 'rename' | 'move';

export const syncOperationTypeSchema = z.enum([
  'insert',
  'delete',
  'update',
  'create',
  'rename',
  'move',
]);

/**
 * Standard Sync Operation Contract
 * Requires localRevision and baseVersion to prevent sequence collapse.
 */
export interface SyncOperationContract {
  /** Unique operation identifier (UUID) */
  readonly id: string;
  /** Idempotent operation identifier */
  readonly operationId: string;
  /** Target file UUID */
  readonly fileId: string;
  /** Server version on which this local operation was based */
  readonly baseVersion: number;
  /** Monotonically increasing local revision counter */
  readonly localRevision: number;
  /** Last revision known to be acknowledged by the server */
  readonly sentRevision?: number;
  /** Type of delta or document mutation */
  readonly operationType: SyncOperationType;
  /** Character or structural position */
  readonly position: number;
  /** Payload content (Markdown source text or ciphertext) */
  readonly content: string;
  /** Client timestamp (milliseconds since epoch) */
  readonly timestamp: number;
  /** Zero-Knowledge encryption indicator */
  readonly isEncrypted?: boolean;
}

export const syncOperationSchema = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  fileId: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
  localRevision: z.number().int().positive(),
  sentRevision: z.number().int().positive().optional(),
  operationType: syncOperationTypeSchema,
  position: z.number().int().nonnegative(),
  content: z.string(),
  timestamp: z.number().int().positive(),
  isEncrypted: z.boolean().optional(),
}).strict();

/**
 * Batch Push Contract from Client to Server
 */
export interface SyncPushBatchContract {
  readonly operations: readonly SyncOperationContract[];
  readonly clientTimestamp: number;
  readonly deviceId?: string;
}

export const syncPushBatchSchema = z.object({
  operations: z.array(syncOperationSchema),
  clientTimestamp: z.number().int().positive(),
  deviceId: z.string().min(1).optional(),
}).strict();

/**
 * Pull Request Query Parameters Contract
 */
export interface SyncPullRequestContract {
  readonly updatedAfter?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly clientKnownVersion?: number;
  readonly clientKnownRevision?: number;
}

export const syncPullRequestSchema = z.object({
  updatedAfter: z.string().datetime().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  clientKnownVersion: z.number().int().nonnegative().optional(),
  clientKnownRevision: z.number().int().nonnegative().optional(),
}).strict();

/**
 * Individual File Representation in Sync Pull Response
 */
export interface SyncPullFileContract {
  readonly id: string;
  readonly title: string;
  readonly content: string | null;
  readonly etag: string | null;
  readonly version: number;
  readonly parentFolderId: string | null;
  readonly isFolder: boolean;
  readonly isEncrypted: boolean;
  readonly encryptionMetadata: FileEncryptionMetadata | null;
  readonly deletedAt: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

export const syncPullFileSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  content: z.string().nullable(),
  etag: z.string().nullable(),
  version: z.number().int().positive(),
  parentFolderId: z.string().nullable(),
  isFolder: z.boolean(),
  isEncrypted: z.boolean(),
  encryptionMetadata: fileEncryptionMetadataSchema.nullable(),
  deletedAt: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string(),
}).strict();

/**
 * Pull Response Contract from Server to Client
 */
export interface SyncPullResponseContract {
  readonly files: readonly SyncPullFileContract[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly syncTimestamp: string;
  readonly serverRevision?: number;
}

export const syncPullResponseSchema = z.object({
  files: z.array(syncPullFileSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  syncTimestamp: z.string(),
  serverRevision: z.number().int().nonnegative().optional(),
}).strict();
