/**
 * Pure Quota Settlement Reducer & Reservation State Machine
 *
 * Implements deterministic mathematical quota calculation and immutable reservation
 * lifecycle transitions. Ensures quota conservation (toCommit + toRefund === reserved)
 * and prevents double-refund or commit-after-refund conflicts.
 *
 * Remediates: LUGX-001, LUGX-115
 */

export interface QuotaSettlementInput {
  readonly reservedUnits: number;
  readonly consumedUnits: number;
}

export interface QuotaSettlementDecision {
  readonly toCommit: number;
  readonly toRefund: number;
  readonly isOverage: boolean;
  readonly unusedUnits: number;
  readonly reservedUnits: number;
  readonly consumedUnits: number;
}

/**
 * Calculates deterministic quota commitment and refund allocations.
 *
 * Mathematical Invariants:
 * 1. Non-negativity: toCommit >= 0, toRefund >= 0
 * 2. Conservation Law: toCommit + toRefund === reservedUnits (when consumed <= reserved)
 * 3. Cap Invariant: toCommit never exceeds reservedUnits
 * 4. Purity: Side-effect free, deterministic, integer-quantized.
 */
export function calculateQuotaSettlement(input: QuotaSettlementInput): QuotaSettlementDecision {
  // Sanitize and quantize inputs to non-negative integers
  const reserved = Math.max(0, Math.floor(Number.isFinite(input.reservedUnits) ? input.reservedUnits : 0));
  const consumed = Math.max(0, Math.floor(Number.isFinite(input.consumedUnits) ? input.consumedUnits : 0));

  if (reserved === 0) {
    return {
      toCommit: 0,
      toRefund: 0,
      isOverage: consumed > 0,
      unusedUnits: 0,
      reservedUnits: 0,
      consumedUnits: consumed,
    };
  }

  // Pre-TTFT abort / complete failure: full refund
  if (consumed === 0) {
    return {
      toCommit: 0,
      toRefund: reserved,
      isOverage: false,
      unusedUnits: reserved,
      reservedUnits: reserved,
      consumedUnits: 0,
    };
  }

  // Over-consumption: cap at reservation limit
  if (consumed >= reserved) {
    return {
      toCommit: reserved,
      toRefund: 0,
      isOverage: consumed > reserved,
      unusedUnits: 0,
      reservedUnits: reserved,
      consumedUnits: consumed,
    };
  }

  // Partial consumption: commit consumed words, refund remainder
  const toCommit = consumed;
  const toRefund = reserved - consumed;

  return {
    toCommit,
    toRefund,
    isOverage: false,
    unusedUnits: toRefund,
    reservedUnits: reserved,
    consumedUnits: consumed,
  };
}

export type QuotaReservationStatus = 'idle' | 'reserved' | 'committed' | 'refunded' | 'expired';

export interface IdleReservationState {
  readonly status: 'idle';
}

export interface ReservedReservationState {
  readonly status: 'reserved';
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly reservedUnits: number;
  readonly expiresAt: number;
}

export interface CommittedReservationState {
  readonly status: 'committed';
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly committedUnits: number;
  readonly refundedUnits: number;
  readonly settledAt: number;
}

export interface RefundedReservationState {
  readonly status: 'refunded';
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly refundedUnits: number;
  readonly refundedAt: number;
}

export interface ExpiredReservationState {
  readonly status: 'expired';
  readonly reservationId: string;
  readonly operationId: string;
  readonly userId: string;
  readonly expiredAt: number;
}

export type QuotaReservationState =
  | IdleReservationState
  | ReservedReservationState
  | CommittedReservationState
  | RefundedReservationState
  | ExpiredReservationState;

export type QuotaReservationEvent =
  | {
      readonly type: 'RESERVE';
      readonly reservationId: string;
      readonly operationId: string;
      readonly userId: string;
      readonly reservedUnits: number;
      readonly expiresAt: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'COMMIT';
      readonly consumedUnits?: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'REFUND';
      readonly timestamp: number;
    }
  | {
      readonly type: 'EXPIRE';
      readonly timestamp: number;
    };

