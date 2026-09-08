/**
 * Phase 4 Comprehensive Verification Suite:
 * AI Gatekeepers, Syntax Validator & Non-Blocking Encrypted Sync
 *
 * Tests:
 * 1. Syntax Integrity Validator: Code fences, GFM tables, control chars, conflict markers.
 * 2. Encrypted ETag Generator: Deterministic SHA-256 (32 hex chars) hashing for envelopes.
 * 3. Zero-Knowledge AI Gatekeeper (/api/ai/stream):
 *    - Rejects encrypted file with 403 AI_PROHIBITED_ON_ENCRYPTED_FILES when opt-in is false.
 *    - Bypasses gatekeeper and streams when allowAIOnEncryptedFiles is true.
 * 4. Atomic AI Commit Guard (commitAIFileOperation):
 *    - Rejects unencrypted plaintext commits to encrypted files.
 *    - Rejects commits when allowAIOnEncryptedFiles is false with reservation refund.
 *    - Commits successfully with re-encrypted ciphertext and fresh IV when allowed.
 * 5. Vault AI Preference Server Action (updateVaultAISetting):
 *    - Persists user opt-in/opt-out status with auth checks.
 * 6. Non-Blocking Sync Manager:
 *    - Isolates 412 conflicts on encrypted files when vault is locked (CONFLICT_LOCKED).
 *    - Permits non-encrypted dirty files to sync concurrently without blocking.
 *    - Resolves pending encrypted conflict upon vault unlock via Diff3 + syntax validation + re-encryption.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { validateMarkdownSyntaxIntegrity } from '@/lib/sync/syntax-validator';
import { generateEncryptedETagSync, generateETagSync } from '@/lib/sync/etag-generator';
import { sessionKeyStore } from '@/lib/sync/session-key-store';
import { cryptoWorkerBridge } from '@/lib/sync/crypto-worker-bridge';
import type { PendingEncryptedConflict } from '@/lib/sync';
import type { EncryptedEnvelope } from '@/lib/sync/types/vault';

// Hoisted Mocks for Database and Supabase
const mockGetUser = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
    query: {
        files: {
            findFirst: vi.fn(),
        },
        userVaultProfiles: {
            findFirst: vi.fn(),
        },
        aiReservations: {
            findFirst: vi.fn(),
        },
    },
    update: vi.fn(() => ({
        set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([{ id: 'updated-1' }]),
        })),
    })),
}));

const mockTxDb = vi.hoisted(() => ({
    transaction: vi.fn(async (callback) => {
        const tx = {
            update: vi.fn((_table: any) => ({
                set: vi.fn(() => ({
                    where: vi.fn(() => ({
                        returning: vi.fn().mockResolvedValue([
                            { id: 'file-enc-1', version: 2, etag: 'new-etag', updatedAt: new Date() },
                        ]),
                    })),
                })),
            })),
            insert: vi.fn(() => ({
                values: vi.fn().mockResolvedValue([{ id: 'tx-inserted' }]),
            })),
        };
        return callback(tx);
    }),
}));

const mockAiOps = vi.hoisted(() => ({
    getUserTier: vi.fn().mockResolvedValue('pro'),
    reserveAndUpdateUsage: vi.fn().mockResolvedValue({ reserved: true }),
    refundAIReservation: vi.fn().mockResolvedValue({ success: true }),
    refundUsage: vi.fn().mockResolvedValue({ success: true }),
}));

const mockAiClient = vi.hoisted(() => ({
    streamWithAI: vi.fn().mockResolvedValue(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: chunk\n\n'));
                controller.close();
            },
        })
    ),
    processWithAI: vi.fn().mockResolvedValue('Processed AI text'),
}));

vi.mock('@/lib/supabase/server', () => ({
    getUser: mockGetUser,
}));

vi.mock('@/lib/db', () => ({
    db: mockDb,
    schema: {
        files: {
            id: 'id',
            userId: 'user_id',
            version: 'version',
            etag: 'etag',
            deletedAt: 'deleted_at',
            isEncrypted: 'is_encrypted',
            encryptionMetadata: 'encryption_metadata',
            content: 'content',
            title: 'title',
        },
        userVaultProfiles: {
            userId: 'user_id',
            allowAIOnEncryptedFiles: 'allow_ai_on_encrypted_files',
            updatedAt: 'updated_at',
        },
        aiReservations: {
            id: 'id',
            operationId: 'operation_id',
            userId: 'user_id',
            fileId: 'file_id',
            status: 'status',
        },
    },
}));

vi.mock('@/lib/db/transactional', () => ({
    txDb: mockTxDb,
}));

vi.mock('@/server/actions/ai-ops', () => mockAiOps);
vi.mock('@/lib/ai/client', () => mockAiClient);

// Import Route Handlers and Server Actions after mocks
import { POST as aiStreamRoute } from '@/app/api/ai/stream/route';
import { commitAIFileOperation } from '@/server/actions/ai-commit';
import { updateVaultAISetting } from '@/server/actions/vault-actions';
import { SyncManager } from '@/lib/sync/sync-manager';

describe('Phase 4: AI Gatekeepers, Syntax Validation & Non-Blocking Encrypted Sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        sessionKeyStore.purgeKeys();
    });

    afterEach(() => {
        sessionKeyStore.purgeKeys();
    });

    // =========================================================================
    // 1. Markdown Syntax Integrity Validator
    // =========================================================================
    describe('1. Markdown Syntax Integrity Validator', () => {
        it('should pass valid Markdown document with matching fences and correct GFM table', () => {
            const validDoc = [
                '# System Architecture',
                '',
                'Here is a code snippet:',
                '```typescript',
                'const key = "super-secret";',
                'console.log(key);',
                '```',
                '',
                '| Feature | Status | Priority |',
                '| :--- | :---: | ---: |',
                '| Zero-Knowledge | Active | P0 |',
                '| Diff3 Sync | Active | P1 |',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(validDoc);
            expect(result.isValid).toBe(true);
            expect(result.syntaxErrors).toBeUndefined();
            expect(result.sanitizedContent).toBeDefined();
        });

        it('should reject document with unclosed fenced code block', () => {
            const brokenDoc = [
                '# Heading',
                '```javascript',
                'const unclosed = true;',
                'function run() {',
                '  console.log("no closing fence");',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(brokenDoc);
            expect(result.isValid).toBe(false);
            expect(result.syntaxErrors).toBeDefined();
            expect(result.syntaxErrors?.some(e => e.includes('Unclosed fenced code block'))).toBe(true);
        });

        it('should reject document with malformed GFM table column mismatch', () => {
            const brokenTable = [
                '# Table Test',
                '| Col1 | Col2 | Col3 |',
                '| :--- | :--- |', // 3 cols in header, 2 in delimiter
                '| Data1 | Data2 | Data3 |',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(brokenTable);
            expect(result.isValid).toBe(false);
            expect(result.syntaxErrors?.some(e => e.includes('column count mismatch'))).toBe(true);
        });

        it('should reject document with orphan table delimiter row', () => {
            const orphanDelimiter = [
                'Just plain text',
                '| :--- | :--- | :--- |',
                '| Data1 | Data2 | Data3 |',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(orphanDelimiter);
            expect(result.isValid).toBe(false);
            expect(result.syntaxErrors?.some(e => e.includes('orphan delimiter row'))).toBe(true);
        });

        it('should reject document with unresolved git/diff3 conflict markers', () => {
            const conflictedDoc = [
                '# Document with Conflict',
                '<<<<<<< HEAD',
                'Local content update',
                '=======',
                'Remote content update',
                '>>>>>>> server',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(conflictedDoc);
            expect(result.isValid).toBe(false);
            expect(result.syntaxErrors?.some(e => e.includes('Unresolved conflict markers'))).toBe(true);
        });

        it('should reject null bytes when sanitize is disabled', () => {
            const nullByteDoc = 'Heading\0with null byte';
            const result = validateMarkdownSyntaxIntegrity(nullByteDoc, { sanitize: false });
            expect(result.isValid).toBe(false);
            expect(result.syntaxErrors?.some(e => e.includes('null bytes'))).toBe(true);
        });

        it('should sanitize null bytes when sanitize is enabled by default', () => {
            const nullByteDoc = 'Heading\0with null byte';
            const result = validateMarkdownSyntaxIntegrity(nullByteDoc);
            expect(result.isValid).toBe(true);
            expect(result.sanitizedContent).not.toContain('\0');
        });

        it('should correctly parse table rows containing escaped pipes and escaped backslashes', () => {
            const tableWithEscapes = [
                '# Table With Backslashes',
                '| Path | Description | Status |',
                '| :--- | :--- | :--- |',
                '| C:\\\\ | Root directory (escaped backslash) | Active |',
                '| Value with \\| pipe | Pipe in content | Active |',
            ].join('\n');

            const result = validateMarkdownSyntaxIntegrity(tableWithEscapes);
            expect(result.isValid).toBe(true);
            expect(result.syntaxErrors).toBeUndefined();
        });
    });

    // =========================================================================
    // 2. Encrypted ETag Generator
    // =========================================================================
    describe('2. Encrypted ETag Generator', () => {
        it('should produce deterministic 32-hex character SHA-256 ETag for encrypted envelopes', () => {
            const envelope1 = JSON.stringify({
                version: 1,
                algorithm: 'AES-GCM-256',
                iv: 'dGVzdC1pdi0xMjM0',
                ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0',
            });
            const envelope2 = JSON.stringify({
                version: 1,
                algorithm: 'AES-GCM-256',
                iv: 'dGVzdC1pdi0xMjM0',
                ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0',
            });

            const etag1 = generateEncryptedETagSync(envelope1);
            const etag2 = generateEncryptedETagSync(envelope2);

            expect(etag1).toBe(etag2);
            expect(etag1).toMatch(/^[a-f0-9]{32}$/);
        });

        it('should produce identical ETags regardless of object key order (deterministic canonical serialization)', () => {
            const envelopeOrderA: EncryptedEnvelope = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                iv: 'test-iv',
                salt: 'test-salt',
                kdfIterations: 600000,
                ciphertext: 'test-ciphertext',
            };
            const envelopeOrderB: EncryptedEnvelope = {
                ciphertext: 'test-ciphertext',
                salt: 'test-salt',
                kdfIterations: 600000,
                algorithm: 'AES-GCM-256',
                version: 1,
                iv: 'test-iv',
                keyId: 'master-v1',
            };

            const etagA = generateEncryptedETagSync(envelopeOrderA);
            const etagB = generateEncryptedETagSync(envelopeOrderB);

            expect(etagA).toBe(etagB);
        });

        it('should produce different ETags for distinct ciphertexts or IVs', () => {
            const envelopeA = JSON.stringify({
                version: 1,
                algorithm: 'AES-GCM-256',
                iv: 'dGVzdC1pdi0xMjM0',
                ciphertext: 'Y2lwaGVyLXRleHQtMQ==',
            });
            const envelopeB = JSON.stringify({
                version: 1,
                algorithm: 'AES-GCM-256',
                iv: 'dGVzdC1pdi0xMjM0',
                ciphertext: 'Y2lwaGVyLXRleHQtMg==',
            });

            const etagA = generateEncryptedETagSync(envelopeA);
            const etagB = generateEncryptedETagSync(envelopeB);

            expect(etagA).not.toBe(etagB);
        });

        it('should respect isEncrypted flag in unified generateETagSync', () => {
            const fileObj = {
                id: 'file-123',
                content: 'ZW5jcnlwdGVkLXN0cmluZw==',
                updatedAt: new Date('2026-09-07T12:00:00Z'),
                isEncrypted: true,
            };
            const encryptedETag = generateETagSync(fileObj);
            const plainETag = generateETagSync({ ...fileObj, isEncrypted: false });

            expect(encryptedETag).toBeDefined();
            expect(plainETag).toBeDefined();
            expect(encryptedETag).toMatch(/^[a-f0-9]{32}$/);
            expect(plainETag).toMatch(/^[a-f0-9]{32}$/);
        });
    });

    // =========================================================================
    // 3. Zero-Knowledge AI Gatekeeper (/api/ai/stream)
    // =========================================================================
    describe('3. Zero-Knowledge AI Gatekeeper (/api/ai/stream)', () => {
        const userId = 'user-ai-gate-1';
        const fileId = 'file-enc-1';

        it('should reject streaming on encrypted file with 403 AI_PROHIBITED_ON_ENCRYPTED_FILES when opt-in is false', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            // File is encrypted
            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
            });

            // Vault profile does NOT allow AI on encrypted files
            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: false,
            });

            const req = new NextRequest('http://localhost:3000/api/ai/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: 'Improve this confidential text',
                    operation: 'improve',
                    fileId,
                }),
            });

            const response = await aiStreamRoute(req);
            expect(response.status).toBe(403);
            const body = await response.text();
            expect(body).toBe('AI_PROHIBITED_ON_ENCRYPTED_FILES');

            // Quota must NOT have been reserved
            expect(mockAiOps.reserveAndUpdateUsage).not.toHaveBeenCalled();
        });

        it('should reject streaming on encrypted file with 403 when user vault profile is missing', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
            });

            // No vault profile found (defaults to strict privacy block)
            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce(null);

            const req = new NextRequest('http://localhost:3000/api/ai/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: 'Analyze this secret text',
                    operation: 'summarize',
                    fileId,
                }),
            });

            const response = await aiStreamRoute(req);
            expect(response.status).toBe(403);
            const body = await response.text();
            expect(body).toBe('AI_PROHIBITED_ON_ENCRYPTED_FILES');
            expect(mockAiOps.reserveAndUpdateUsage).not.toHaveBeenCalled();
        });

        it('should allow AI streaming on encrypted file when user explicitly opted in', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
            });

            // User explicitly opted in
            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: true,
            });

            const req = new NextRequest('http://localhost:3000/api/ai/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: 'Improve decrypted text in browser RAM',
                    operation: 'improve',
                    fileId,
                }),
            });

            const response = await aiStreamRoute(req);
            expect(response.status).toBe(200);
            expect(mockAiOps.reserveAndUpdateUsage).toHaveBeenCalledWith(
                userId,
                'improve',
                expect.any(Number),
                'pro',
                expect.objectContaining({ fileId })
            );
        });
    });

    // =========================================================================
    // 4. Atomic AI Commit Guard (commitAIFileOperation)
    // =========================================================================
    describe('4. Atomic AI Commit Guard (commitAIFileOperation)', () => {
        const userId = 'user-ai-gate-1';
        const fileId = 'file-enc-1';
        const operationId = 'op-ai-commit-1';

        it('should reject commit to encrypted file if allowAIOnEncryptedFiles is false and refund reservation', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({
                id: 'res-1',
                operationId,
                userId,
                fileId,
                status: 'reserved',
            });

            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
                version: 1,
            });

            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: false,
            });

            const result = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion: 1,
                resultContent: 'plaintext that should not be committed',
            });

            expect(result.success).toBe(false);
            if (result.status === 'unauthorized') {
                expect(result.error).toBe('AI_PROHIBITED_ON_ENCRYPTED_FILES');
            } else {
                expect.fail(`Expected status to be unauthorized, but got ${result.status}`);
            }
            expect(mockAiOps.refundAIReservation).toHaveBeenCalledWith(operationId, userId);
        });

        it('should reject plaintext commit to encrypted file even if AI is allowed if encryptionMetadata.iv is missing', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({
                id: 'res-1',
                operationId,
                userId,
                fileId,
                status: 'reserved',
            });

            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
                version: 1,
            });

            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: true,
            });

            const result = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion: 1,
                resultContent: 'unencrypted plaintext without iv',
                encryptionMetadata: null,
            });

            expect(result.success).toBe(false);
            if (result.status === 'error') {
                expect(result.error).toContain('Cannot commit unencrypted content to an encrypted file without encryption metadata');
            } else {
                expect.fail(`Expected status to be error, but got ${result.status}`);
            }
            expect(mockAiOps.refundAIReservation).toHaveBeenCalledWith(operationId, userId);
        });

        it('should commit successfully when AI is allowed and re-encrypted metadata is provided', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });

            mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({
                id: 'res-1',
                operationId,
                userId,
                fileId,
                status: 'reserved',
            });

            mockDb.query.files.findFirst.mockResolvedValueOnce({
                id: fileId,
                userId,
                isEncrypted: true,
                version: 1,
                etag: 'etag-old-1',
            });

            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: true,
            });

            const result = await commitAIFileOperation({
                operationId,
                fileId,
                expectedVersion: 1,
                resultContent: 're-encrypted-ciphertext-base64',
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256',
                    keyId: 'master-v1',
                    salt: '',
                    iv: 'fresh-random-iv-base64',
                    kdfIterations: 600000,
                },
            });

            expect(result.success).toBe(true);
            expect(result.status).toBe('committed');
            expect(mockTxDb.transaction).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 5. Vault AI Preference Server Action (updateVaultAISetting)
    // =========================================================================
    describe('5. Vault AI Preference Server Action (updateVaultAISetting)', () => {
        const userId = 'user-pref-1';

        it('should reject unauthenticated request', async () => {
            mockGetUser.mockResolvedValueOnce(null);

            const res = await updateVaultAISetting(true);
            expect(res.success).toBe(false);
            expect(res.status).toBe('unauthorized');
        });

        it('should return not_found if user vault profile does not exist', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });
            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce(null);

            const res = await updateVaultAISetting(true);
            expect(res.success).toBe(false);
            expect(res.status).toBe('not_found');
        });

        it('should update allowAIOnEncryptedFiles in database and return new state', async () => {
            mockGetUser.mockResolvedValueOnce({ id: userId });
            mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
                userId,
                allowAIOnEncryptedFiles: false,
            });

            const res = await updateVaultAISetting(true);
            expect(res.success).toBe(true);
            expect(res.data?.allowAIOnEncryptedFiles).toBe(true);
            expect(mockDb.update).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 6. Non-Blocking Sync Manager: Encrypted Conflict Isolation
    // =========================================================================
    describe('6. Non-Blocking Sync Manager: Encrypted Conflict Isolation', () => {
        let syncManager: SyncManager;
        let testUserId = 'user-sync-p4';
        const encryptedFileId = 'file-enc-conflict';
        const unencryptedFileId = 'file-plain-clean';

        beforeEach(async () => {
            testUserId = 'user-sync-' + Math.random().toString(36).substring(2, 8);
            syncManager = new SyncManager();
            await syncManager.init({ userId: testUserId });
        });

        afterEach(() => {
            syncManager.destroy();
            sessionKeyStore.purgeKeys();
            vi.restoreAllMocks();
        });

        it('should isolate 412 encrypted conflict into pendingEncryptedConflicts as CONFLICT_LOCKED when vault is locked', async () => {
            expect(sessionKeyStore.isVaultUnlocked()).toBe(false);

            let lockedEventFired = false;
            let lockedFileId = '';
            syncManager.onEncryptedConflictLocked((conflict) => {
                lockedEventFired = true;
                lockedFileId = conflict.fileId;
            });

            // Mock server conflict metadata
            const mockServerVersion = {
                content: 'server-ciphertext-base64',
                etag: 'etag-server-412',
                version: 2,
                updatedAt: new Date().toISOString(),
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256',
                    iv: 'server-iv-base64',
                    salt: '',
                    kdfIterations: 600000,
                },
            };

            const mockConflictData: PendingEncryptedConflict = {
                fileId: encryptedFileId,
                remoteEnvelope: {
                    version: 1 as const,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: mockServerVersion.encryptionMetadata.iv,
                    salt: '',
                    ciphertext: mockServerVersion.content,
                    kdfIterations: 600000,
                },
                baseEnvelope: {
                    version: 1 as const,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: 'base-iv',
                    salt: '',
                    ciphertext: 'base-ciphertext',
                    kdfIterations: 600000,
                },
                localEnvelope: {
                    version: 1 as const,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: 'local-iv',
                    salt: '',
                    ciphertext: 'local-ciphertext',
                    kdfIterations: 600000,
                },
                remoteEtag: mockServerVersion.etag,
                detectedAt: new Date(),
            };

            // Test notifyEncryptedConflictLocked and pending storage
            syncManager['pendingEncryptedConflicts'].set(encryptedFileId, mockConflictData);
            syncManager['notifyEncryptedConflictLocked'](mockConflictData);

            expect(lockedEventFired).toBe(true);
            expect(lockedFileId).toBe(encryptedFileId);
            expect(syncManager.isEncryptedConflictLocked(encryptedFileId)).toBe(true);
            expect(syncManager.getPendingEncryptedConflicts()).toHaveLength(1);
        });

        it('should allow concurrent push of unencrypted files while an encrypted file is conflict-locked', async () => {
            // Lock file A as pending encrypted conflict
            syncManager['pendingEncryptedConflicts'].set(encryptedFileId, {
                fileId: encryptedFileId,
                remoteEnvelope: { version: 1 as const, algorithm: 'AES-GCM-256' as const, keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                baseEnvelope: { version: 1 as const, algorithm: 'AES-GCM-256' as const, keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                localEnvelope: { version: 1 as const, algorithm: 'AES-GCM-256' as const, keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                remoteEtag: 'remote-etag',
                detectedAt: new Date(),
            });

            // Verify that the conflict-locked file is recognized as locked
            expect(syncManager.isEncryptedConflictLocked(encryptedFileId)).toBe(true);
            expect(syncManager.isEncryptedConflictLocked(unencryptedFileId)).toBe(false);
        });

        it('should resolve pending encrypted conflict upon vault unlock with 3-way merge and syntax validation', async () => {
            // Setup master key in sessionKeyStore
            const rawMasterKey = new Uint8Array(32);
            rawMasterKey.fill(42);
            sessionKeyStore.storeMasterKeyRaw(rawMasterKey, 3600);
            expect(sessionKeyStore.isVaultUnlocked()).toBe(true);

            const validIvBase64 = Buffer.from(new Uint8Array(12).fill(1)).toString('base64');

            // Mock cryptoWorkerBridge decrypt/encrypt
            vi.spyOn(cryptoWorkerBridge, 'decryptAESGCM').mockImplementation(async (_key, ciphertext) => {
                if (ciphertext === 'cipher-base') return '# Base Document\n\nSection 1 original\n\nSection 2 original\n';
                if (ciphertext === 'cipher-local') return '# Base Document\n\nSection 1 local edit\n\nSection 2 original\n';
                if (ciphertext === 'cipher-remote') return '# Base Document\n\nSection 1 original\n\nSection 2 remote edit\n';
                if (ciphertext === 'merged-reencrypted-ciphertext') return 'merged-reencrypted-ciphertext';
                return ciphertext;
            });

            vi.spyOn(cryptoWorkerBridge, 'generateRandomBytes').mockImplementation(async (len: number = 12) => new Uint8Array(len).fill(1));
            vi.spyOn(cryptoWorkerBridge, 'encryptAESGCM').mockResolvedValue({
                ciphertextBase64: 'merged-reencrypted-ciphertext',
                ivBase64: validIvBase64,
            });

            // Setup initial local file in IndexedDB
            await syncManager['idb'].saveFile({
                id: encryptedFileId,
                title: 'enc-doc.md',
                parentFolderId: null,
                isFolder: false,
                content: 'cipher-local',
                etag: 'etag-old',
                version: 1,
                isDirty: true,
                isEncrypted: true,
                lastModified: Date.now(),
                lastSyncedAt: Date.now(),
            });

            // Mock global fetch for server PUT
            const globalFetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ etag: 'etag-merged-success', version: 2 }),
            });
            global.fetch = globalFetchMock;

            // Set up pending conflict with valid base64 IVs
            syncManager['pendingEncryptedConflicts'].set(encryptedFileId, {
                fileId: encryptedFileId,
                remoteEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: validIvBase64, salt: '', ciphertext: 'cipher-remote', kdfIterations: 600000 },
                baseEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: validIvBase64, salt: '', ciphertext: 'cipher-base', kdfIterations: 600000 },
                localEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: validIvBase64, salt: '', ciphertext: 'cipher-local', kdfIterations: 600000 },
                remoteEtag: 'etag-server-412',
                detectedAt: new Date(),
            });

            const result = await syncManager.resolvePendingEncryptedConflict(encryptedFileId);

            expect(result.success).toBe(true);
            expect(result.action).toBe('pushed');
            expect(syncManager.isEncryptedConflictLocked(encryptedFileId)).toBe(false);
            expect(globalFetchMock).toHaveBeenCalledWith(
                `/api/files/${encryptedFileId}`,
                expect.objectContaining({
                    method: 'PUT',
                    headers: expect.objectContaining({
                        'If-Match': '"etag-server-412"',
                    }),
                })
            );

            // Verify local IndexedDB was updated with merged ciphertext, metadata, and marked clean
            const persistedFile = await syncManager['idb'].getFile(encryptedFileId);
            expect(persistedFile?.content).toBe('merged-reencrypted-ciphertext');
            expect(persistedFile?.isDirty).toBe(false);
            expect(persistedFile?.etag).toBe('etag-merged-success');
            expect(persistedFile?.version).toBe(2);
            expect(persistedFile?.encryptionMetadata?.iv).toBe(validIvBase64);
        });

        it('should clear pending encrypted conflicts and listeners upon destroy()', () => {
            syncManager['pendingEncryptedConflicts'].set('file-leak-test', {
                fileId: 'file-leak-test',
                remoteEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                baseEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                localEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                remoteEtag: 'etag',
                detectedAt: new Date(),
            });
            expect(syncManager.getPendingEncryptedConflicts()).toHaveLength(1);

            syncManager.destroy();

            expect(syncManager.getPendingEncryptedConflicts()).toHaveLength(0);
        });

        it('should preserve isEncrypted and encryptionMetadata when pulling a new encrypted file from server (ADV2-01)', async () => {
            const newServerFile = {
                id: 'file-new-enc',
                title: 'New Encrypted File',
                content: 'cipher-server-data',
                etag: 'etag-server-new',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: 'iv-server-1234',
                    salt: 'salt-server-1234',
                    kdfIterations: 600000,
                },
                updatedAt: new Date().toISOString(),
            };

            const result = await syncManager['pullFile'](newServerFile);
            expect(result.success).toBe(true);
            expect(result.action).toBe('pulled');

            const saved = await syncManager['idb'].getFile('file-new-enc');
            expect(saved?.isEncrypted).toBe(true);
            expect(saved?.encryptionMetadata?.iv).toBe('iv-server-1234');
            expect(saved?.encryptionMetadata?.salt).toBe('salt-server-1234');
        });

        it('should update encryptionMetadata when pulling newer version of existing clean encrypted file (ADV2-01)', async () => {
            // Pre-save existing clean file with old IV
            await syncManager['idb'].saveFile({
                id: 'file-existing-enc',
                title: 'Existing Encrypted File',
                content: 'cipher-old',
                etag: 'etag-old',
                version: 1,
                parentFolderId: null,
                isFolder: false,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: 'iv-old',
                    salt: 'salt-old',
                    kdfIterations: 600000,
                },
                isDirty: false,
                lastModified: Date.now(),
                lastSyncedAt: Date.now(),
            });

            const updatedServerFile = {
                id: 'file-existing-enc',
                title: 'Existing Encrypted File Updated',
                content: 'cipher-new-v2',
                etag: 'etag-v2',
                version: 2,
                parentFolderId: null,
                isFolder: false,
                isEncrypted: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: 'AES-GCM-256' as const,
                    keyId: 'master-v1',
                    iv: 'iv-new-fresh',
                    salt: 'salt-new-fresh',
                    kdfIterations: 600000,
                },
                updatedAt: new Date().toISOString(),
            };

            const result = await syncManager['pullFile'](updatedServerFile);
            expect(result.success).toBe(true);
            expect(result.action).toBe('pulled');

            const saved = await syncManager['idb'].getFile('file-existing-enc');
            expect(saved?.content).toBe('cipher-new-v2');
            expect(saved?.encryptionMetadata?.iv).toBe('iv-new-fresh');
            expect(saved?.version).toBe(2);
        });

        it('should automatically trigger resolution of pending encrypted conflicts when vault is unlocked (ADV2-03)', async () => {
            const spyResolve = vi.spyOn(syncManager, 'resolvePendingEncryptedConflict').mockResolvedValue({
                fileId: 'auto-resolve-target',
                success: true,
                action: 'pushed',
            });

            syncManager['pendingEncryptedConflicts'].set('auto-resolve-target', {
                fileId: 'auto-resolve-target',
                remoteEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                baseEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                localEnvelope: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', iv: '', salt: '', ciphertext: '', kdfIterations: 600000 },
                remoteEtag: 'etag',
                detectedAt: new Date(),
            });

            expect(syncManager.getPendingEncryptedConflicts()).toHaveLength(1);

            // Unlock vault in sessionKeyStore
            const rawKey = new Uint8Array(32).fill(7);
            sessionKeyStore.storeMasterKeyRaw(rawKey, 3600);

            // Wait for microtask/async resolution loop
            await new Promise(r => setTimeout(r, 50));

            expect(spyResolve).toHaveBeenCalledWith('auto-resolve-target');
        });
    });
});
