// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
    createMarkdownExtensions,
    createEditorAdapter,
    EditorAdapter,
} from "@/components/editor/markdown";
import fs from "node:fs";
import path from "node:path";

describe("Phase 2: TipTap Replacement & Markdown Editor Tooling Integration", () => {
    let parent: HTMLDivElement;
    let view: EditorView;
    let adapter: EditorAdapter;

    function initEditor(initialDoc = "", mode: "live" | "source" = "live"): { view: EditorView; adapter: EditorAdapter } {
        parent = document.createElement("div");
        document.body.appendChild(parent);

        const extensions = createMarkdownExtensions({
            mode,
            placeholder: "Type markdown here...",
        });

        const state = EditorState.create({
            doc: initialDoc,
            extensions,
        });

        view = new EditorView({
            state,
            parent,
        });

        adapter = createEditorAdapter(view, mode);
        return { view, adapter };
    }

    afterEach(() => {
        if (view) {
            view.destroy();
        }
        if (parent && parent.parentNode) {
            parent.parentNode.removeChild(parent);
        }
    });

    describe("1. Zero TipTap Invariants in Target Components", () => {
        it("src/app/workspace/editor/[fileId]/page.tsx must have ZERO @tiptap imports or getHTML/setContent calls", () => {
            const pagePath = path.resolve(process.cwd(), "src/app/workspace/editor/[fileId]/page.tsx");
            const content = fs.readFileSync(pagePath, "utf-8");

            expect(content).not.toContain("@tiptap");
            expect(content).not.toContain("getHTML");
            expect(content).not.toContain("from \"@tiptap/react\"");
            expect(content).not.toContain("EditorContent");
            expect(content).toContain("MarkdownEditor");
        });

        it("src/components/editor/search-replace.tsx must have ZERO @tiptap imports", () => {
            const searchPath = path.resolve(process.cwd(), "src/components/editor/search-replace.tsx");
            const content = fs.readFileSync(searchPath, "utf-8");

            expect(content).not.toContain("@tiptap");
            expect(content).not.toContain("commands.setContent");
            expect(content).toContain("EditorAdapter");
        });

        it("src/hooks/use-editor-orchestrator.ts must have ZERO @tiptap imports", () => {
            const orchestratorPath = path.resolve(process.cwd(), "src/hooks/use-editor-orchestrator.ts");
            const content = fs.readFileSync(orchestratorPath, "utf-8");

            expect(content).not.toContain("@tiptap");
            expect(content).toContain("EditorAdapter");
        });

        it("src/hooks/use-ai-stream.ts must have ZERO @tiptap imports", () => {
            const aiStreamPath = path.resolve(process.cwd(), "src/hooks/use-ai-stream.ts");
            const content = fs.readFileSync(aiStreamPath, "utf-8");

            expect(content).not.toContain("@tiptap");
            expect(content).not.toContain("from \"@tiptap/react\"");
            expect(content).toContain("EditorAdapter");
        });
    });

    describe("2. Multi-Range Transaction (replaceAll) & Overlap Immunity", () => {
        it("should replace multiple matches in a single atomic transaction without offset shifting", () => {
            const doc = "foo alpha foo beta foo gamma";
            initEditor(doc);

            // Matches for "foo": [0..3], [10..13], [19..22]
            const changes = [
                { from: 0, to: 3, insert: "BAR_EXTENDED" },
                { from: 10, to: 13, insert: "BAR_EXTENDED" },
                { from: 19, to: 22, insert: "BAR_EXTENDED" },
            ];

            adapter.replaceRanges(changes);

            expect(adapter.getValue()).toBe("BAR_EXTENDED alpha BAR_EXTENDED beta BAR_EXTENDED gamma");

            // Verify single-step undo restores exact original state
            const undid = adapter.undo();
            expect(undid).toBe(true);
            expect(adapter.getValue()).toBe("foo alpha foo beta foo gamma");
        });

        it("should defensively filter overlapping change ranges without crashing CodeMirror", () => {
            const doc = "aaaaa";
            initEditor(doc);

            // Intentionally provide overlapping changes: [0..2], [1..3], [3..5]
            const overlappingChanges = [
                { from: 0, to: 2, insert: "X" },
                { from: 1, to: 3, insert: "Y" }, // Overlaps with previous
                { from: 3, to: 5, insert: "Z" },
            ];

            // Must NOT throw Error: Overlapping changes in ChangeSpec
            expect(() => adapter.replaceRanges(overlappingChanges)).not.toThrow();
            // [0..2] -> "X", [1..3] skipped, [3..5] -> "Z"
            expect(adapter.getValue()).toBe("XaZ");
        });

        it("should preserve markdown formatting characters during multi-range replace", () => {
            const doc = "# العنوان الأول\n\nنص **مهم** جداً وفيه كلمة تجربة مكررة هنا: تجربة وتجربة أخرى.";
            initEditor(doc);

            // Replace "تجربة" (3 occurrences)
            const searchText = "تجربة";
            const matches: { from: number; to: number; insert: string }[] = [];
            let pos = 0;
            while (pos < doc.length) {
                const idx = doc.indexOf(searchText, pos);
                if (idx === -1) break;
                matches.push({ from: idx, to: idx + searchText.length, insert: "اختبار" });
                pos = idx + searchText.length;
            }

            expect(matches.length).toBe(3);
            adapter.replaceRanges(matches);

            expect(adapter.getValue()).toBe("# العنوان الأول\n\nنص **مهم** جداً وفيه كلمة اختبار مكررة هنا: اختبار واختبار أخرى.");
            // Verify bold formatting and heading were untouched
            expect(adapter.getValue()).toContain("**مهم**");
            expect(adapter.getValue()).toContain("# العنوان الأول");
        });
    });

    describe("3. Markdown Toolbar Formatting & Selection Wrapping", () => {
        it("should wrap selected text with markdown prefix and suffix and keep selection valid", () => {
            const doc = "هذا نص تجريبي للاختبار";
            initEditor(doc);

            // Select "نص تجريبي" (4 to 13)
            adapter.setSelection(4, 13);
            expect(adapter.getSelectedText()).toBe("نص تجريبي");

            // Wrap with Bold "**"
            adapter.insertMarkdown("**", "**", "نص عريض");

            expect(adapter.getValue()).toBe("هذا **نص تجريبي** للاختبار");
        });

        it("should apply block heading at the start of the line even when cursor is in the middle of text", () => {
            const doc = "هذا سطر عادي";
            initEditor(doc);

            // Cursor in the middle (index 5)
            adapter.setSelection(5, 5);

            // Apply Heading 1 "# "
            adapter.insertMarkdown("# ", "", "عنوان");

            // Must prepend at the start of the line, NOT insert inline
            expect(adapter.getValue()).toBe("# هذا سطر عادي");
        });

        it("should insert syntax with placeholder and correct cursor position when selection is empty", () => {
            const doc = "بداية النص ";
            initEditor(doc);

            // Cursor at end (index 11)
            adapter.setSelection(11, 11);
            expect(adapter.getSelectedText()).toBe("");

            // Insert link template
            adapter.insertMarkdown("[", "](https://example.com)", "رابط");

            expect(adapter.getValue()).toBe("بداية النص [رابط](https://example.com)");
            // Selection should cover the inserted placeholder "رابط"
            const sel = adapter.getSelection();
            expect(sel.from).toBe(12); // after "["
            expect(sel.to).toBe(16);   // after "رابط"
        });

        it("should wrap inline code properly", () => {
            const doc = "استخدم دالة console.log هنا";
            initEditor(doc);

            adapter.setSelection(12, 23);
            expect(adapter.getSelectedText()).toBe("console.log");

            adapter.insertMarkdown("`", "`", "code");
            expect(adapter.getValue()).toBe("استخدم دالة `console.log` هنا");
        });

        it("should insert block formatting like headings and lists on an empty line", () => {
            const doc = "";
            initEditor(doc);

            adapter.insertMarkdown("### ", "", "عنوان فرعي");
            expect(adapter.getValue()).toBe("### ");
        });
    });

    describe("4. Dynamic Editability & Freeze during Hydration", () => {
        it("should freeze editor when setEditable(false) and allow changes after setEditable(true)", () => {
            initEditor("Initial markdown text");

            adapter.setEditable(false);
            expect(view.state.readOnly).toBe(true);

            adapter.setEditable(true);
            expect(view.state.readOnly).toBe(false);
        });
    });

    describe("5. Pure Markdown Stats and Extraction", () => {
        it("should accurately count words and characters without HTML conversion", () => {
            const rawMarkdown = "## عنوان تجريبي\n\nهذا **نص عربي** مع `كود` و 123 رقم.";
            initEditor(rawMarkdown);

            expect(adapter.getCharCount()).toBe(rawMarkdown.length);
            expect(adapter.getWordCount()).toBe(10); // ["عنوان", "تجريبي", "هذا", "نص", "عربي", "مع", "كود", "و", "123", "رقم"]
            expect(adapter.getLineCount()).toBe(3);
            expect(adapter.getHeadingCount()).toBe(1);
        });
    });
});
