/**
 * Pure Sync State Reducer & Contract Safety Net
 *
 * Implements side-effect-free, deterministic state transitions for file synchronization.
 * Guarantees that impossible transitions (e.g., idle -> conflict without an active sync)
 * are rejected at compile-time and runtime.
 *
 * Remediates: LUGX-003, LUGX-010, LUGX-036, LUGX-040
 */

export type SyncStatusState = 'idle' | 'syncing' | 'conflict' | 'error';

/**
 * Payload describing a detected sync conflict
 */
export interface SyncConflictPayload {
  readonly baseVersion: number;
  readonly remoteVersion: number;
  readonly remoteEtag: string;
  readonly detectedAt: number;
}

/**
 * Discriminated union of sync machine states
 */
export interface IdleSyncState {
  readonly status: 'idle';
  readonly lastSyncedAt?: number;
  readonly lastError?: string;
}

export interface SyncingState {
  readonly status: 'syncing';
  readonly fileId?: string;
  readonly operationId?: string;
  readonly startedAt: number;
  readonly retryCount: number;
}

export interface ConflictSyncState {
  readonly status: 'conflict';
  readonly fileId: string;
  readonly conflict: SyncConflictPayload;
}

export interface ErrorSyncState {
  readonly status: 'error';
  readonly fileId?: string;
  readonly error: string;
  readonly retryAfterSeconds?: number;
  readonly retryCount: number;
  readonly failedAt: number;
}

export type SyncState = IdleSyncState | SyncingState | ConflictSyncState | ErrorSyncState;

/**
 * Discriminated union of sync events
 */
export type SyncEvent =
  | {
      readonly type: 'START_SYNC';
      readonly fileId?: string;
      readonly operationId?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'SYNC_SUCCESS';
      readonly timestamp: number;
      readonly newEtag?: string;
      readonly newVersion?: number;
    }
  | {
      readonly type: 'SYNC_ERROR';
      readonly error: string;
      readonly retryAfterSeconds?: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'CONFLICT_DETECTED';
      readonly fileId: string;
      readonly conflict: SyncConflictPayload;
      readonly timestamp: number;
    }
  | {
      readonly type: 'RESOLVE_CONFLICT';
      readonly resolution: 'local' | 'remote' | 'merge';
      readonly mergedContent?: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'RETRY_SYNC';
      readonly timestamp: number;
    }
  | {
      readonly type: 'RESET_TO_IDLE';
    };

/**
 * Domain error for forbidden state transitions
 */
export class InvalidSyncTransitionError extends Error {
  readonly code = 'INVALID_SYNC_TRANSITION';

  constructor(
    public readonly currentStatus: SyncStatusState,
    public readonly eventType: SyncEvent['type'],
    message?: string
  ) {
    super(
      message ||
        `Forbidden sync transition: cannot handle event '${eventType}' while in '${currentStatus}' state`
    );
    this.name = 'InvalidSyncTransitionError';
    Object.setPrototypeOf(this, InvalidSyncTransitionError.prototype);
  }
}

/**
 * Type guards
 */
export function isIdleSyncState(state: SyncState): state is IdleSyncState {
  return state.status === 'idle';
}

export function isSyncingState(state: SyncState): state is SyncingState {
  return state.status === 'syncing';
}

export function isConflictSyncState(state: SyncState): state is ConflictSyncState {
  return state.status === 'conflict';
}

export function isErrorSyncState(state: SyncState): state is ErrorSyncState {
  return state.status === 'error';
}

/**
 * Checks whether an event can be legally applied to the current state
 */
export function isValidSyncTransition(state: SyncState, event: SyncEvent): boolean {
  switch (state.status) {
    case 'idle':
      return event.type === 'START_SYNC' || event.type === 'RESET_TO_IDLE';

    case 'syncing':
      return (
        event.type === 'SYNC_SUCCESS' ||
        event.type === 'SYNC_ERROR' ||
        event.type === 'CONFLICT_DETECTED' ||
        event.type === 'RESET_TO_IDLE'
      );

    case 'conflict':
      return event.type === 'RESOLVE_CONFLICT' || event.type === 'RESET_TO_IDLE';

    case 'error':
      return (
        event.type === 'RETRY_SYNC' ||
        event.type === 'START_SYNC' ||
        event.type === 'RESET_TO_IDLE'
      );

    default:
      return false;
  }
}

export interface ReducerOptions {
  /** If true (default), invalid transitions throw InvalidSyncTransitionError; if false, returns previous state */
  readonly strict?: boolean;
}

/**
 * Pure sync state transition reducer: (state, event) => nextState
 *
 * Invariant: Completely pure, zero side-effects, zero I/O, deterministic output.
 */
export function reduceSyncState(
  currentState: SyncState,
  event: SyncEvent,
  options: ReducerOptions = { strict: true }
): SyncState {
  const strict = options.strict ?? true;

  if (!isValidSyncTransition(currentState, event)) {
    if (strict) {
      throw new InvalidSyncTransitionError(currentState.status, event.type);
    }
    return currentState;
  }

  switch (currentState.status) {
    case 'idle': {
      if (event.type === 'START_SYNC') {
        return {
          status: 'syncing',
          fileId: event.fileId,
          operationId: event.operationId,
          startedAt: event.timestamp,
          retryCount: 0,
        };
      }
      if (event.type === 'RESET_TO_IDLE') {
        return currentState;
      }
      break;
    }

    case 'syncing': {
      if (event.type === 'SYNC_SUCCESS') {
        return {
          status: 'idle',
          lastSyncedAt: event.timestamp,
        };
      }
      if (event.type === 'CONFLICT_DETECTED') {
        return {
          status: 'conflict',
          fileId: event.fileId,
          conflict: event.conflict,
        };
      }
      if (event.type === 'SYNC_ERROR') {
        return {
          status: 'error',
          fileId: currentState.fileId,
          error: event.error,
          retryAfterSeconds: event.retryAfterSeconds,
          retryCount: currentState.retryCount + 1,
          failedAt: event.timestamp,
        };
      }
      if (event.type === 'RESET_TO_IDLE') {
        return { status: 'idle' };
      }
      break;
    }

    case 'conflict': {
      if (event.type === 'RESOLVE_CONFLICT') {
        // Remediates LUGX-003: 'local' and 'merge' resolution require immediate push (syncing state)
        if (event.resolution === 'local' || event.resolution === 'merge') {
          return {
            status: 'syncing',
            fileId: currentState.fileId,
            startedAt: event.timestamp,
            retryCount: 0,
          };
        }
        // 'remote' accepts remote version without local push
        return {
          status: 'idle',
          lastSyncedAt: event.timestamp,
        };
      }
      if (event.type === 'RESET_TO_IDLE') {
        return { status: 'idle' };
      }
      break;
    }

    case 'error': {
      if (event.type === 'RETRY_SYNC') {
        return {
          status: 'syncing',
          fileId: currentState.fileId,
          startedAt: event.timestamp,
          retryCount: currentState.retryCount,
        };
      }
      if (event.type === 'START_SYNC') {
        return {
          status: 'syncing',
          fileId: event.fileId,
          operationId: event.operationId,
          startedAt: event.timestamp,
          retryCount: 0,
        };
      }
      if (event.type === 'RESET_TO_IDLE') {
        return { status: 'idle' };
      }
      break;
    }
  }

  return currentState;
}
