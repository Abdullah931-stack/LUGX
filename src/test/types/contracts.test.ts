/**
 * Unit & Contract Verification Suite: Phase 5 Contracts Dictionary
 *
 * Verifies compile-time type invariants and runtime Zod validation gates
 * for DocumentStoragePayload, RFC 7807 ProblemDetails, SyncContracts, and AIContracts.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  type DocumentStoragePayload,
  type PlaintextStoragePayload,
  type EncryptedStoragePayload,
  documentStoragePayloadSchema,
  plaintextStoragePayloadSchema,
  encryptedStoragePayloadSchema,
  isPlaintextPayload,
  isEncryptedPayload,
} from '@/types/storage-payload';
import {
  type ProblemDetails,
  problemDetailsSchema,
  createProblemDetails,
} from '@/types/problem-details';
import {
  syncOperationSchema,
  syncPushBatchSchema,
  syncPullRequestSchema,
  syncPullResponseSchema,
  type SyncOperationContract,
} from '@/types/sync-contracts';
import {
  aiRequestSchema,
  aiReservationSchema,
  aiCommitReservationSchema,
  aiRefundReservationSchema,
  aiQuotaStatusSchema,
  type AIRequestContract,
} from '@/types/ai-contracts';

describe('Phase 5: DocumentStoragePayload Discriminated Union', () => {
  const validMetadata = {
    version: 1,
    algorithm: 'AES-GCM-256',
    keyId: 'key-test-uuid',
    salt: 'c2FsdC1leGFtcGxl',
    iv: 'aXYtZXhhbXBsZQ==',
    kdfIterations: 600000,
  };

  it('strictly validates compile-time assignments and runtime guards', () => {
    const plaintext: PlaintextStoragePayload = {
      type: 'plaintext',
      content: '# Typed Plaintext',
      isEncrypted: false,
      encryptionMetadata: null,
    };
    const encrypted: EncryptedStoragePayload = {
      type: 'encrypted',
      ciphertextBase64: 'U29tZVRleHQ=',
      isEncrypted: true,
      encryptionMetadata: validMetadata,
    };
    const doc1: DocumentStoragePayload = plaintext;
    const doc2: DocumentStoragePayload = encrypted;
    expect(isPlaintextPayload(doc1)).toBe(true);
    expect(isEncryptedPayload(doc2)).toBe(true);
  });

  it('accepts and validates a strictly typed plaintext payload', () => {
    const rawPlaintext = {
      type: 'plaintext',
      content: '# Hello Plaintext World',
      isEncrypted: false,
      encryptionMetadata: null,
    };

    const parsed = documentStoragePayloadSchema.parse(rawPlaintext);
    expect(parsed.type).toBe('plaintext');
    expect(isPlaintextPayload(parsed)).toBe(true);
    expect(isEncryptedPayload(parsed)).toBe(false);

    if (isPlaintextPayload(parsed)) {
      expect(parsed.content).toBe('# Hello Plaintext World');
      expect(parsed.isEncrypted).toBe(false);
      expect(parsed.encryptionMetadata).toBeNull();
    }
  });

  it('accepts and validates a strictly typed encrypted payload', () => {
    const rawEncrypted = {
      type: 'encrypted',
      ciphertextBase64: 'U29tZSBlbmNyeXB0ZWQgY2lwaGVydGV4dCBjb250ZW50',
      isEncrypted: true,
      encryptionMetadata: validMetadata,
    };

    const parsed = documentStoragePayloadSchema.parse(rawEncrypted);
    expect(parsed.type).toBe('encrypted');
    expect(isEncryptedPayload(parsed)).toBe(true);
    expect(isPlaintextPayload(parsed)).toBe(false);

    if (isEncryptedPayload(parsed)) {
      expect(parsed.ciphertextBase64).toBe('U29tZSBlbmNyeXB0ZWQgY2lwaGVydGV4dCBjb250ZW50');
      expect(parsed.isEncrypted).toBe(true);
      expect(parsed.encryptionMetadata.algorithm).toBe('AES-GCM-256');
    }
  });

  it('rejects plaintext payload attempting to pass isEncrypted: true (LUGX-004)', () => {
    const dangerousLeak = {
      type: 'plaintext',
      content: 'Unencrypted secret data',
      isEncrypted: true, // Invalid invariant!
      encryptionMetadata: null,
    };

    expect(() => documentStoragePayloadSchema.parse(dangerousLeak)).toThrow(ZodError);
    expect(() => plaintextStoragePayloadSchema.parse(dangerousLeak)).toThrow(ZodError);
  });

  it('rejects plaintext payload containing encryptionMetadata (LUGX-004)', () => {
    const anomalousPlaintext = {
      type: 'plaintext',
      content: 'Plaintext data',
      isEncrypted: false,
      encryptionMetadata: validMetadata, // Incompatible with plaintext!
    };

    expect(() => documentStoragePayloadSchema.parse(anomalousPlaintext)).toThrow(ZodError);
  });

  it('rejects encrypted payload with null encryptionMetadata (LUGX-070)', () => {
    const nullMetadataPayload = {
      type: 'encrypted',
      ciphertextBase64: 'U29tZSBlbmNyeXB0ZWQgZGF0YQ==',
      isEncrypted: true,
      encryptionMetadata: null, // Prohibited by LUGX-070
    };

    expect(() => documentStoragePayloadSchema.parse(nullMetadataPayload)).toThrow(ZodError);
    expect(() => encryptedStoragePayloadSchema.parse(nullMetadataPayload)).toThrow(ZodError);
  });

  it('rejects encrypted payload with isEncrypted: false (LUGX-019)', () => {
    const forgedEncrypted = {
      type: 'encrypted',
      ciphertextBase64: 'U29tZSBlbmNyeXB0ZWQgZGF0YQ==',
      isEncrypted: false,
      encryptionMetadata: validMetadata,
    };

    expect(() => documentStoragePayloadSchema.parse(forgedEncrypted)).toThrow(ZodError);
  });

  it('rejects payloads with extraneous properties (.strict() defense)', () => {
    const extraPropertyPayload = {
      type: 'plaintext',
      content: 'text',
      isEncrypted: false,
      encryptionMetadata: null,
      injectedField: 'malicious',
    };

    expect(() => documentStoragePayloadSchema.parse(extraPropertyPayload)).toThrow(ZodError);
  });
});

describe('Phase 5: RFC 7807 ProblemDetails Contracts', () => {
  it('successfully creates a compliant RFC 7807 error object', () => {
    const problemInput: ProblemDetails = {
      type: 'urn:lugx:error:sync:conflict',
      title: 'Conflict Detected',
      status: 409,
      detail: 'ETag mismatch between local revision and remote version',
      instance: '/api/files/123e4567-e89b-12d3-a456-426614174000',
      correlationId: 'req-c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd',
      retryAfterSeconds: 5,
    };

    const problem = createProblemDetails(problemInput);
    expect(problem.status).toBe(409);
    expect(problem.correlationId).toBe('req-c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd');
    expect(problem.retryAfterSeconds).toBe(5);
  });

  it('accepts RFC 7807 invalidParams validation extension', () => {
    const problemWithParams = {
      type: 'urn:lugx:error:validation',
      title: 'Bad Request',
      status: 400,
      detail: 'Request body failed schema verification',
      instance: '/api/files',
      correlationId: 'req-test-uuid',
      invalidParams: [
        { name: 'content', reason: 'Field is required' },
        { name: 'version', reason: 'Must be positive integer' },
      ],
    };

    const validated = problemDetailsSchema.parse(problemWithParams);
    expect(validated.invalidParams).toHaveLength(2);
    expect(validated.invalidParams?.[0].name).toBe('content');
  });

  it('rejects problem details with invalid HTTP status codes', () => {
    const invalidStatus = {
      type: 'urn:lugx:error:unknown',
      title: 'Invalid Status',
      status: 99, // Out of HTTP range
      detail: 'Test',
      instance: '/api/test',
      correlationId: 'corr-id',
    };

    expect(() => problemDetailsSchema.parse(invalidStatus)).toThrow(ZodError);

    const outOfBoundsStatus = {
      ...invalidStatus,
      status: 600,
    };
    expect(() => problemDetailsSchema.parse(outOfBoundsStatus)).toThrow(ZodError);
  });

  it('rejects problem details missing mandatory RFC 7807 properties', () => {
    const missingCorrelation = {
      type: 'urn:lugx:error:auth',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication token required',
      instance: '/api/files',
      // correlationId missing!
    };

    expect(() => problemDetailsSchema.parse(missingCorrelation)).toThrow(ZodError);
  });
});

describe('Phase 5: Sync Contracts & Versioning Invariants', () => {
  it('validates a standard sync operation with localRevision and baseVersion', () => {
    const op: SyncOperationContract = {
      id: 'op-uuid-1',
      operationId: 'idem-op-1',
      fileId: 'file-uuid-123',
      baseVersion: 4,
      localRevision: 12,
      sentRevision: 11,
      operationType: 'update',
      position: 0,
      content: '# Updated Header',
      timestamp: Date.now(),
      isEncrypted: false,
    };

    const parsed = syncOperationSchema.parse(op);
    expect(parsed.localRevision).toBe(12);
    expect(parsed.baseVersion).toBe(4);
    expect(parsed.sentRevision).toBe(11);
  });

  it('rejects sync operations with non-positive localRevision', () => {
    const invalidOp = {
      id: 'op-uuid-1',
      operationId: 'idem-op-1',
      fileId: 'file-uuid-123',
      baseVersion: 4,
      localRevision: 0, // Must be positive integer!
      operationType: 'update',
      position: 0,
      content: 'text',
      timestamp: Date.now(),
    };

    expect(() => syncOperationSchema.parse(invalidOp)).toThrow(ZodError);
  });

  it('rejects sync operations with unsupported operationType', () => {
    const invalidTypeOp = {
      id: 'op-uuid-1',
      operationId: 'idem-op-1',
      fileId: 'file-uuid-123',
      baseVersion: 1,
      localRevision: 1,
      operationType: 'unsupported_op',
      position: 0,
      content: 'text',
      timestamp: Date.now(),
    };

    expect(() => syncOperationSchema.parse(invalidTypeOp)).toThrow(ZodError);
  });

  it('validates batch push payload and pull response schema', () => {
    const batch = {
      operations: [
        {
          id: 'op-1',
          operationId: 'idem-1',
          fileId: 'file-1',
          baseVersion: 1,
          localRevision: 1,
          operationType: 'insert' as const,
          position: 0,
          content: 'Hello',
          timestamp: 1700000000000,
        },
      ],
      clientTimestamp: 1700000000005,
      deviceId: 'device-test-1',
    };

    const validatedBatch = syncPushBatchSchema.parse(batch);
    expect(validatedBatch.operations).toHaveLength(1);

    const pullResponse = {
      files: [
        {
          id: 'file-1',
          title: 'Notes',
          content: 'Content',
          etag: 'etag12345678',
          version: 2,
          parentFolderId: null,
          isFolder: false,
          isEncrypted: false,
          encryptionMetadata: null,
          deletedAt: null,
          updatedAt: '2026-09-29T20:00:00.000Z',
          createdAt: '2026-09-29T19:00:00.000Z',
        },
      ],
      hasMore: false,
      nextCursor: null,
      syncTimestamp: '2026-09-29T20:05:00.000Z',
      serverRevision: 42,
    };

    const validatedPull = syncPullResponseSchema.parse(pullResponse);
    expect(validatedPull.files).toHaveLength(1);
    expect(validatedPull.serverRevision).toBe(42);

    const pullRequest = {
      updatedAfter: '2026-09-29T20:00:00.000Z',
      cursor: 'cursor_token_123',
      limit: 50,
      clientKnownVersion: 5,
      clientKnownRevision: 10,
    };
    const validatedReq = syncPullRequestSchema.parse(pullRequest);
    expect(validatedReq.limit).toBe(50);
  });
});

describe('Phase 5: AI Service Contracts & Fingerprinting', () => {
  const sample64HexHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  it('validates AI stream request requiring operationId and requestHash', () => {
    const aiReq: AIRequestContract = {
      operationId: 'ai-op-987',
      requestHash: sample64HexHash,
      prompt: 'Summarize the document.',
      clientTimestamp: Date.now(),
      stream: true,
    };

    const validated = aiRequestSchema.parse(aiReq);
    expect(validated.operationId).toBe('ai-op-987');
    expect(validated.requestHash).toHaveLength(64);
  });

  it('rejects AI request with invalid requestHash length', () => {
    const invalidReq = {
      operationId: 'ai-op-987',
      requestHash: 'short-hash-not-64-chars',
      prompt: 'Translate to Arabic',
      clientTimestamp: Date.now(),
    };

    expect(() => aiRequestSchema.parse(invalidReq)).toThrow(ZodError);
  });

  it('validates AI quota reservation, commit, and refund contracts', () => {
    const reservation = {
      reservationId: 'res-123',
      operationId: 'op-123',
      userId: 'usr-123',
      requestHash: sample64HexHash,
      estimatedTokens: 1000,
      creditsReserved: 10,
      expiresAt: Date.now() + 60000,
    };

    const parsedReservation = aiReservationSchema.parse(reservation);
    expect(parsedReservation.creditsReserved).toBe(10);

    const commitment = {
      reservationId: 'res-123',
      operationId: 'op-123',
      requestHash: sample64HexHash,
      actualTokensUsed: 850,
      creditsDeducted: 8,
    };

    const parsedCommit = aiCommitReservationSchema.parse(commitment);
    expect(parsedCommit.actualTokensUsed).toBe(850);

    const refund = {
      reservationId: 'res-123',
      operationId: 'op-123',
      requestHash: sample64HexHash,
      reason: 'User cancelled stream before completion',
    };

    const parsedRefund = aiRefundReservationSchema.parse(refund);
    expect(parsedRefund.reason).toContain('cancelled');
  });

  it('validates AI user quota status response contract', () => {
    const quota = {
      allowed: true,
      remainingQuota: 5000,
      tier: 'pro',
      resetAt: Date.now() + 86400000,
    };

    const parsedQuota = aiQuotaStatusSchema.parse(quota);
    expect(parsedQuota.allowed).toBe(true);
    expect(parsedQuota.remainingQuota).toBe(5000);
  });
});
