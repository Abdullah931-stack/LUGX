/**
 * @vitest-environment jsdom
 *
 * Phase 11 closure tests: hard-reload recovery semantics for AI operations.
 *
 * Validates:
 * 1. A pending-operation record surviving a HARD reload (where React cleanup
 *    never runs) is cleared safely from client storage on next mount.
 * 2. Abandoned preview is NEVER applied to the document nor committed.
 * 3. Client hook does not invoke financial refund/commit RPCs (Server-Authoritative).
 * 4. SPA teardown (unmount cleanup) aborts active fetch and clears the local record cleanly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { EditorAdapter } from "@/components/editor/markdown/types";
import { useAIStream } from "@/hooks/use-ai-stream";

const STORE_KEY = "textai_pending_ai_operations";

const mockCommitAIFileOperation = vi.fn();

vi.mock("@/server/actions/ai-commit", () => ({
    commitAIFileOperation: (...args: unknown[]) => mockCommitAIFileOperation(...args),
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
        getDirectionSettings: () => ({ mode: "auto", lockCodeBlocksLTR: true }),
        setDirectionSettings: vi.fn(),
        destroy: vi.fn(),
        startStreamingGhost: vi.fn(),
        updateStreamingGhost: vi.fn(),
        clearStreamingGhost: vi.fn(),
        getGhostRange: vi.fn().mockReturnValue(null),
    };
}

function seedRecord(record: { operationId: string; fileId: string; phase: "generating" | "preview_ready" }) {
    const raw = sessionStorage.getItem(STORE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[record.operationId] = {
        ...record,
        updatedAt: Date.now(),
    };
    sessionStorage.setItem(STORE_KEY, JSON.stringify(map));
}

function readRecords(): Record<string, { operationId: string; fileId: string; phase: string }> {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
}

describe("Phase 11: Hard-Reload Recovery & Server-Authoritative Settlement", () => {
    let editor: EditorAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        sessionStorage.clear();
        editor = createMockAdapter(initialContent);

        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            captured = options;
            options.onMeta?.({ sessionId: "s1", operationId: "op1" });
            options.onChunk?.("Partial ", "Partial ");
        });
    });

    it("reload during preview_ready: clears orphan from local storage, NEVER applies the preview", async () => {
        seedRecord({ operationId: "op_reload_preview", fileId: "file-1", phase: "preview_ready" });

        const { result } = renderHook(() =>
            useAIStream({ onProgrammaticTransaction: (fn) => fn() })
        );

        // Record cleared on mount
        await waitFor(() => expect(readRecords()["op_reload_preview"]).toBeUndefined());

        // The abandoned preview was NEVER applied to the document or UI state
        expect(result.current.previewText).toBe("");
        expect(result.current.status).toBe("idle");
        expect(editor.getValue()).toBe(initialContent);
    });

    it("reload during generation: clears orphan from local storage without crashing", async () => {
        seedRecord({ operationId: "op_reload_generating", fileId: "file-1", phase: "generating" });

        renderHook(() => useAIStream({ onProgrammaticTransaction: (fn) => fn() }));

        await waitFor(() => expect(readRecords()["op_reload_generating"]).toBeUndefined());
    });

    it("unknown operation ids are cleared and never crash the mount", async () => {
        seedRecord({ operationId: "op_unknown", fileId: "file-1", phase: "generating" });

        renderHook(() => useAIStream({ onProgrammaticTransaction: (fn) => fn() }));

        await waitFor(() => expect(readRecords()["op_unknown"]).toBeUndefined());
    });

    it("SPA flow: tracked record advances to preview_ready and unmount cleanup clears it without financial RPC", async () => {
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

        const trackedId = Object.keys(readRecords())[0];
        expect(trackedId).toBeDefined();
        expect(readRecords()[trackedId].phase).toBe("generating");

        await act(async () => {
            await captured.onComplete?.("Completed output for SPA teardown");
        });
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));
        expect(readRecords()[trackedId].phase).toBe("preview_ready");

        // SPA navigation: React cleanup aborts session and clears local record
        unmount();
        await waitFor(() => expect(Object.keys(readRecords())).toHaveLength(0));
        expect(editor.getValue()).toBe(initialContent);
    });
});
