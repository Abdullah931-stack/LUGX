/**
 * Phase 10 Test Suite: AI Stream fileId Mandate & Encrypted Content Governance (LUGX-085)
 *
 * Verifies:
 * 1. POST /api/ai/stream strictly requires non-empty fileId, rejecting missing fileId with HTTP 400 MISSING_FILE_ID.
 * 2. POST /api/ai/stream rejects malformed/empty fileId with HTTP 400.
 * 3. POST /api/ai/stream rejects non-existent or foreign user file with HTTP 404.
 * 4. POST /api/ai/stream on encrypted file fails closed with HTTP 403 AI_PROHIBITED_ON_ENCRYPTED_FILES if allowAIOnEncryptedFiles is false.
 * 5. POST /api/ai/stream on encrypted file succeeds when user explicitly opted in (allowAIOnEncryptedFiles = true).
 * 6. POST /api/ai/stream on plaintext file succeeds and reserves quota with clean fileId.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as aiStreamRoute } from '@/app/api/ai/stream/route';

const mockGetUser = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
    query: {
        files: { findFirst: vi.fn() },
        userVaultProfiles: { findFirst: vi.fn() },
        aiReservations: { findFirst: vi.fn() },
    },
}));

const mockSettlement = vi.hoisted(() => ({
    getUserTier: vi.fn().mockResolvedValue('pro'),
    reserveAIQuota: vi.fn().mockResolvedValue({ reserved: true }),
    refundAIReservation: vi.fn().mockResolvedValue({ success: true }),
    commitAIReservation: vi.fn().mockResolvedValue({ success: true }),
    computeRequestHash: vi.fn().mockReturnValue('mock_hash'),
}));

vi.mock('@/lib/supabase/server', () => ({
    getUser: mockGetUser,
}));

vi.mock('@/server/db', () => ({
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
    },
}));

vi.mock('@/server/services/ai-settlement-service', () => mockSettlement);

vi.mock('@/lib/ai/client', () => ({
    streamWithAI: vi.fn().mockResolvedValue(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('chunk'));
                controller.close();
            },
        })
    ),
    processWithAI: vi.fn().mockResolvedValue('ok'),
}));

vi.mock('@/lib/rate-limit', () => ({
    aiStreamRateLimiter: {
        limit: vi.fn().mockResolvedValue({
            success: true,
            limit: 60,
            remaining: 59,
            reset: Date.now() + 60000,
        }),
    },
    addRateLimitHeaders: vi.fn(),
    rateLimitExceededResponse: vi.fn(),
}));

describe('Phase 10: AI Stream fileId Mandate & Zero-Knowledge Barrier (LUGX-085)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUser.mockResolvedValue({ id: 'user_123' });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rejects requests missing fileId entirely with HTTP 400 and MISSING_FILE_ID', async () => {
        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Summarize document text',
                operation: 'summarize',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('MISSING_FILE_ID');
        expect(mockSettlement.reserveAIQuota).not.toHaveBeenCalled();
    });

    it('rejects requests where fileId is null with HTTP 400 and MISSING_FILE_ID', async () => {
        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Summarize document text',
                operation: 'summarize',
                fileId: null,
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('MISSING_FILE_ID');
        expect(mockSettlement.reserveAIQuota).not.toHaveBeenCalled();
    });

    it('rejects requests where fileId is empty whitespace or non-string with HTTP 400', async () => {
        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Summarize document text',
                operation: 'summarize',
                fileId: '   ',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('MISSING_FILE_ID');
        expect(mockSettlement.reserveAIQuota).not.toHaveBeenCalled();
    });

    it('returns HTTP 404 when fileId does not exist or does not belong to user', async () => {
        mockDb.query.files.findFirst.mockResolvedValueOnce(null);

        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Summarize document text',
                operation: 'summarize',
                fileId: 'non_existent_file',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(text).toBe('File not found');
        expect(mockSettlement.reserveAIQuota).not.toHaveBeenCalled();
    });

    it('rejects encrypted file with HTTP 403 when allowAIOnEncryptedFiles is false', async () => {
        mockDb.query.files.findFirst.mockResolvedValueOnce({
            id: 'file_encrypted',
            userId: 'user_123',
            isEncrypted: true,
        });
        mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
            userId: 'user_123',
            allowAIOnEncryptedFiles: false,
        });

        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Secret vault content',
                operation: 'improve',
                fileId: 'file_encrypted',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(403);
        const text = await res.text();
        expect(text).toBe('AI_PROHIBITED_ON_ENCRYPTED_FILES');
        expect(mockSettlement.reserveAIQuota).not.toHaveBeenCalled();
    });

    it('permits encrypted file when allowAIOnEncryptedFiles is explicitly true', async () => {
        mockDb.query.files.findFirst.mockResolvedValueOnce({
            id: 'file_encrypted',
            userId: 'user_123',
            isEncrypted: true,
        });
        mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({
            userId: 'user_123',
            allowAIOnEncryptedFiles: true,
        });

        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Explicitly permitted secret vault content',
                operation: 'improve',
                fileId: 'file_encrypted',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);
        expect(mockSettlement.reserveAIQuota).toHaveBeenCalledWith(
            'user_123',
            'improve',
            expect.any(Number),
            'pro',
            expect.objectContaining({
                fileId: 'file_encrypted',
            })
        );
    });

    it('permits standard unencrypted file without checking vault profile', async () => {
        mockDb.query.files.findFirst.mockResolvedValueOnce({
            id: 'file_normal',
            userId: 'user_123',
            isEncrypted: false,
        });

        const req = new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Standard public document content',
                operation: 'correct',
                fileId: 'file_normal',
            }),
        });

        const res = await aiStreamRoute(req);
        expect(res.status).toBe(200);
        expect(mockDb.query.userVaultProfiles.findFirst).not.toHaveBeenCalled();
        expect(mockSettlement.reserveAIQuota).toHaveBeenCalledWith(
            'user_123',
            'correct',
            expect.any(Number),
            'pro',
            expect.objectContaining({
                fileId: 'file_normal',
            })
        );
    });
});
