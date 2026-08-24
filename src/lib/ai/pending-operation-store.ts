/**
 * Pending AI Operation Store (Phase 11)
 *
 * sessionStorage-backed registry of in-flight / undecided AI operations so a
 * HARD page reload (where React cleanup never runs) can still recover the
 * operationId on the next mount and settle its quota reservation correctly.
 *
 * Guarantees:
 * 1. Never stores document content - only identifiers and a phase marker.
 * 2. Tab-scoped (sessionStorage): a record can never leak across tabs.
 * 3. All accessors are SSR-safe no-ops outside the browser.
 */

export type PendingAIPhase = "generating" | "preview_ready";

export interface PendingAIOperationRecord {
    operationId: string;
    fileId: string;
    phase: PendingAIPhase;
    updatedAt: number;
}

const STORE_KEY = "textai_pending_ai_operations";

function isBrowser(): boolean {
    return typeof window !== "undefined" && !!window.sessionStorage;
}

function readAll(): Record<string, PendingAIOperationRecord> {
    if (!isBrowser()) return {};
    try {
        const raw = window.sessionStorage.getItem(STORE_KEY);
        return raw ? (JSON.parse(raw) as Record<string, PendingAIOperationRecord>) : {};
    } catch {
        return {};
    }
}

function writeAll(records: Record<string, PendingAIOperationRecord>): void {
    if (!isBrowser()) return;
    try {
        window.sessionStorage.setItem(STORE_KEY, JSON.stringify(records));
    } catch {
        // Quota / private-mode storage failures must never break the editor flow.
    }
}

/** Register a newly started AI operation (phase: generating). */
export function trackPendingAIOperation(
    operationId: string,
    fileId: string,
    phase: PendingAIPhase
): void {
    const records = readAll();
    records[operationId] = { operationId, fileId, phase, updatedAt: Date.now() };
    writeAll(records);
}

/** Advance the phase of a tracked operation (generating -> preview_ready). */
export function updatePendingAIOperationPhase(
    operationId: string,
    phase: PendingAIPhase
): void {
    const records = readAll();
    const record = records[operationId];
    if (!record) return;
    record.phase = phase;
    record.updatedAt = Date.now();
    writeAll(records);
}

/** Remove a tracked operation once it has been definitively settled. */
export function clearPendingAIOperation(operationId: string): void {
    const records = readAll();
    if (!(operationId in records)) return;
    delete records[operationId];
    writeAll(records);
}

/** List all currently tracked (potentially orphaned) operations. */
export function listPendingAIOperations(): PendingAIOperationRecord[] {
    return Object.values(readAll());
}
