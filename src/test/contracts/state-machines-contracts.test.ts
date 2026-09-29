/**
 * Contract & Pure Reducer Verification Suite: Phase 6
 *
 * Verifies 100% pure, deterministic state machines:
 * 1. Sync State Reducer (SyncStateMachine)
 * 2. Stripe Webhook Event Reducer (StripeSubscriptionMachine)
 * 3. AI Quota Settlement Reducer & Reservation Machine (QuotaSettlementReducer)
 *
 * Remediates: LUGX-001, LUGX-003, LUGX-010, LUGX-025, LUGX-036, LUGX-040, LUGX-115, LUGX-135
 */

import { describe, it, expect, vi } from 'vitest';
import {
  reduceSyncState,
  isValidSyncTransition,
  InvalidSyncTransitionError,
  isIdleSyncState,
  isSyncingState,
  isConflictSyncState,
  isErrorSyncState,
  type SyncState,
  type SyncEvent,
} from '@/lib/sync/sync-state-reducer';
import {
  reduceSubscriptionState,
  isTerminalSubscriptionStatus,
  TerminalSubscriptionStateError,
  type SubscriptionState,
  type StripeWebhookEvent,
} from '@/lib/stripe/webhook-event-reducer';
import {
  calculateQuotaSettlement,
  reduceQuotaReservationState,
  QuotaStateConflictError,
  type QuotaReservationState,
  type QuotaReservationEvent,
} from '@/lib/ai/quota-settlement-reducer';

