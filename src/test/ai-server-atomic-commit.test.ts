import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitAIFileOperation } from '@/server/actions/ai-commit';
import { db } from '@/lib/db';
import { txDb } from '@/lib/db/transactional';
import { getUser } from '@/lib/supabase/server';

vi.mock('@/lib/supabase/server', () => ({
    getUser: vi.fn(),
}));

vi.mock('@/lib/db/transactional', () => ({
    txDb: {
        transaction: vi.fn(),
    },
}));

vi.mock('@/lib/db', () => ({
    db: {
        query: {
            aiReservations: {
                findFirst: vi.fn(),
            },
            files: {
                findFirst: vi.fn(),
            },
        },
        update: vi.fn(),
    },
    schema: {
        aiReservations: {
            id: 'id',
            operationId: 'operation_id',
            userId: 'user_id',
            fileId: 'file_id',
            status: 'status',
            reservedUnits: 'reserved_units',
            committedUnits: 'committed_units',
            refundedUnits: 'refunded_units',
        },
        files: {
            id: 'id',
            userId: 'user_id',
            version: 'version',
            etag: 'etag',
            deletedAt: 'deleted_at',
        },
    },
}));

describe('Server Atomic Commit & Optimistic Version Guard (Gate G2 / Phase 8)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reject commit when user is not authenticated', async () => {
        vi.mocked(getUser).mockResolvedValueOnce(null);

        const res = await commitAIFileOperation({
            operationId: 'op-unauth',
            fileId: '00000000-0000-0000-0000-000000000001',
            expectedVersion: 1,
            resultContent: '<p>Updated content</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('unauthorized');
    });

    it('should return error when commit parameters are missing or invalid', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);

        const res = await commitAIFileOperation({
            operationId: '',
            fileId: 'file-1',
            expectedVersion: 1,
            resultContent: '<p>Test</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('error');
    });

    it('should return reservation_not_found when operationId is invalid', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce(undefined as any);

        const res = await commitAIFileOperation({
            operationId: 'non-existent-op-id',
            fileId: '00000000-0000-0000-0000-000000000002',
            expectedVersion: 1,
            resultContent: '<p>Updated content</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('reservation_not_found');
    });

    it('should reject commit if reservation belongs to a different fileId', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-diff',
            operationId: 'op-diff-file',
            userId: 'user-1',
            fileId: 'other-file-id',
            status: 'reserved',
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-diff-file',
            fileId: 'target-file-id',
            expectedVersion: 1,
            resultContent: '<p>Test</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('error');
        if ('error' in res) {
            expect(res.error).toContain('different file');
        }
    });

    it('should return already_committed with current file state if reservation is already committed (Idempotent Retry)', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-1',
            operationId: 'op-committed',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'committed',
        } as any);

        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 3,
            etag: 'etag-v3',
            updatedAt: new Date('2026-08-21T12:00:00Z'),
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-committed',
            fileId: 'file-1',
            expectedVersion: 2,
            resultContent: '<p>Test</p>',
        });

        expect(res.success).toBe(true);
        expect(res.status).toBe('already_committed');
        if (res.status === 'already_committed') {
            expect(res.version).toBe(3);
            expect(res.etag).toBe('etag-v3');
        }
    });

    it('should return reservation_expired if reservation status is expired or refunded', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-2',
            operationId: 'op-expired',
            userId: 'user-1',
            status: 'expired',
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-expired',
            fileId: 'file-1',
            expectedVersion: 1,
            resultContent: '<p>Test</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('reservation_expired');
    });

    it('should return 412 conflict when file version does not match expectedVersion', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-3',
            operationId: 'op-conflict',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'reserved',
        } as any);

        // Server file version is 3, but client expected 2
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 3,
            etag: 'etag-v3',
            updatedAt: new Date(),
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-conflict',
            fileId: 'file-1',
            expectedVersion: 2,
            resultContent: '<p>New text</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('conflict');
        if (res.status === 'conflict') {
            expect(res.error).toContain('modified by another session');
            expect(res.serverVersion?.version).toBe(3);
        }
    });

    it('should return 412 conflict when expectedETag does not match server ETag', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-etag',
            operationId: 'op-etag-conflict',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'reserved',
        } as any);

        // Server has matching version (2) but different ETag
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 2,
            etag: 'server-etag-xyz',
            updatedAt: new Date(),
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-etag-conflict',
            fileId: 'file-1',
            expectedVersion: 2,
            expectedETag: 'client-expected-etag-abc',
            resultContent: '<p>New text</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('conflict');
        if (res.status === 'conflict') {
            expect(res.error).toContain('ETag mismatch');
        }
    });

    it('should self-heal and succeed when expectedVersion differs but originalContent matches server content', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-heal',
            operationId: 'op-heal',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'reserved',
            reservedUnits: 10,
        } as any);

        const baseline = 'Exact unchanged baseline markdown content';
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 3,
            etag: 'etag-v3',
            content: baseline,
            updatedAt: new Date(),
        } as any);

        const txMock = {
            update: vi.fn((table: any) => ({
                set: vi.fn(() => ({
                    where: vi.fn(() => ({
                        returning: vi.fn().mockResolvedValue([
                            table === 'files'
                                ? { id: 'file-1', version: 4, etag: 'new-etag' }
                                : { id: 'res-heal', status: 'committed' },
                        ]),
                    })),
                })),
            })),
        };

        vi.mocked(txDb.transaction).mockImplementationOnce(async (callback: any) => {
            return callback(txMock);
        });

        const res = await commitAIFileOperation({
            operationId: 'op-heal',
            fileId: 'file-1',
            expectedVersion: 2, // Client had stale version 2
            originalContent: baseline, // Baseline content matches server content exactly
            resultContent: 'Updated text with AI changes',
        });

        expect(res.success).toBe(true);
        expect(res.status).toBe('committed');
        if (res.status === 'committed') {
            expect(res.version).toBe(4); // Incremented from current server version 3
        }
    });

    it('should atomically commit file and reservation via transactional DB when versions match', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-4',
            operationId: 'op-success',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'reserved',
            reservedUnits: 150,
        } as any);

        // Server file version matches client expectedVersion (2)
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 2,
            etag: 'etag-v2',
            updatedAt: new Date(),
        } as any);

        // Mock txDb.transaction executing successfully
        const txMock = {
            update: vi.fn((table: any) => ({
                set: vi.fn(() => ({
                    where: vi.fn(() => ({
                        returning: vi.fn().mockResolvedValue([
                            table === 'files'
                                ? { id: 'file-1', version: 3, etag: 'new-etag' }
                                : { id: 'res-4', status: 'committed' },
                        ]),
                    })),
                })),
            })),
        };

        vi.mocked(txDb.transaction).mockImplementation(async (callback: any) => {
            return callback(txMock);
        });

        const res = await commitAIFileOperation({
            operationId: 'op-success',
            fileId: 'file-1',
            expectedVersion: 2,
            expectedETag: 'etag-v2',
            resultContent: '<p>Committed text</p>',
        });

        expect(res.success).toBe(true);
        expect(res.status).toBe('committed');
        if (res.status === 'committed') {
            expect(res.version).toBe(3);
            expect(res.etag).toBeDefined();
        }
    });

    it('should rollback transaction and return error if reservation settlement fails', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-fail',
            operationId: 'op-tx-fail',
            userId: 'user-1',
            fileId: 'file-1',
            status: 'reserved',
            reservedUnits: 100,
        } as any);

        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 1,
            etag: 'etag-v1',
            updatedAt: new Date(),
        } as any);

        // Mock tx throwing during execution
        vi.mocked(txDb.transaction).mockRejectedValueOnce(new Error('DB Transaction Deadlock or Error'));

        const res = await commitAIFileOperation({
            operationId: 'op-tx-fail',
            fileId: 'file-1',
            expectedVersion: 1,
            resultContent: '<p>Attempt text</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('error');
        if ('error' in res) {
            expect(res.error).toContain('DB Transaction Deadlock');
        }
    });
});
