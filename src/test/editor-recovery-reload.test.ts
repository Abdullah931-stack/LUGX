/**
 * @vitest-environment jsdom
 *
 * Phase 11 closure tests: hard-reload recovery semantics for AI operations.
 *
 * Validates:
 * 1. A pending-operation record surviving a HARD reload (where React cleanup
 *    never runs) is queried from the server on the next mount.
 * 2. preview_ready orphan: quota settled as CONSUMED (policy v1.6.0) and the
 *    preview is NEVER applied to the document nor treated as committed.
 * 3. generating orphan: the lost reservation is refunded ('reload_recovery').
 * 4. Already-settled / unknown operations cause zero mutations, record cleared.
 * 5. SPA teardown (unmount cleanup) settles as consumed and clears the record.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import { useAIStream } from "@/hooks/use-ai-stream";

const STORE_KEY = "textai_pending_ai_operations";

const mockGetAIReservationStatus = vi.fn();
const mockCommitAIReservation = vi.fn();
const mockRefundAIReservation = vi.fn();
const mockCommitAIFileOperation = vi.fn();

vi.mock("@/server/actions/ai-commit", () => ({
    commitAIFileOperation: (...args: unknown[]) => mockCommitAIFileOperation(...args),
    refundAIReservation: (...args: unknown[]) => mockRefundAIReservation(...args),
}));

vi.mock("@/server/actions/ai-ops", () => ({
    commitAIReservation: (...args: unknown[]) => mockCommitAIReservation(...args),
    refundAIReservation: (...args: unknown[]) => mockRefundAIReservation(...args),
    getAIReservationStatus: (...args: unknown[]) => mockGetAIReservationStatus(...args),
}));

type ConsumeCallbacks = {
    onMeta?: (meta: { sessionId: string; operationId: string }) => void;
    onChunk?: (accumulated: string, latestChunk: string) => void;
    onComplete?: (finalRawText: string) => void | Promise<void>;
    onError?: (err: Error) => void;
};
const mockConsumeAIStream = vi.fn();
vi.mock("@/lib/ai/stream-handler", () => ({
    consumeAIStream: (...args: unknown[]) => mockConsumeAIStream(...args),
}));
let captured: ConsumeCallbacks;

const initialContent = "The quick brown fox jumps over the lazy dog.";

function createMockAdapter(initial = ""): EditorAdapter {
    let content = initial;
    let sel = { from: 0, to: 0 };
    return {
        getValue: () => content,
        setValue: (newContent: string) => { content = newContent; },
        getSelection: () => sel,
        setSelection: (from: number, to = from) => { sel = { from, to }; },
        replaceRange: (from: number, to: number, insert: string) => {
            content = content.slice(0, from) + insert + content.slice(to);
        },
        replaceRanges: (changes) => {
            const sorted = [...changes].sort((a, b) => b.from - a.from);
            for (const c of sorted) {
                content = content.slice(0, c.from) + c.insert + content.slice(c.to);
            }
        },
        getSelectedText: () => content.slice(sel.from, sel.to),
        insertMarkdown: vi.fn(),
        setEditable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        hasFocus: vi.fn().mockReturnValue(true),
        undo: vi.fn().mockReturnValue(true),
        redo: vi.fn().mockReturnValue(true),
        canUndo: vi.fn().mockReturnValue(true),
        canRedo: vi.fn().mockReturnValue(false),
        getWordCount: () => content.split(/\s+/).filter(Boolean).length,
        getCharCount: () => content.length,
        getLineCount: () => content.split("\n").length,
        getHeadingCount: () => (content.match(/^#{1,6}\s/gm) || []).length,
        getMode: () => "live",
        setMode: vi.fn(),
        destroy: vi.fn(),
        startStreamingGhost: vi.fn(),
        updateStreamingGhost: vi.fn(),
        clearStreamingGhost: vi.fn(),
        getGhostRange: vi.fn().mockReturnValue(null),
    };
}

function seedRecord(record: { operationId: string; fileId: string; phase: string }): void {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[record.operationId] = { ...record, updatedAt: Date.now() };
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(all));
}

function readRecords(): Record<string, { operationId: string; phase: string }> {
    const raw = window.sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
}

describe("Phase 11: hard-reload recovery of pending AI operations", () => {
    let editor: EditorAdapter;

    beforeEach(() => {
        window.sessionStorage.clear();
        vi.clearAllMocks();
        mockCommitAIReservation.mockResolvedValue({ committed: true });
        mockRefundAIReservation.mockResolvedValue({ refunded: true });
        captured = {} as ConsumeCallbacks;

        editor = createMockAdapter(initialContent);

        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            captured = options;
            options.onMeta?.({ sessionId: "s1", operationId: "op1" });
            options.onChunk?.("Partial ", "Partial ");
            // Stream intentionally left open unless the test completes it.
        });
    });

    it("reload during preview_ready: queries the operation, consumes quota, NEVER applies the preview", async () => {
        seedRecord({ operationId: "op_reload_preview", fileId: "file-1", phase: "preview_ready" });
        mockGetAIReservationStatus.mockResolvedValue({
            found: true,
            status: "reserved",
            operation: "improve",
            periodKey: "2026-08-24",
            reservedUnits: 150,
            committedUnits: 0,
            refundedUnits: 0,
            expiresAt: new Date().toISOString(),
        });

        const { result } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await waitFor(() =>
            expect(mockGetAIReservationStatus).toHaveBeenCalledWith("op_reload_preview")
        );
        // Policy v1.6.0: completed-but-undecided generation is consumed, never refunded
        await waitFor(() =>
            expect(mockCommitAIReservation).toHaveBeenCalledWith("op_reload_preview")
        );
        expect(mockRefundAIReservation).not.toHaveBeenCalled();

        // Record cleared after successful settlement
        await waitFor(() => expect(readRecords()["op_reload_preview"]).toBeUndefined());

        // The abandoned preview was NEVER applied to the document or UI state
        expect(result.current.previewText).toBe("");
        expect(result.current.status).toBe("idle");
        expect(editor.getValue()).toBe(initialContent);
    });

    it("reload during generation: refunds the lost reservation as reload_recovery", async () => {
        seedRecord({ operationId: "op_reload_generating", fileId: "file-1", phase: "generating" });
        mockGetAIReservationStatus.mockResolvedValue({
            found: true,
            status: "reserved",
            operation: "correct",
            periodKey: "2026-08-24",
            reservedUnits: 120,
            committedUnits: 0,
            refundedUnits: 0,
            expiresAt: new Date().toISOString(),
        });

        renderHook(() => useAIStream({ onProgrammaticTransaction: (fn) => fn() }));

        await waitFor(() =>
            expect(mockRefundAIReservation).toHaveBeenCalledWith(
                "op_reload_generating",
                "reload_recovery"
            )
        );
        expect(mockCommitAIReservation).not.toHaveBeenCalled();
        await waitFor(() => expect(readRecords()["op_reload_generating"]).toBeUndefined());
    });

    it("already-settled operations are left untouched and their records cleared", async () => {
        seedRecord({ operationId: "op_already_settled", fileId: "file-1", phase: "preview_ready" });
        mockGetAIReservationStatus.mockResolvedValue({
            found: true,
            status: "committed",
            operation: "improve",
            periodKey: "2026-08-24",
            reservedUnits: 150,
            committedUnits: 150,
            refundedUnits: 0,
            expiresAt: new Date().toISOString(),
        });

        renderHook(() => useAIStream({ onProgrammaticTransaction: (fn) => fn() }));

        await waitFor(() =>
            expect(mockGetAIReservationStatus).toHaveBeenCalledWith("op_already_settled")
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(mockCommitAIReservation).not.toHaveBeenCalled();
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
        expect(readRecords()["op_already_settled"]).toBeUndefined();
    });

    it("unknown operation ids are reported not_found, cleared, and never crash the mount", async () => {
        seedRecord({ operationId: "op_unknown", fileId: "file-1", phase: "generating" });
        mockGetAIReservationStatus.mockResolvedValue({ found: false, reason: "not_found" });

        renderHook(() => useAIStream({ onProgrammaticTransaction: (fn) => fn() }));

        await waitFor(() => expect(readRecords()["op_unknown"]).toBeUndefined());
        expect(mockCommitAIReservation).not.toHaveBeenCalled();
        expect(mockRefundAIReservation).not.toHaveBeenCalled();
    });

    it("SPA flow: the tracked record advances to preview_ready and unmount cleanup settles and clears it", async () => {
        const { result, unmount } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        await act(async () => {
            await result.current.startStream({
                editor,
                operation: "improve",
                fileId: "file-1",
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });
        await waitFor(() => expect(result.current.isStreaming).toBe(true));

        // Tracked as generating while streaming
        const trackedId = Object.keys(readRecords())[0];
        expect(trackedId).toBeDefined();
        expect(readRecords()[trackedId].phase).toBe("generating");

        await act(async () => {
            await captured.onComplete?.("Completed output for SPA teardown");
        });
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));
        expect(readRecords()[trackedId].phase).toBe("preview_ready");

        // SPA navigation: React cleanup settles as consumed and clears the record
        unmount();
        await waitFor(() =>
            expect(mockCommitAIReservation).toHaveBeenCalledWith(trackedId)
        );
        await waitFor(() => expect(Object.keys(readRecords())).toHaveLength(0));
        // Document pristine: preview was parked, never applied
        expect(editor.getValue()).toBe(initialContent);
    });
});