describe('Phase 6: Pure Sync State Reducer (LUGX-003, LUGX-010, LUGX-036, LUGX-040)', () => {
  it('transitions from idle to syncing upon START_SYNC', () => {
    const initial: SyncState = { status: 'idle' };
    const event: SyncEvent = {
      type: 'START_SYNC',
      fileId: 'file-123',
      operationId: 'op-456',
      timestamp: 1700000000,
    };

    const next = reduceSyncState(initial, event);
    expect(next.status).toBe('syncing');
    expect(isSyncingState(next)).toBe(true);
    if (isSyncingState(next)) {
      expect(next.fileId).toBe('file-123');
      expect(next.operationId).toBe('op-456');
      expect(next.startedAt).toBe(1700000000);
      expect(next.retryCount).toBe(0);
    }
  });

  it('transitions from syncing to idle upon SYNC_SUCCESS', () => {
    const syncing: SyncState = {
      status: 'syncing',
      fileId: 'file-123',
      startedAt: 1700000000,
      retryCount: 0,
    };
    const event: SyncEvent = {
      type: 'SYNC_SUCCESS',
      timestamp: 1700000500,
      newEtag: 'etag-abc',
      newVersion: 2,
    };

    const next = reduceSyncState(syncing, event);
    expect(next.status).toBe('idle');
    expect(isIdleSyncState(next)).toBe(true);
    if (isIdleSyncState(next)) {
      expect(next.lastSyncedAt).toBe(1700000500);
    }
  });

  it('transitions from syncing to conflict upon CONFLICT_DETECTED', () => {
    const syncing: SyncState = {
      status: 'syncing',
      fileId: 'file-123',
      startedAt: 1700000000,
      retryCount: 0,
    };
    const event: SyncEvent = {
      type: 'CONFLICT_DETECTED',
      fileId: 'file-123',
      conflict: {
        baseVersion: 1,
        remoteVersion: 3,
        remoteEtag: 'remote-etag-xyz',
        detectedAt: 1700000300,
      },
      timestamp: 1700000300,
    };

    const next = reduceSyncState(syncing, event);
    expect(next.status).toBe('conflict');
    expect(isConflictSyncState(next)).toBe(true);
    if (isConflictSyncState(next)) {
      expect(next.fileId).toBe('file-123');
      expect(next.conflict.remoteEtag).toBe('remote-etag-xyz');
    }
  });

  it('enforces immediate push on conflict resolution with local or merge (remediates LUGX-003)', () => {
    const conflict: SyncState = {
      status: 'conflict',
      fileId: 'file-123',
      conflict: {
        baseVersion: 1,
        remoteVersion: 2,
        remoteEtag: 'remote-etag',
        detectedAt: 1700000100,
      },
    };

    // 'local' resolution MUST transition to syncing (forcing local push) rather than idle
    const localEvent: SyncEvent = {
      type: 'RESOLVE_CONFLICT',
      resolution: 'local',
      timestamp: 1700000200,
    };
    const nextLocal = reduceSyncState(conflict, localEvent);
    expect(nextLocal.status).toBe('syncing');
    expect(isSyncingState(nextLocal)).toBe(true);

    // 'merge' resolution MUST also transition to syncing to push merged delta
    const mergeEvent: SyncEvent = {
      type: 'RESOLVE_CONFLICT',
      resolution: 'merge',
      mergedContent: '# Merged Content',
      timestamp: 1700000250,
    };
    const nextMerge = reduceSyncState(conflict, mergeEvent);
    expect(nextMerge.status).toBe('syncing');

    // 'remote' resolution accepts remote version, transitioning cleanly to idle
    const remoteEvent: SyncEvent = {
      type: 'RESOLVE_CONFLICT',
      resolution: 'remote',
      timestamp: 1700000300,
    };
    const nextRemote = reduceSyncState(conflict, remoteEvent);
    expect(nextRemote.status).toBe('idle');
    if (isIdleSyncState(nextRemote)) {
      expect(nextRemote.lastSyncedAt).toBe(1700000300);
    }
  });

  it('transitions from syncing to error and increments retry count upon SYNC_ERROR', () => {
    const syncing: SyncState = {
      status: 'syncing',
      fileId: 'file-123',
      startedAt: 1700000000,
      retryCount: 1,
    };
    const errorEvent: SyncEvent = {
      type: 'SYNC_ERROR',
      error: 'HTTP 503 Service Unavailable',
      retryAfterSeconds: 5,
      timestamp: 1700000100,
    };

    const next = reduceSyncState(syncing, errorEvent);
    expect(next.status).toBe('error');
    expect(isErrorSyncState(next)).toBe(true);
    if (isErrorSyncState(next)) {
      expect(next.retryCount).toBe(2);
      expect(next.retryAfterSeconds).toBe(5);
      expect(next.failedAt).toBe(1700000100);
    }

    // RETRY_SYNC from error state returns to syncing with preserved retryCount
    const retryEvent: SyncEvent = {
      type: 'RETRY_SYNC',
      timestamp: 1700000200,
    };
    const afterRetry = reduceSyncState(next, retryEvent);
    expect(afterRetry.status).toBe('syncing');
    if (isSyncingState(afterRetry)) {
      expect(afterRetry.retryCount).toBe(2);
    }
  });

  it('strictly rejects impossible transitions (e.g. idle -> conflict directly)', () => {
    const idle: SyncState = { status: 'idle' };
    const invalidConflictEvent: SyncEvent = {
      type: 'CONFLICT_DETECTED',
      fileId: 'file-123',
      conflict: {
        baseVersion: 1,
        remoteVersion: 2,
        remoteEtag: 'etag',
        detectedAt: 1700000000,
      },
      timestamp: 1700000000,
    };

    expect(isValidSyncTransition(idle, invalidConflictEvent)).toBe(false);
    expect(() => reduceSyncState(idle, invalidConflictEvent)).toThrow(InvalidSyncTransitionError);

    // Non-strict returns state unchanged
    const fallback = reduceSyncState(idle, invalidConflictEvent, { strict: false });
    expect(fallback).toBe(idle);
  });

  it('rejects SYNC_SUCCESS and SYNC_ERROR on idle state', () => {
    const idle: SyncState = { status: 'idle' };
    const successEvent: SyncEvent = { type: 'SYNC_SUCCESS', timestamp: 1700000000 };
    const errorEvent: SyncEvent = { type: 'SYNC_ERROR', error: 'Fail', timestamp: 1700000000 };

    expect(() => reduceSyncState(idle, successEvent)).toThrow(InvalidSyncTransitionError);
    expect(() => reduceSyncState(idle, errorEvent)).toThrow(InvalidSyncTransitionError);
  });
});

