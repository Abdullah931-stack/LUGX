/**
 * Pure Stripe Webhook Event Reducer & Subscription State Machine
 *
 * Implements deterministic subscription lifecycle state transitions and enforces
 * terminal state protection. Prevents out-of-order or replayed Stripe events from
 * reactivating canceled subscriptions.
 *
 * Remediates: LUGX-025, LUGX-135
 */

import type { TierName } from '@/config/tiers.config';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

/**
 * Terminal subscription statuses from which backward transitions are forbidden
 */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'canceled',
  'incomplete_expired',
]);

/**
 * Checks if a subscription status is terminal
 */
export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
  return TERMINAL_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * Discriminated union of subscription machine states
 */
export interface ActiveSubscriptionState {
  readonly status: 'active';
  readonly tier: TierName;
  readonly subscriptionId: string;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly cancelAtPeriodEnd: boolean;
  readonly isTerminal: false;
}

export interface TrialingSubscriptionState {
  readonly status: 'trialing';
  readonly tier: TierName;
  readonly subscriptionId: string;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly cancelAtPeriodEnd: boolean;
  readonly isTerminal: false;
}

export interface PastDueSubscriptionState {
  readonly status: 'past_due';
  readonly tier: TierName;
  readonly subscriptionId: string;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly isTerminal: false;
}

export interface CanceledSubscriptionState {
  readonly status: 'canceled';
  readonly tier: 'free';
  readonly subscriptionId: string;
  readonly canceledAt: number;
  readonly isTerminal: true;
}

export interface IncompleteSubscriptionState {
  readonly status: 'incomplete';
  readonly tier: TierName;
  readonly subscriptionId: string;
  readonly isTerminal: false;
}

export interface IncompleteExpiredSubscriptionState {
  readonly status: 'incomplete_expired';
  readonly tier: 'free';
  readonly subscriptionId: string;
  readonly isTerminal: true;
}

export interface UnpaidSubscriptionState {
  readonly status: 'unpaid';
  readonly tier: 'free';
  readonly subscriptionId: string;
  readonly isTerminal: false;
}

export interface NoSubscriptionState {
  readonly status: 'none';
  readonly tier: 'free';
  readonly isTerminal: false;
}

export type SubscriptionState =
  | ActiveSubscriptionState
  | TrialingSubscriptionState
  | PastDueSubscriptionState
  | CanceledSubscriptionState
  | IncompleteSubscriptionState
  | IncompleteExpiredSubscriptionState
  | UnpaidSubscriptionState
  | NoSubscriptionState;

/**
 * Inbound Stripe webhook events
 */
export type StripeWebhookEvent =
  | {
      readonly type: 'checkout.session.completed';
      readonly subscriptionId?: string;
      readonly tier: TierName;
      readonly userId: string;
      readonly paymentStatus: 'paid' | 'unpaid';
      readonly currentPeriodStart?: number;
      readonly currentPeriodEnd?: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'customer.subscription.updated';
      readonly subscriptionId: string;
      readonly status: SubscriptionStatus;
      readonly tier?: TierName;
      readonly currentPeriodStart?: number;
      readonly currentPeriodEnd?: number;
      readonly cancelAtPeriodEnd?: boolean;
      readonly timestamp: number;
    }
  | {
      readonly type: 'customer.subscription.deleted';
      readonly subscriptionId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'invoice.payment_failed';
      readonly subscriptionId: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'invoice.payment_succeeded';
      readonly subscriptionId: string;
      readonly timestamp: number;
    };

/**
 * Outcome of an attempted subscription state transition
 */
export interface SubscriptionTransitionResult {
  readonly state: SubscriptionState;
  readonly action: 'applied' | 'ignored_stale' | 'noop';
  readonly reason?: string;
}

/**
 * Domain error for illegal terminal state violation attempts
 */
export class TerminalSubscriptionStateError extends Error {
  readonly code = 'TERMINAL_SUBSCRIPTION_STATE_VIOLATION';

  constructor(
    public readonly subscriptionId: string,
    public readonly currentStatus: SubscriptionStatus,
    public readonly targetStatus: SubscriptionStatus,
    message?: string
  ) {
    super(
      message ||
        `Terminal state protection: cannot reactivate subscription '${subscriptionId}' from terminal state '${currentStatus}' to '${targetStatus}'`
    );
    this.name = 'TerminalSubscriptionStateError';
    Object.setPrototypeOf(this, TerminalSubscriptionStateError.prototype);
  }
}

export interface WebhookReducerOptions {
  /** If true, illegal terminal state transitions throw; if false, returns ignored_stale */
  readonly strict?: boolean;
}

/**
 * Pure Stripe event reducer: (currentState, event) => SubscriptionTransitionResult
 *
 * Invariants:
 * 1. Terminal state protection: canceled or incomplete_expired cannot be overwritten by
 *    stale out-of-order update events with the same subscriptionId.
 * 2. Privileges follow payment: only genuine active/trialing statuses provide paid tier.
 * 3. Side-effect free: NO Date.now(), NO DB, NO network calls.
 */