/**
 * Domain error for illegal quota reservation lifecycle transitions
 */
export class QuotaStateConflictError extends Error {
  readonly code = 'QUOTA_STATE_CONFLICT';

  constructor(
    public readonly currentStatus: QuotaReservationStatus,
    public readonly eventType: QuotaReservationEvent['type'],
    message?: string
  ) {
    super(
      message ||
        `Quota reservation conflict: cannot execute '${eventType}' while reservation is in '${currentStatus}' status`
    );
    this.name = 'QuotaStateConflictError';
    Object.setPrototypeOf(this, QuotaStateConflictError.prototype);
  }
}

export interface QuotaReducerOptions {
  /** If true (default), conflicting transitions throw QuotaStateConflictError */
  readonly strict?: boolean;
}

/**
 * Pure AI quota reservation state reducer: (state, event) => nextState
 *
 * Invariants:
 * 1. Committed reservations cannot be refunded.
 * 2. Refunded reservations cannot be committed.
 * 3. Expired reservations cannot be committed or refunded.
 * 4. Idempotent replays of identical events return the same state.
 */
export function reduceQuotaReservationState(
  currentState: QuotaReservationState,
  event: QuotaReservationEvent,
  options: QuotaReducerOptions = { strict: true }
): QuotaReservationState {
  const strict = options.strict ?? true;

  switch (currentState.status) {
    case 'idle': {
      if (event.type === 'RESERVE') {
        return {
          status: 'reserved',
          reservationId: event.reservationId,
          operationId: event.operationId,
          userId: event.userId,
          reservedUnits: Math.max(0, Math.floor(event.reservedUnits)),
          expiresAt: event.expiresAt,
        };
      }
      if (strict) {
        throw new QuotaStateConflictError(currentState.status, event.type);
      }
      return currentState;
    }

    case 'reserved': {
      if (event.type === 'COMMIT') {
        const consumed = event.consumedUnits ?? currentState.reservedUnits;
        const settlement = calculateQuotaSettlement({
          reservedUnits: currentState.reservedUnits,
          consumedUnits: consumed,
        });

        return {
          status: 'committed',
          reservationId: currentState.reservationId,
          operationId: currentState.operationId,
          userId: currentState.userId,
          committedUnits: settlement.toCommit,
          refundedUnits: settlement.toRefund,
          settledAt: event.timestamp,
        };
      }

      if (event.type === 'REFUND') {
        return {
          status: 'refunded',
          reservationId: currentState.reservationId,
          operationId: currentState.operationId,
          userId: currentState.userId,
          refundedUnits: currentState.reservedUnits,
          refundedAt: event.timestamp,
        };
      }

      if (event.type === 'EXPIRE') {
        return {
          status: 'expired',
          reservationId: currentState.reservationId,
          operationId: currentState.operationId,
          userId: currentState.userId,
          expiredAt: event.timestamp,
        };
      }

      if (strict) {
        throw new QuotaStateConflictError(currentState.status, event.type);
      }
      return currentState;
    }

    case 'committed': {
      // Idempotent replay: committing an already committed reservation is a safe noop
      if (event.type === 'COMMIT') {
        return currentState;
      }
      if (strict) {
        throw new QuotaStateConflictError(currentState.status, event.type);
      }
      return currentState;
    }

    case 'refunded': {
      // Idempotent replay: refunding an already refunded reservation is a safe noop
      if (event.type === 'REFUND') {
        return currentState;
      }
      if (strict) {
        throw new QuotaStateConflictError(currentState.status, event.type);
      }
      return currentState;
    }

    case 'expired': {
      // Expired reservations cannot transition further
      if (strict) {
        throw new QuotaStateConflictError(currentState.status, event.type);
      }
      return currentState;
    }
  }
}