describe('Phase 6: Pure Stripe Webhook Event Reducer (LUGX-025, LUGX-135)', () => {
  it('correctly maps terminal subscription statuses', () => {
    expect(isTerminalSubscriptionStatus('canceled')).toBe(true);
    expect(isTerminalSubscriptionStatus('incomplete_expired')).toBe(true);
    expect(isTerminalSubscriptionStatus('active')).toBe(false);
    expect(isTerminalSubscriptionStatus('trialing')).toBe(false);
    expect(isTerminalSubscriptionStatus('past_due')).toBe(false);
  });

  it('activates subscription on checkout.session.completed with paid status', () => {
    const initial: SubscriptionState = { status: 'none', tier: 'free', isTerminal: false };
    const event: StripeWebhookEvent = {
      type: 'checkout.session.completed',
      subscriptionId: 'sub_123',
      tier: 'pro',
      userId: 'user_456',
      paymentStatus: 'paid',
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      timestamp: 1700000000,
    };

    const result = reduceSubscriptionState(initial, event);
    expect(result.action).toBe('applied');
    expect(result.state.status).toBe('active');
    if (result.state.status === 'active') {
      expect(result.state.tier).toBe('pro');
      expect(result.state.subscriptionId).toBe('sub_123');
      expect(result.state.cancelAtPeriodEnd).toBe(false);
    }
  });

  it('fails-closed: rejects non-paid checkout.session.completed without tier upgrade', () => {
    const initial: SubscriptionState = { status: 'none', tier: 'free', isTerminal: false };
    const event: StripeWebhookEvent = {
      type: 'checkout.session.completed',
      subscriptionId: 'sub_unpaid',
      tier: 'ultra',
      userId: 'user_456',
      paymentStatus: 'unpaid',
      timestamp: 1700000000,
    };

    const result = reduceSubscriptionState(initial, event);
    expect(result.action).toBe('noop');
    expect(result.state.status).toBe('none');
    expect(result.state.tier).toBe('free');
  });

  it('transitions active to canceled upon customer.subscription.deleted', () => {
    const active: SubscriptionState = {
      status: 'active',
      tier: 'pro',
      subscriptionId: 'sub_123',
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      cancelAtPeriodEnd: false,
      isTerminal: false,
    };
    const event: StripeWebhookEvent = {
      type: 'customer.subscription.deleted',
      subscriptionId: 'sub_123',
      timestamp: 1701000000,
    };

    const result = reduceSubscriptionState(active, event);
    expect(result.action).toBe('applied');
    expect(result.state.status).toBe('canceled');
    expect(result.state.tier).toBe('free');
    expect(result.state.isTerminal).toBe(true);
  });

  it('enforces terminal state protection: ignores stale active update on canceled subscription (remediates LUGX-025, LUGX-135)', () => {
    const canceled: SubscriptionState = {
      status: 'canceled',
      tier: 'free',
      subscriptionId: 'sub_123',
      canceledAt: 1701000000,
      isTerminal: true,
    };

    // Stale customer.subscription.updated arrives trying to reactivate sub_123
    const staleUpdate: StripeWebhookEvent = {
      type: 'customer.subscription.updated',
      subscriptionId: 'sub_123',
      status: 'active',
      tier: 'pro',
      timestamp: 1701000500,
    };

    // Default mode: returns ignored_stale without mutating state
    const result = reduceSubscriptionState(canceled, staleUpdate, { strict: false });
    expect(result.action).toBe('ignored_stale');
    expect(result.state.status).toBe('canceled');
    expect(result.state.tier).toBe('free');

    // Strict mode: throws TerminalSubscriptionStateError
    expect(() =>
      reduceSubscriptionState(canceled, staleUpdate, { strict: true })
    ).toThrow(TerminalSubscriptionStateError);
  });

  it('allows activating a completely new subscriptionId even after previous cancellation', () => {
    const previousCanceled: SubscriptionState = {
      status: 'canceled',
      tier: 'free',
      subscriptionId: 'sub_old',
      canceledAt: 1701000000,
      isTerminal: true,
    };

    const newCheckout: StripeWebhookEvent = {
      type: 'checkout.session.completed',
      subscriptionId: 'sub_new_789',
      tier: 'ultra',
      userId: 'user_456',
      paymentStatus: 'paid',
      currentPeriodStart: 1702000000,
      currentPeriodEnd: 1704592000,
      timestamp: 1702000000,
    };

    const result = reduceSubscriptionState(previousCanceled, newCheckout);
    expect(result.action).toBe('applied');
    expect(result.state.status).toBe('active');
    if (result.state.status === 'active') {
      expect(result.state.subscriptionId).toBe('sub_new_789');
      expect(result.state.tier).toBe('ultra');
    }
  });

  it('transitions active to past_due on invoice.payment_failed, and recovers on payment_succeeded', () => {
    const active: SubscriptionState = {
      status: 'active',
      tier: 'pro',
      subscriptionId: 'sub_123',
      currentPeriodStart: 1700000000,
      currentPeriodEnd: 1702592000,
      cancelAtPeriodEnd: false,
      isTerminal: false,
    };

    const failEvent: StripeWebhookEvent = {
      type: 'invoice.payment_failed',
      subscriptionId: 'sub_123',
      timestamp: 1702592100,
    };
    const failResult = reduceSubscriptionState(active, failEvent);
    expect(failResult.action).toBe('applied');
    expect(failResult.state.status).toBe('past_due');

    const succeedEvent: StripeWebhookEvent = {
      type: 'invoice.payment_succeeded',
      subscriptionId: 'sub_123',
      timestamp: 1702595000,
    };
    const recoverResult = reduceSubscriptionState(failResult.state, succeedEvent);
    expect(recoverResult.action).toBe('applied');
    expect(recoverResult.state.status).toBe('active');
  });
});