export function reduceSubscriptionState(
  currentState: SubscriptionState,
  event: StripeWebhookEvent,
  options: WebhookReducerOptions = { strict: false }
): SubscriptionTransitionResult {
  // Handle new checkout session completed
  if (event.type === 'checkout.session.completed') {
    // Fail-closed: non-paid checkout does not grant paid privileges
    if (event.paymentStatus !== 'paid') {
      return {
        state: currentState,
        action: 'noop',
        reason: `Checkout completed with non-paid payment_status: ${event.paymentStatus}`,
      };
    }

    const subId = event.subscriptionId || 'one_time_checkout';
    const periodStart = event.currentPeriodStart ?? event.timestamp;
    const periodEnd = event.currentPeriodEnd ?? periodStart + 30 * 24 * 60 * 60 * 1000;

    return {
      state: {
        status: 'active',
        tier: event.tier,
        subscriptionId: subId,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        isTerminal: false,
      },
      action: 'applied',
    };
  }

  // If current state has a subscription and the incoming event matches its ID
  const isMatchingSub =
    'subscriptionId' in currentState && currentState.subscriptionId === event.subscriptionId;

  // Terminal state protection check for matching subscription
  if (isMatchingSub && currentState.isTerminal) {
    if (event.type === 'customer.subscription.updated' && event.status === 'active') {
      if (options.strict) {
        throw new TerminalSubscriptionStateError(
          currentState.subscriptionId,
          currentState.status,
          event.status
        );
      }
      return {
        state: currentState,
        action: 'ignored_stale',
        reason: `Stale update ignored: subscription ${currentState.subscriptionId} is frozen in terminal state '${currentState.status}'`,
      };
    }

    if (event.type === 'customer.subscription.deleted') {
      return {
        state: currentState,
        action: 'noop',
        reason: 'Subscription already canceled',
      };
    }
  }

  switch (event.type) {
    case 'customer.subscription.deleted': {
      return {
        state: {
          status: 'canceled',
          tier: 'free',
          subscriptionId: event.subscriptionId,
          canceledAt: event.timestamp,
          isTerminal: true,
        },
        action: 'applied',
      };
    }

    case 'customer.subscription.updated': {
      // Map effective tier based on status
      const effectiveTier: TierName =
        event.status === 'active' || event.status === 'trialing'
          ? (event.tier ?? ('tier' in currentState ? currentState.tier : 'free'))
          : 'free';

      const periodStart =
        event.currentPeriodStart ??
        ('currentPeriodStart' in currentState ? currentState.currentPeriodStart : event.timestamp);
      const periodEnd =
        event.currentPeriodEnd ??
        ('currentPeriodEnd' in currentState
          ? currentState.currentPeriodEnd
          : periodStart + 30 * 24 * 60 * 60 * 1000);
      const cancelAtEnd =
        event.cancelAtPeriodEnd ??
        ('cancelAtPeriodEnd' in currentState ? currentState.cancelAtPeriodEnd : false);

      if (event.status === 'canceled') {
        return {
          state: {
            status: 'canceled',
            tier: 'free',
            subscriptionId: event.subscriptionId,
            canceledAt: event.timestamp,
            isTerminal: true,
          },
          action: 'applied',
        };
      }

      if (event.status === 'incomplete_expired') {
        return {
          state: {
            status: 'incomplete_expired',
            tier: 'free',
            subscriptionId: event.subscriptionId,
            isTerminal: true,
          },
          action: 'applied',
        };
      }

      if (event.status === 'past_due') {
        return {
          state: {
            status: 'past_due',
            tier: effectiveTier,
            subscriptionId: event.subscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            isTerminal: false,
          },
          action: 'applied',
        };
      }

      if (event.status === 'trialing') {
        return {
          state: {
            status: 'trialing',
            tier: effectiveTier,
            subscriptionId: event.subscriptionId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: cancelAtEnd,
            isTerminal: false,
          },
          action: 'applied',
        };
      }

      if (event.status === 'incomplete') {
        return {
          state: {
            status: 'incomplete',
            tier: effectiveTier,
            subscriptionId: event.subscriptionId,
            isTerminal: false,
          },
          action: 'applied',
        };
      }

      if (event.status === 'unpaid') {
        return {
          state: {
            status: 'unpaid',
            tier: 'free',
            subscriptionId: event.subscriptionId,
            isTerminal: false,
          },
          action: 'applied',
        };
      }

      return {
        state: {
          status: 'active',
          tier: effectiveTier,
          subscriptionId: event.subscriptionId,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: cancelAtEnd,
          isTerminal: false,
        },
        action: 'applied',
      };
    }

    case 'invoice.payment_failed': {
      if ('subscriptionId' in currentState && currentState.subscriptionId === event.subscriptionId) {
        if (currentState.status === 'active' || currentState.status === 'trialing') {
          return {
            state: {
              status: 'past_due',
              tier: currentState.tier,
              subscriptionId: currentState.subscriptionId,
              currentPeriodStart: currentState.currentPeriodStart,
              currentPeriodEnd: currentState.currentPeriodEnd,
              isTerminal: false,
            },
            action: 'applied',
          };
        }
      }
      return { state: currentState, action: 'noop' };
    }

    case 'invoice.payment_succeeded': {
      if ('subscriptionId' in currentState && currentState.subscriptionId === event.subscriptionId) {
        if (currentState.status === 'past_due' || currentState.status === 'incomplete') {
          return {
            state: {
              status: 'active',
              tier: currentState.tier,
              subscriptionId: currentState.subscriptionId,
              currentPeriodStart:
                'currentPeriodStart' in currentState ? currentState.currentPeriodStart : event.timestamp,
              currentPeriodEnd:
                'currentPeriodEnd' in currentState
                  ? currentState.currentPeriodEnd
                  : event.timestamp + 30 * 24 * 60 * 60 * 1000,
              cancelAtPeriodEnd: false,
              isTerminal: false,
            },
            action: 'applied',
          };
        }
      }
      return { state: currentState, action: 'noop' };
    }
  }

  return { state: currentState, action: 'noop' };
}
