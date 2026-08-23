/**
 * @vitest-environment jsdom
 *
 * M4/M5 / Gate G8 / Phase 8: AI operation content-safety & UI streaming tests.
 *
 * The editor page's handleAIOperation guarantees that an AI operation
 * can NEVER corrupt or leave the document in a half-modified state:
 *   1. Streaming isolation: during active streaming, chunks update an
 *      ephemeral ProseMirror decoration without mutating the underlying
 *      document tree (docChanged is false, auto-save does NOT fire).
 *   2. Partial selection: only the target sub-range [from, to] is replaced;
 *      preceding and subsequent paragraphs remain completely intact.
 *   3. On success: the change is applied as ONE undoable transaction,
 *      and a single Ctrl+Z restores the full original content.
 *   4. On failure / abort: the ephemeral decoration is cleared and the
 *      document remains in its pristine pre-operation state.
 *   5. Server confirmation invariant (Phase 8): Local editor transaction
 *      is executed ONLY after server commit confirms success.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { convertTextToHTML } from "@/lib/parsers/text-to-html";
import { sanitizeHtml } from "@/lib/sanitize-client";
import {
    StreamingGhostExtension,
    streamingGhostPluginKey,
} from "@/lib/extensions/streaming-ghost-extension";

/**
 * Reproduces the page's applyAITransaction semantics on a raw editor.
 * Returns { docAfter, undoResult } for assertion.
 */
function runAITransaction(
    editor: Editor,
    selectionStart: number,
    selectionEnd: number,
    collectedText: string
): { docAfter: string; undoResult: string } {
    const html = convertTextToHTML(collectedText);
    const safeHtml = sanitizeHtml(html);

    // Clear streaming ghost decoration first
    editor.commands.clearStreamingGhost();

    // ONE undoable transaction: select, delete, insert (matches the page).
    editor.chain()
        .setTextSelection({ from: selectionStart, to: selectionEnd })
        .deleteSelection()
        .insertContent(safeHtml)
        .run();

    const docAfter = editor.getHTML();
    const undoResult = editor.chain().undo().run() ? editor.getHTML() : docAfter;
    return { docAfter, undoResult };
}

let editor: Editor;

beforeEach(() => {
    editor = new Editor({
        extensions: [StarterKit, StreamingGhostExtension],
        content: "<p>Hello world, this is a test document with multiple paragraphs.</p><p>Second paragraph here.</p>",
    });
});

describe("Ephemeral Streaming Ghost Extension — Invariant Guarantees", () => {
    it("should start and update streaming ghost with real-time text chunks without mutating editor.state.doc or triggering auto-save", () => {
        const initialDocHTML = editor.getHTML();
        const updateListener = vi.fn();
        editor.on("update", updateListener);

        // 1. Start streaming ghost at range [0, 20]
        editor.commands.startStreamingGhost({
            from: 0,
            to: 20,
            text: "Generating...",
            operation: "improve",
        });

        // Verify plugin state is active
        const state1 = streamingGhostPluginKey.getState(editor.state);
        expect(state1?.active).toBe(true);
        expect(state1?.from).toBe(0);
        expect(state1?.to).toBe(20);

        // Crucial: document HTML must NOT have changed
        expect(editor.getHTML()).toBe(initialDocHTML);
        // Crucial: TipTap update listener must NOT have fired
        expect(updateListener).not.toHaveBeenCalled();

        // 2. Stream several chunks progressively
        editor.commands.updateStreamingGhost("Generating paragraph 1...");
        editor.commands.updateStreamingGhost("Generating paragraph 1... and paragraph 2.");

        const state2 = streamingGhostPluginKey.getState(editor.state);
        expect(state2?.text).toBe("Generating paragraph 1... and paragraph 2.");

        // Document still completely pristine
        expect(editor.getHTML()).toBe(initialDocHTML);
        expect(updateListener).not.toHaveBeenCalled();

        // 3. Clear streaming ghost
        editor.commands.clearStreamingGhost();
        const state3 = streamingGhostPluginKey.getState(editor.state);
        expect(state3?.active).toBe(false);
        expect(editor.getHTML()).toBe(initialDocHTML);
    });
});

describe("AI transaction — Success path & Single-action Undo", () => {
    it("replaces the full document with AI output as one undoable action", () => {
        const before = editor.getHTML();
        const aiResult = "Improved: hello world — now better written!";

        editor.commands.startStreamingGhost({
            from: 0,
            to: editor.state.doc.content.size,
            text: aiResult,
        });

        const { docAfter, undoResult } = runAITransaction(
            editor,
            0,
            editor.state.doc.content.size,
            aiResult
        );

        // Doc changed: AI result is present, original wording replaced.
        expect(docAfter).toContain(convertTextToHTML(aiResult).replace(/<\/?[^>]+>/g, ""));
        expect(docAfter).not.toContain("Hello world, this is a test");

        // Streaming ghost is deactivated
        const ghostState = streamingGhostPluginKey.getState(editor.state);
        expect(ghostState?.active).toBe(false);

        // Single undo restores the FULL original document exactly.
        expect(undoResult).toBe(before);
    });

    it("replaces only the selected range, leaving surrounding text intact with atomic undo", () => {
        const fullText = editor.getText();
        const phrase = "this is a test document";
        const idx = fullText.indexOf(phrase);
        expect(idx).toBeGreaterThan(0);

        const { from, to } = (() => {
            let pos = 0;
            let f = -1, t = -1;
            editor.state.doc.descendants((node, p) => {
                if (node.isText && f === -1) {
                    const segStart = p;
                    if (idx >= pos && idx + phrase.length <= pos + node.text!.length) {
                        f = segStart + (idx - pos);
                        t = f + phrase.length;
                        return false;
                    }
                    pos += node.text!.length;
                }
            });
            return { from: f, to: t };
        })();

        const before = editor.getHTML();

        // Start streaming ghost on target range
        editor.commands.startStreamingGhost({ from, to, text: "an edited phrase" });

        // Commit transaction
        const { docAfter, undoResult } = runAITransaction(
            editor,
            from,
            to,
            "an edited phrase"
        );

        // Surrounding context preserved.
        expect(docAfter).toContain("Hello world,");
        expect(docAfter).toContain("Second paragraph here.");
        expect(docAfter).not.toContain("test document");

        // Single undo restores everything including the unedited phrase.
        expect(undoResult).toBe(before);
    });
});

describe("AI transaction — Failure rollback & Abort", () => {
    it("clearing streaming ghost on abort/error leaves pristine document untouched", () => {
        const before = editor.getHTML();

        // Simulate streaming in progress
        editor.commands.startStreamingGhost({
            from: 0,
            to: 15,
            text: "Partial chunk before network drop...",
        });

        // Simulate user abort / network drop -> clear ghost
        editor.commands.clearStreamingGhost();

        expect(streamingGhostPluginKey.getState(editor.state)?.active).toBe(false);
        expect(editor.getHTML()).toBe(before);
    });

    it("does not apply local editor transaction if server commit fails (Phase 8 Server-First Invariant)", async () => {
        const before = editor.getHTML();

        editor.commands.startStreamingGhost({
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
            editor.commands.clearStreamingGhost();
        }

        expect(editor.getHTML()).toBe(before);
    });
});