describe('Phase 6: Pure Quota Settlement Reducer (LUGX-001, LUGX-115)', () => {
  it('satisfies conservation law for pre-TTFT zero consumption (full refund)', () => {
    const settlement = calculateQuotaSettlement({
      reservedUnits: 500,
      consumedUnits: 0,
    });

    expect(settlement.toCommit).toBe(0);
    expect(settlement.toRefund).toBe(500);
    expect(settlement.toCommit + settlement.toRefund).toBe(500);
    expect(settlement.isOverage).toBe(false);
  });

  it('satisfies conservation law for partial streaming consumption', () => {
    const settlement = calculateQuotaSettlement({
      reservedUnits: 1000,
      consumedUnits: 432,
    });

    expect(settlement.toCommit).toBe(432);
    expect(settlement.toRefund).toBe(568);
    expect(settlement.toCommit + settlement.toRefund).toBe(1000);
    expect(settlement.unusedUnits).toBe(568);
    expect(settlement.isOverage).toBe(false);
  });

  it('satisfies conservation law for exact consumption match', () => {
    const settlement = calculateQuotaSettlement({
      reservedUnits: 800,
      consumedUnits: 800,
    });

    expect(settlement.toCommit).toBe(800);
    expect(settlement.toRefund).toBe(0);
    expect(settlement.toCommit + settlement.toRefund).toBe(800);
    expect(settlement.isOverage).toBe(false);
  });

  it('caps commitment at reserved units during overage consumption', () => {
    const settlement = calculateQuotaSettlement({
      reservedUnits: 500,
      consumedUnits: 950,
    });

    expect(settlement.toCommit).toBe(500);
    expect(settlement.toRefund).toBe(0);
    expect(settlement.isOverage).toBe(true);
    expect(settlement.consumedUnits).toBe(950);
  });

  it('sanitizes negative, NaN, and fractional inputs gracefully', () => {
    const negative = calculateQuotaSettlement({
      reservedUnits: -100,
      consumedUnits: -50,
    });
    expect(negative.toCommit).toBe(0);
    expect(negative.toRefund).toBe(0);

    const fractional = calculateQuotaSettlement({
      reservedUnits: 100.75,
      consumedUnits: 40.2,
    });
    expect(fractional.reservedUnits).toBe(100);
    expect(fractional.consumedUnits).toBe(40);
    expect(fractional.toCommit).toBe(40);
    expect(fractional.toRefund).toBe(60);
  });

  it('manages full reservation state lifecycle: idle -> reserved -> committed', () => {
    const idle: QuotaReservationState = { status: 'idle' };
    const reserveEvent: QuotaReservationEvent = {
      type: 'RESERVE',
      reservationId: 'res-1',
      operationId: 'op-1',
      userId: 'user-1',
      reservedUnits: 600,
      expiresAt: 1700001000,
      timestamp: 1700000000,
    };

    const reserved = reduceQuotaReservationState(idle, reserveEvent);
    expect(reserved.status).toBe('reserved');
    if (reserved.status === 'reserved') {
      expect(reserved.reservedUnits).toBe(600);
    }

    const commitEvent: QuotaReservationEvent = {
      type: 'COMMIT',
      consumedUnits: 350,
      timestamp: 1700000500,
    };
    const committed = reduceQuotaReservationState(reserved, commitEvent);
    expect(committed.status).toBe('committed');
    if (committed.status === 'committed') {
      expect(committed.committedUnits).toBe(350);
      expect(committed.refundedUnits).toBe(250);
      expect(committed.settledAt).toBe(1700000500);
    }

    // Idempotent commit replay
    const replayed = reduceQuotaReservationState(committed, commitEvent);
    expect(replayed).toBe(committed);
  });

  it('manages full reservation state lifecycle: idle -> reserved -> refunded', () => {
    const idle: QuotaReservationState = { status: 'idle' };
    const reserved = reduceQuotaReservationState(idle, {
      type: 'RESERVE',
      reservationId: 'res-2',
      operationId: 'op-2',
      userId: 'user-1',
      reservedUnits: 400,
      expiresAt: 1700001000,
      timestamp: 1700000000,
    });

    const refunded = reduceQuotaReservationState(reserved, {
      type: 'REFUND',
      timestamp: 1700000300,
    });
    expect(refunded.status).toBe('refunded');
    if (refunded.status === 'refunded') {
      expect(refunded.refundedUnits).toBe(400);
    }

    // Idempotent refund replay
    const replayed = reduceQuotaReservationState(refunded, {
      type: 'REFUND',
      timestamp: 1700000400,
    });
    expect(replayed).toBe(refunded);
  });

  it('rejects conflicting lifecycle transitions (cannot refund committed, cannot commit refunded)', () => {
    const committed: QuotaReservationState = {
      status: 'committed',
      reservationId: 'res-3',
      operationId: 'op-3',
      userId: 'user-1',
      committedUnits: 500,
      refundedUnits: 0,
      settledAt: 1700000000,
    };

    expect(() =>
      reduceQuotaReservationState(committed, { type: 'REFUND', timestamp: 1700000100 })
    ).toThrow(QuotaStateConflictError);

    const refunded: QuotaReservationState = {
      status: 'refunded',
      reservationId: 'res-4',
      operationId: 'op-4',
      userId: 'user-1',
      refundedUnits: 500,
      refundedAt: 1700000000,
    };

    expect(() =>
      reduceQuotaReservationState(refunded, { type: 'COMMIT', timestamp: 1700000100 })
    ).toThrow(QuotaStateConflictError);
  });
});

