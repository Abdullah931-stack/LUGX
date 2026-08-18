import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commitAIFileOperation } from '@/server/actions/ai-commit';
import { db } from '@/lib/db';
import { getUser } from '@/lib/supabase/server';

vi.mock('@/lib/supabase/server', () => ({
    getUser: vi.fn(),
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
            status: 'status',
        },
        files: {
            id: 'id',
            userId: 'user_id',
            version: 'version',
            deletedAt: 'deleted_at',
        },
    },
}));

describe('Server Atomic Commit & Optimistic Version Guard (Gate G2)', () => {
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

    it('should return already_committed if reservation is already committed', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-1',
            operationId: 'op-committed',
            userId: 'user-1',
            status: 'committed',
        } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-committed',
            fileId: 'file-1',
            expectedVersion: 1,
            resultContent: '<p>Test</p>',
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe('already_committed');
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

    it('should successfully commit file and reservation when versions match', async () => {
        vi.mocked(getUser).mockResolvedValueOnce({ id: 'user-1' } as any);
        vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
            id: 'res-4',
            operationId: 'op-success',
            userId: 'user-1',
            status: 'reserved',
        } as any);

        // Server file version matches client expectedVersion (2)
        vi.mocked(db.query.files.findFirst).mockResolvedValueOnce({
            id: 'file-1',
            userId: 'user-1',
            version: 2,
            etag: 'etag-v2',
            updatedAt: new Date(),
        } as any);

        // Mock db.update for files and aiReservations
        const returningMock = vi.fn().mockResolvedValue([{ id: 'file-1', version: 3 }]);
        const whereMock = vi.fn().mockReturnValue({ returning: returningMock });
        const setMock = vi.fn().mockReturnValue({ where: whereMock });
        vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

        const res = await commitAIFileOperation({
            operationId: 'op-success',
            fileId: 'file-1',
            expectedVersion: 2,
            resultContent: '<p>Committed text</p>',
        });

        expect(res.success).toBe(true);
        expect(res.status).toBe('committed');
        if (res.status === 'committed') {
            expect(res.version).toBe(3);
            expect(res.etag).toBeDefined();
        }
    });
});
