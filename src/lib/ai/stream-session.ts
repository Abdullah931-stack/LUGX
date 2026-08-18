import { AIOperation } from "./prompts";

export type AIStreamStatus =
    | "idle"
    | "reserved"
    | "streaming"
    | "completed"
    | "committing"
    | "committed"
    | "aborting"
    | "aborted"
    | "failed"
    | "rolled_back";

export interface SelectionAnchor {
    from: number;
    to: number;
}

export interface AIStreamSession {
    sessionId: string;
    operationId: string;
    fileId: string;
    operation: AIOperation;
    originalHtml: string;
    originalText: string;
    selection: SelectionAnchor;
    expectedVersion: number;
    originalEtag: string | null;
    status: AIStreamStatus;
    reservationId?: string;
    periodKey?: string;
    editorGeneration: number;
    abortController: AbortController;
    startedAt: number;
    firstChunkAt?: number;
    completedAt?: number;
    failureReason?: string;
}

// Map of allowed finite state machine transitions
const ALLOWED_TRANSITIONS: Record<AIStreamStatus, AIStreamStatus[]> = {
    idle: ["reserved", "failed", "aborted"],
    reserved: ["streaming", "aborting", "failed", "rolled_back"],
    streaming: ["completed", "aborting", "failed", "rolled_back"],
    completed: ["committing", "aborting", "failed", "rolled_back"],
    committing: ["committed", "failed", "rolled_back"],
    committed: ["idle"],
    aborting: ["aborted", "rolled_back", "failed"],
    aborted: ["idle"],
    failed: ["idle"],
    rolled_back: ["idle"],
};

/**
 * Validates if a state transition is permitted by the FSM
 */
export function isValidTransition(from: AIStreamStatus, to: AIStreamStatus): boolean {
    const allowed = ALLOWED_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
}

/**
 * Checks whether a session status is in a terminal final state
 */
export function isTerminalStatus(status: AIStreamStatus): boolean {
    return ["committed", "aborted", "failed", "rolled_back"].includes(status);
}

/**
 * Creates a new immutable AI streaming session snapshot
 */
export function createStreamSession(params: {
    sessionId: string;
    operationId: string;
    fileId: string;
    operation: AIOperation;
    originalHtml: string;
    originalText: string;
    selection: SelectionAnchor;
    expectedVersion: number;
    originalEtag: string | null;
    editorGeneration: number;
    abortController?: AbortController;
}): AIStreamSession {
    return {
        sessionId: params.sessionId,
        operationId: params.operationId,
        fileId: params.fileId,
        operation: params.operation,
        originalHtml: params.originalHtml,
        originalText: params.originalText,
        selection: params.selection,
        expectedVersion: params.expectedVersion,
        originalEtag: params.originalEtag,
        status: "idle",
        editorGeneration: params.editorGeneration,
        abortController: params.abortController || new AbortController(),
        startedAt: Date.now(),
    };
}

/**
 * Transitions session to target status with strict validation
 */
export function transitionSession(
    session: AIStreamSession,
    nextStatus: AIStreamStatus,
    reason?: string
): AIStreamSession {
    if (!isValidTransition(session.status, nextStatus)) {
        throw new Error(
            `[AIStreamSession] Invalid transition from '${session.status}' to '${nextStatus}'`
        );
    }

    session.status = nextStatus;
    if (reason) {
        session.failureReason = reason;
    }

    if (nextStatus === "streaming" && !session.firstChunkAt) {
        session.firstChunkAt = Date.now();
    }
    if (nextStatus === "completed" || nextStatus === "committed") {
        session.completedAt = Date.now();
    }

    return session;
}

/**
 * Asserts that the active editor generation and file version match the session anchor
 */
export function assertSessionIntegrity(
    session: AIStreamSession,
    currentGeneration: number,
    currentVersion: number
): { valid: boolean; reason?: string } {
    if (session.editorGeneration !== currentGeneration) {
        return {
            valid: false,
            reason: `Editor generation mismatch (session: ${session.editorGeneration}, current: ${currentGeneration})`,
        };
    }

    if (session.expectedVersion !== currentVersion) {
        return {
            valid: false,
            reason: `File version mismatch (session: ${session.expectedVersion}, current: ${currentVersion})`,
        };
    }

    return { valid: true };
}