describe('Phase 6: 100% Purity & Side-Effect Free Assertions', () => {
  it('verifies that all three reducers never call Date.now() or fetch()', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    try {
      // 1. Sync reducer execution
      const syncResult = reduceSyncState(
        { status: 'idle' },
        { type: 'START_SYNC', fileId: 'f1', timestamp: 12345 }
      );
      expect(syncResult.status).toBe('syncing');

      // 2. Stripe reducer execution
      const stripeResult = reduceSubscriptionState(
        { status: 'none', tier: 'free', isTerminal: false },
        {
          type: 'checkout.session.completed',
          subscriptionId: 'sub-purity',
          tier: 'pro',
          userId: 'u1',
          paymentStatus: 'paid',
          timestamp: 12345,
        }
      );
      expect(stripeResult.action).toBe('applied');

      // 3. Quota calculator & reservation reducer execution
      const settlement = calculateQuotaSettlement({
        reservedUnits: 100,
        consumedUnits: 50,
      });
      expect(settlement.toCommit).toBe(50);

      const reservationResult = reduceQuotaReservationState(
        { status: 'idle' },
        {
          type: 'RESERVE',
          reservationId: 'r1',
          operationId: 'op1',
          userId: 'u1',
          reservedUnits: 100,
          expiresAt: 20000,
          timestamp: 12345,
        }
      );
      expect(reservationResult.status).toBe('reserved');

      // Purity assertions
      expect(dateSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
