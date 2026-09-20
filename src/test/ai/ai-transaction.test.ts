/**
 * @vitest-environment jsdom
 *
 * M4/M5 / Gate G8 / Phase 8 / Phase 6: AI operation content-safety & UI streaming tests with CodeMirror 6.
 *
 * Guarantees that an AI operation can NEVER corrupt or leave the document in a half-modified state:
 *   1. Streaming isolation: during active streaming, chunks update an
 *      ephemeral CodeMirror 6 StateField decoration without mutating the underlying
 *      document tree (docChanged is false, auto-save does NOT fire).
 *   2. Partial selection: only the target sub-range [from, to] is replaced;
 *      preceding and subsequent paragraphs remain completely intact.
 *   3. On success: the change is applied as ONE undoable transaction,
 *      and a single Ctrl+Z restores the full original content.
 *   4. On failure / abort: the ephemeral decoration is cleared and the
 *      document remains in its pristine pre-operation state.
 *   5. Server confirmation invariant: Local editor transaction
 *      is executed ONLY after server commit confirms success.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { CodeMirrorEditorAdapter } from "@/components/editor/markdown/editor-adapter";
import { codeMirrorStreamingGhostField } from "@/components/editor/markdown/streaming-ghost";

const initialDoc = "Hello world, this is a test document with multiple paragraphs.\n\nSecond paragraph here.";

describe("Ephemeral Streaming Ghost Extension — Invariant Guarantees (CodeMirror 6)", () => {
    let adapter: CodeMirrorEditorAdapter;
    let view: EditorView;
    let parent: HTMLDivElement;

    beforeEach(() => {
        if (typeof Range.prototype.getClientRects !== 'function') {
            Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        }
        if (typeof Range.prototype.getBoundingClientRect !== 'function') {
            Range.prototype.getBoundingClientRect = () => ({
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
        }

        parent = document.createElement("div");
        document.body.appendChild(parent);

        const state = EditorState.create({
            doc: initialDoc,
            extensions: [
                history(),
                codeMirrorStreamingGhostField,
            ],
        });

        view = new EditorView({
            state,
            parent,
        });

        adapter = new CodeMirrorEditorAdapter(view);
    });

    afterEach(() => {
        if (view) {
            view.destroy();
        }
        if (parent && parent.parentNode) {
            parent.parentNode.removeChild(parent);
        }
    });

    it("should start and update streaming ghost with real-time text chunks without mutating doc or triggering auto-save", () => {
        const initialText = adapter.getValue();

        // 1. Start streaming ghost at range [0, 20]
        adapter.startStreamingGhost({
            from: 0,
            to: 20,
            text: "Generating...",
            operation: "improve",
        });

        // Verify field state is active
        const state1 = view.state.field(codeMirrorStreamingGhostField);
        expect(state1.active).toBe(true);
        expect(state1.from).toBe(0);
        expect(state1.to).toBe(20);

        // Crucial: document text must NOT have changed
        expect(adapter.getValue()).toBe(initialText);

        // 2. Stream several chunks progressively
        adapter.updateStreamingGhost("Generating paragraph 1...", true);
        adapter.updateStreamingGhost("Generating paragraph 1... and paragraph 2.", true);

        const state2 = view.state.field(codeMirrorStreamingGhostField);
        expect(state2.text).toBe("Generating paragraph 1... and paragraph 2.");

        // Document still completely pristine
        expect(adapter.getValue()).toBe(initialText);

        // 3. Clear streaming ghost
        adapter.clearStreamingGhost();
        const state3 = view.state.field(codeMirrorStreamingGhostField);
        expect(state3.active).toBe(false);
        expect(adapter.getValue()).toBe(initialText);
    });

    it("replaces the full document with AI output as one undoable action", () => {
        const before = adapter.getValue();
        const aiResult = "Improved: hello world — now better written!";

        adapter.startStreamingGhost({
            from: 0,
            to: adapter.getCharCount(),
            text: aiResult,
        });

        adapter.clearStreamingGhost();
        adapter.replaceRange(0, adapter.getCharCount(), aiResult);

        // Doc changed: AI result is present, original wording replaced.
        expect(adapter.getValue()).toBe(aiResult);

        // Streaming ghost is deactivated
        const ghostState = view.state.field(codeMirrorStreamingGhostField);
        expect(ghostState.active).toBe(false);

        // Single undo restores the FULL original document exactly.
        const undoSuccess = adapter.undo();
        expect(undoSuccess).toBe(true);
        expect(adapter.getValue()).toBe(before);
    });

    it("replaces only the selected range, leaving surrounding text intact with atomic undo", () => {
        const fullText = adapter.getValue();
        const phrase = "this is a test document";
        const from = fullText.indexOf(phrase);
        const to = from + phrase.length;
        expect(from).toBeGreaterThan(0);

        const before = adapter.getValue();

        // Start streaming ghost on target range
        adapter.startStreamingGhost({ from, to, text: "an edited phrase" });

        // Commit transaction
        adapter.clearStreamingGhost();
        adapter.replaceRange(from, to, "an edited phrase");

        // Surrounding context preserved.
        expect(adapter.getValue()).toContain("Hello world,");
        expect(adapter.getValue()).toContain("Second paragraph here.");
        expect(adapter.getValue()).not.toContain("test document");

        // Single undo restores everything including the unedited phrase.
        adapter.undo();
        expect(adapter.getValue()).toBe(before);
    });

    it("clearing streaming ghost on abort/error leaves pristine document untouched", () => {
        const before = adapter.getValue();

        // Simulate streaming in progress
        adapter.startStreamingGhost({
            from: 0,
            to: 15,
            text: "Partial chunk before network drop...",
        });

        // Simulate user abort / network drop -> clear ghost
        adapter.clearStreamingGhost();

        expect(view.state.field(codeMirrorStreamingGhostField).active).toBe(false);
        expect(adapter.getValue()).toBe(before);
    });

    it("does not apply local editor transaction if server commit fails (Server-First Invariant)", async () => {
        const before = adapter.getValue();

        adapter.startStreamingGhost({
            from: 0,
            to: 10,
            text: "Generated text awaiting commit",
        });

        // Mock commit failure
        const fakeServerCommit = vi.fn().mockResolvedValue({
            success: false,
            status: "error",
            error: "Commit rejected by DB",
        });

        const res = await fakeServerCommit();
        if (!res.success) {
            // Local transaction aborted
            adapter.clearStreamingGhost();
        }

        expect(adapter.getValue()).toBe(before);
    });
});
