/**
 * Document Storage Payload Contracts & Discriminated Union
 *
 * Enforces strict compile-time and runtime guarantees distinguishing between
 * unencrypted (plaintext) and Zero-Knowledge encrypted file payloads.
 *
 * Remediates: LUGX-004, LUGX-019, LUGX-048, LUGX-070, LUGX-071
 */

import { z } from 'zod';
import type { FileEncryptionMetadata } from '@/server/db';
export type { FileEncryptionMetadata };

/**
 * Strict schema for FileEncryptionMetadata
 */
export const fileEncryptionMetadataSchema = z.object({
  version: z.number().int().positive(),
  algorithm: z.string().min(1),
  keyId: z.string().min(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  kdfIterations: z.number().int().positive().optional(),
}).strict();

/**
 * Unencrypted (Plaintext) Storage Payload
 * Invariant: isEncrypted must be false and encryptionMetadata must be null.
 */
export interface PlaintextStoragePayload {
  readonly type: 'plaintext';
  readonly content: string;
  readonly isEncrypted: false;
  readonly encryptionMetadata: null;
}

export const plaintextStoragePayloadSchema = z.object({
  type: z.literal('plaintext'),
  content: z.string(),
  isEncrypted: z.literal(false),
  encryptionMetadata: z.null(),
}).strict();

/**
 * Zero-Knowledge Encrypted Storage Payload
 * Invariant: isEncrypted must be true and encryptionMetadata must be present and valid.
 */
export interface EncryptedStoragePayload {
  readonly type: 'encrypted';
  readonly ciphertextBase64: string;
  readonly isEncrypted: true;
  readonly encryptionMetadata: FileEncryptionMetadata;
}

export const encryptedStoragePayloadSchema = z.object({
  type: z.literal('encrypted'),
  ciphertextBase64: z.string().min(1),
  isEncrypted: z.literal(true),
  encryptionMetadata: fileEncryptionMetadataSchema,
}).strict();

/**
 * Discriminated Union of Storage Payloads
 */
export type DocumentStoragePayload = PlaintextStoragePayload | EncryptedStoragePayload;

export const documentStoragePayloadSchema = z.discriminatedUnion('type', [
  plaintextStoragePayloadSchema,
  encryptedStoragePayloadSchema,
]);

/**
 * Type guard for PlaintextStoragePayload
 */
export function isPlaintextPayload(payload: DocumentStoragePayload): payload is PlaintextStoragePayload {
  return payload.type === 'plaintext' && payload.isEncrypted === false && payload.encryptionMetadata === null;
}

/**
 * Type guard for EncryptedStoragePayload
 */
export function isEncryptedPayload(payload: DocumentStoragePayload): payload is EncryptedStoragePayload {
  return payload.type === 'encrypted' && payload.isEncrypted === true && payload.encryptionMetadata !== null;
}
