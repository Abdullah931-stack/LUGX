import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as aiOps from '@/server/actions/ai-ops';
import { db } from '@/lib/db';

const inMemoryReservations = new Map<string, any>();
const inMemoryUsage = new Map<string, any>();

vi.mock('@/lib/db', () => ({
    db: {
        query: {
            users: {
                findFirst: vi.fn().mockResolvedValue({ tier: 'pro' }),
            },
            usage: {
                findFirst: vi.fn().mockImplementation(({ where }: any) => {
                    return Promise.resolve(inMemoryUsage.get('user_usage') || {
                        id: 'usage-1',
                        userId: '00000000-0000-0000-0000-000000000001',
                        date: new Date().toISOString().split('T')[0],
                        correctWords: 0,
                        improveWords: 0,
                        translateWords: 0,
                        summarizeCount: 0,
                        toPromptCount: 0,
                    });
                }),
            },
            aiReservations: {
                findFirst: vi.fn().mockImplementation(({ where }: any) => {
                    for (const res of inMemoryReservations.values()) {
                        return Promise.resolve(res);
                    }
                    return Promise.resolve(undefined);
                }),
                findMany: vi.fn().mockImplementation(() => {
                    return Promise.resolve(Array.from(inMemoryReservations.values()));
                }),
            },
        },
        insert: vi.fn().mockImplementation((table: any) => ({
            values: (val: any) => ({
                onConflictDoNothing: () => Promise.resolve(),
                returning: () => {
                    const row = { id: `id_${Math.random()}`, ...val };
                    if (val.operationId) {
                        inMemoryReservations.set(val.operationId, row);
                    }
                    return Promise.resolve([row]);
                },
            }),
        })),
        update: vi.fn().mockImplementation((table: any) => ({
            set: (setVal: any) => ({
                where: (whereClause: any) => ({
                    returning: () => {
                        return Promise.resolve([{ id: 'updated-1' }]);
                    },
                }),
            }),
        })),
        select: vi.fn().mockImplementation(() => ({
            from: () => ({
                where: () => Promise.resolve([{ total: 0 }]),
            }),
        })),
    },
    schema: {
        users: { id: 'id', tier: 'tier' },
        usage: { id: 'id', userId: 'user_id', date: 'date' },
        aiReservations: {
            id: 'id',
            operationId: 'operation_id',
            userId: 'user_id',
            status: 'status',
            reservedUnits: 'reserved_units',
            committedUnits: 'committed_units',
            refundedUnits: 'refunded_units',
            periodKey: 'period_key',
            expiresAt: 'expires_at',
        },
    },
}));

describe('AI Quota Reservation & Idempotency Invariants (Phase 5 - Gates G1 & G4)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        inMemoryReservations.clear();
        inMemoryUsage.clear();
    });

    describe('Idempotent Reservation Lifecycle', () => {
        it('should generate a unique reservationId and attach the UTC periodKey', async () => {
            const operationId = 'test-op-101';
            const res = await aiOps.reserveAndUpdateUsage(
                '00000000-0000-0000-0000-000000000001',
                'improve',
                150,
                'pro',
                { operationId }
            );

            expect(res.reserved).toBe(true);
            expect(res.periodKey).toBeDefined();
            // Period key must be strictly UTC YYYY-MM-DD
            expect(res.periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        it('should preserve the exact reservation on repeated reserve call with same operationId (Idempotent Retry)', async () => {
            const operationId = 'test-op-replay-102';

            // First call creates reservation
            const first = await aiOps.reserveAndUpdateUsage(
                '00000000-0000-0000-0000-000000000001',
                'correct',
                50,
                'pro',
                { operationId }
            );

            // Mock DB findFirst returning the existing reservation
            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: first.reservationId || 'res-1',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'reserved',
                periodKey: first.periodKey,
                reservedUnits: 50,
            } as any);

            const replay = await aiOps.reserveAndUpdateUsage(
                '00000000-0000-0000-0000-000000000001',
                'correct',
                50,
                'pro',
                { operationId }
            );

            expect(first.reserved).toBe(true);
            expect(replay.reserved).toBe(true);
            expect(replay.operationId).toBe(operationId);
        });
    });

    describe('Idempotent Refund & State Machine Guarding', () => {
        it('should safely refund a reserved operation once', async () => {
            const operationId = 'test-op-refund-201';

            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: 'res-refund-1',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'reserved',
                operation: 'translate',
                reservedUnits: 200,
                periodKey: '2026-08-17',
            } as any);

            const refundResult = await aiOps.refundAIReservation(operationId, 'test_failure');
            expect(refundResult.refunded).toBe(true);
        });

        it('should reject second refund attempt for already refunded operation (Idempotent No-Op)', async () => {
            const operationId = 'test-op-double-refund-202';

            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: 'res-refund-2',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'refunded',
                operation: 'summarize',
                reservedUnits: 100,
                periodKey: '2026-08-17',
            } as any);

            const refundAttempt = await aiOps.refundAIReservation(operationId, 'duplicate_call');
            expect(refundAttempt.refunded).toBe(false);
            expect(refundAttempt.reason).toBe('already_refunded');
        });

        it('should strictly forbid refunding an already committed reservation', async () => {
            const operationId = 'test-op-commit-guard-203';

            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: 'res-commit-1',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'committed',
                operation: 'improve',
                reservedUnits: 80,
                periodKey: '2026-08-17',
            } as any);

            const refundAttempt = await aiOps.refundAIReservation(operationId, 'illegal_refund');
            expect(refundAttempt.refunded).toBe(false);
            expect(refundAttempt.reason).toBe('already_committed');
        });
    });

    describe('State Transition Guarding: commit and expiration', () => {
        it('should transition reserved -> committed idempotently', async () => {
            const operationId = 'test-op-commit-301';

            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: 'res-commit-301',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'reserved',
                reservedUnits: 120,
            } as any);

            const result = await aiOps.commitAIReservation(operationId);
            expect(result.committed).toBe(true);
        });

        it('should recognize already_committed when commit is called repeatedly', async () => {
            const operationId = 'test-op-commit-302';

            vi.mocked(db.query.aiReservations.findFirst).mockResolvedValueOnce({
                id: 'res-commit-302',
                operationId,
                userId: '00000000-0000-0000-0000-000000000001',
                status: 'committed',
                reservedUnits: 120,
            } as any);

            const result = await aiOps.commitAIReservation(operationId);
            expect(result.committed).toBe(true);
            expect(result.reason).toBe('already_committed');
        });

        it('should sweep and expire stale reservations restoring usage counters', async () => {
            vi.mocked(db.query.aiReservations.findMany).mockResolvedValueOnce([
                {
                    id: 'res-stale-1',
                    operationId: 'op-stale-1',
                    userId: '00000000-0000-0000-0000-000000000001',
                    status: 'reserved',
                    operation: 'correct',
                    reservedUnits: 75,
                    periodKey: '2026-08-20',
                    expiresAt: new Date(Date.now() - 60000),
                },
            ] as any);

            const expiredCount = await aiOps.expireStaleReservations();
            expect(expiredCount).toBe(1);
        });
    });
});

