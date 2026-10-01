import { describe, it, expect } from 'vitest';
import {
    calculateQuotaSettlement,
    reduceQuotaReservationState,
    QuotaStateConflictError,
    QuotaReservationState,
} from '@/lib/ai/quota-settlement-reducer';

describe('AI Quota Settlement & Reservation State Machine (Phase 5 / 6 Invariants)', () => {
    describe('calculateQuotaSettlement (Mathematical & Conservation Invariants)', () => {
        it('preserves conservation law (toCommit + toRefund === reserved) on partial consumption', () => {
            const decision = calculateQuotaSettlement({
                reservedUnits: 200,
                consumedUnits: 120,
            });

            expect(decision.toCommit).toBe(120);
            expect(decision.toRefund).toBe(80);
            expect(decision.toCommit + decision.toRefund).toBe(200);
            expect(decision.isOverage).toBe(false);
            expect(decision.unusedUnits).toBe(80);
        });

        it('allocates full refund when operation produces zero consumed units', () => {
            const decision = calculateQuotaSettlement({
                reservedUnits: 150,
                consumedUnits: 0,
            });

            expect(decision.toCommit).toBe(0);
            expect(decision.toRefund).toBe(150);
            expect(decision.unusedUnits).toBe(150);
            expect(decision.isOverage).toBe(false);
        });

        it('caps commitment at reservation ceiling on overage without negative refund', () => {
            const decision = calculateQuotaSettlement({
                reservedUnits: 100,
                consumedUnits: 140,
            });

            expect(decision.toCommit).toBe(100);
            expect(decision.toRefund).toBe(0);
            expect(decision.isOverage).toBe(true);
            expect(decision.unusedUnits).toBe(0);
        });

        it('handles zero reservation gracefully', () => {
            const decision = calculateQuotaSettlement({
                reservedUnits: 0,
                consumedUnits: 50,
            });

            expect(decision.toCommit).toBe(0);
            expect(decision.toRefund).toBe(0);
            expect(decision.isOverage).toBe(true);
        });

        it('sanitizes and quantizes non-finite, negative, and floating point inputs', () => {
            const decision = calculateQuotaSettlement({
                reservedUnits: -50,
                consumedUnits: NaN,
            });

            expect(decision.reservedUnits).toBe(0);
            expect(decision.consumedUnits).toBe(0);
            expect(decision.toCommit).toBe(0);
            expect(decision.toRefund).toBe(0);

            const floatDecision = calculateQuotaSettlement({
                reservedUnits: 100.8,
                consumedUnits: 45.3,
            });

            expect(floatDecision.reservedUnits).toBe(100);
            expect(floatDecision.consumedUnits).toBe(45);
            expect(floatDecision.toCommit).toBe(45);
            expect(floatDecision.toRefund).toBe(55);
        });
    });

    describe('reduceQuotaReservationState (Lifecycle & State Transitions)', () => {
        const baseReservation = {
            reservationId: 'res-101',
            operationId: 'op-101',
            userId: 'user-101',
            reservedUnits: 250,
            expiresAt: Date.now() + 300_000,
            timestamp: Date.now(),
        };

        it('transitions from idle to reserved on RESERVE event', () => {
            const idleState: QuotaReservationState = { status: 'idle' };
            const nextState = reduceQuotaReservationState(idleState, {
                type: 'RESERVE',
                ...baseReservation,
            });

            expect(nextState.status).toBe('reserved');
            if (nextState.status === 'reserved') {
                expect(nextState.reservationId).toBe('res-101');
                expect(nextState.operationId).toBe('op-101');
                expect(nextState.reservedUnits).toBe(250);
            }
        });

        it('transitions from reserved to committed with partial refund settlement', () => {
            const reservedState: QuotaReservationState = {
                status: 'reserved',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                reservedUnits: 200,
                expiresAt: Date.now() + 300_000,
            };

            const commitTimestamp = Date.now();
            const nextState = reduceQuotaReservationState(reservedState, {
                type: 'COMMIT',
                consumedUnits: 150,
                timestamp: commitTimestamp,
            });

            expect(nextState.status).toBe('committed');
            if (nextState.status === 'committed') {
                expect(nextState.committedUnits).toBe(150);
                expect(nextState.refundedUnits).toBe(50);
                expect(nextState.settledAt).toBe(commitTimestamp);
            }
        });

        it('transitions from reserved to refunded on REFUND event', () => {
            const reservedState: QuotaReservationState = {
                status: 'reserved',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                reservedUnits: 180,
                expiresAt: Date.now() + 300_000,
            };

            const refundTimestamp = Date.now();
            const nextState = reduceQuotaReservationState(reservedState, {
                type: 'REFUND',
                timestamp: refundTimestamp,
            });

            expect(nextState.status).toBe('refunded');
            if (nextState.status === 'refunded') {
                expect(nextState.refundedUnits).toBe(180);
                expect(nextState.refundedAt).toBe(refundTimestamp);
            }
        });

        it('transitions from reserved to expired on EXPIRE event', () => {
            const reservedState: QuotaReservationState = {
                status: 'reserved',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                reservedUnits: 100,
                expiresAt: Date.now() - 1000,
            };

            const expireTimestamp = Date.now();
            const nextState = reduceQuotaReservationState(reservedState, {
                type: 'EXPIRE',
                timestamp: expireTimestamp,
            });

            expect(nextState.status).toBe('expired');
            if (nextState.status === 'expired') {
                expect(nextState.expiredAt).toBe(expireTimestamp);
            }
        });

        it('handles idempotent replays without mutation for committed and refunded states', () => {
            const committedState: QuotaReservationState = {
                status: 'committed',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                committedUnits: 100,
                refundedUnits: 0,
                settledAt: 1000,
            };

            const replayCommit = reduceQuotaReservationState(committedState, {
                type: 'COMMIT',
                timestamp: 2000,
            });
            expect(replayCommit).toBe(committedState);

            const refundedState: QuotaReservationState = {
                status: 'refunded',
                reservationId: 'res-102',
                operationId: 'op-102',
                userId: 'user-101',
                refundedUnits: 100,
                refundedAt: 1000,
            };

            const replayRefund = reduceQuotaReservationState(refundedState, {
                type: 'REFUND',
                timestamp: 2000,
            });
            expect(replayRefund).toBe(refundedState);
        });

        it('throws QuotaStateConflictError on invalid state transitions in strict mode', () => {
            const committedState: QuotaReservationState = {
                status: 'committed',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                committedUnits: 100,
                refundedUnits: 0,
                settledAt: 1000,
            };

            expect(() =>
                reduceQuotaReservationState(committedState, {
                    type: 'REFUND',
                    timestamp: Date.now(),
                })
            ).toThrow(QuotaStateConflictError);

            const refundedState: QuotaReservationState = {
                status: 'refunded',
                reservationId: 'res-102',
                operationId: 'op-102',
                userId: 'user-101',
                refundedUnits: 100,
                refundedAt: 1000,
            };

            expect(() =>
                reduceQuotaReservationState(refundedState, {
                    type: 'COMMIT',
                    timestamp: Date.now(),
                })
            ).toThrow(QuotaStateConflictError);
        });

        it('returns previous state without throwing when strict is false', () => {
            const committedState: QuotaReservationState = {
                status: 'committed',
                reservationId: 'res-101',
                operationId: 'op-101',
                userId: 'user-101',
                committedUnits: 100,
                refundedUnits: 0,
                settledAt: 1000,
            };

            const nonStrictResult = reduceQuotaReservationState(
                committedState,
                { type: 'REFUND', timestamp: Date.now() },
                { strict: false }
            );

            expect(nonStrictResult).toBe(committedState);
        });
    });
});
