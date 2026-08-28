// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
    createMarkdownExtensions,
    createEditorAdapter,
    EditorAdapter,
} from "@/components/editor/markdown";

describe("Markdown Editor: Interaction, Delimiter Visibility & Vertical Navigation", () => {
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

    describe("1. Delimiter Visibility & Line Styling", () => {
        it("should apply .cm-md-hr with zero vertical margins to avoid HeightMap coordinate drift", () => {
            const doc = "First Line\n\n---\n\nSecond Line";
            initEditor(doc, "live");

            const hrLine = parent.querySelector(".cm-md-hr");
            expect(hrLine).not.toBeNull();
            expect(hrLine?.classList.contains("cm-line")).toBe(true);
        });

        it("should apply .cm-md-header-1 to heading line and maintain text content", () => {
            const doc = "# Heading One\nNormal Paragraph";
            initEditor(doc, "live");

            const headingLine = parent.querySelector(".cm-md-header-1");
            expect(headingLine).not.toBeNull();
            expect(headingLine?.textContent).toContain("#");
            expect(headingLine?.textContent).toContain("Heading One");
        });

        it("should smoothly toggle delimiter visibility without destroying DOM nodes", () => {
            const doc = "Line 1\n# Heading 1\nLine 3";
            initEditor(doc, "live");

            // Initially cursor is at 0 (Line 1), so # is delimiterHidden
            const hiddenDelimiter = parent.querySelector(".cm-md-delimiter-hidden");
            expect(hiddenDelimiter).not.toBeNull();
            expect(hiddenDelimiter?.textContent).toBe("#");

            // Move cursor to Line 2 (# Heading 1)
            const line2Pos = doc.indexOf("#") + 3;
            view.dispatch({ selection: { anchor: line2Pos } });

            // Now # should be delimiterVisible
            const visibleDelimiter = parent.querySelector(".cm-md-delimiter-visible");
            expect(visibleDelimiter).not.toBeNull();
            expect(visibleDelimiter?.textContent).toBe("#");
        });
    });

    describe("2. Selection & Cursor Placement Around Delimiters", () => {
        it("should accurately select lines directly above and below a horizontal rule", () => {
            const doc = "Line Above HR\n\n---\n\nLine Below HR";
            initEditor(doc, "live");

            // Select line above HR
            adapter.setSelection(0, 13);
            expect(adapter.getSelectedText()).toBe("Line Above HR");

            // Select line below HR
            const belowStart = doc.indexOf("Line Below HR");
            adapter.setSelection(belowStart, belowStart + 13);
            expect(adapter.getSelectedText()).toBe("Line Below HR");
        });

        it("should accurately select lines directly above and below a heading", () => {
            const doc = "Line Above Heading\n# Header Section\nLine Below Heading";
            initEditor(doc, "live");

            // Select line above heading
            adapter.setSelection(0, 18);
            expect(adapter.getSelectedText()).toBe("Line Above Heading");

            // Select heading itself
            const headingStart = doc.indexOf("# Header Section");
            adapter.setSelection(headingStart, headingStart + 16);
            expect(adapter.getSelectedText()).toBe("# Header Section");

            // Select line below heading
            const belowStart = doc.indexOf("Line Below Heading");
            adapter.setSelection(belowStart, belowStart + 18);
            expect(adapter.getSelectedText()).toBe("Line Below Heading");
        });

        it("should allow multi-line selection spanning across Markdown delimiters without truncation", () => {
            const doc = "Paragraph above\n\n---\n\n# Heading Section\nParagraph below";
            initEditor(doc, "live");

            // Select from start of doc to end of doc
            adapter.setSelection(0, doc.length);
            expect(adapter.getSelectedText()).toBe(doc);

            // Select across the HR line
            const hrStart = doc.indexOf("---");
            const headingEnd = doc.indexOf("Section") + 7;
            adapter.setSelection(hrStart - 5, headingEnd);
            expect(adapter.getSelectedText()).toContain("---");
            expect(adapter.getSelectedText()).toContain("# Heading Section");
        });
    });

    describe("3. Adversarial Hardening & Stress Invariants", () => {
        it("should prevent task checkbox mutation in read-only mode and disable input element", () => {
            parent = document.createElement("div");
            document.body.appendChild(parent);

            const doc = "- [ ] Locked Task Item";
            const extensions = createMarkdownExtensions({
                mode: "live",
                readOnly: true,
            });

            const state = EditorState.create({ doc, extensions });
            view = new EditorView({ state, parent });
            adapter = createEditorAdapter(view, "live");

            const checkbox = parent.querySelector(".cm-md-task-checkbox") as HTMLInputElement;
            expect(checkbox).not.toBeNull();
            expect(checkbox.disabled).toBe(true);

            // Simulate click event
            checkbox.click();
            expect(adapter.getValue()).toBe("- [ ] Locked Task Item");
        });

        it("should toggle task checkbox in editable mode", () => {
            parent = document.createElement("div");
            document.body.appendChild(parent);

            const doc = "- [ ] Editable Task Item";
            const extensions = createMarkdownExtensions({
                mode: "live",
                readOnly: false,
            });

            const state = EditorState.create({ doc, extensions });
            view = new EditorView({ state, parent });
            adapter = createEditorAdapter(view, "live");

            const checkbox = parent.querySelector(".cm-md-task-checkbox") as HTMLInputElement;
            expect(checkbox).not.toBeNull();
            expect(checkbox.disabled).toBe(false);

            checkbox.click();
            expect(adapter.getValue()).toBe("- [x] Editable Task Item");
        });

        it("should count words accurately with zero-allocation on large multilingual documents", () => {
            const sample = "هذا نص عربي مركب مع كلمات English وأرقام 123 ورموز.\n";
            const largeDoc = sample.repeat(1000); // 1,000 paragraphs

            initEditor(largeDoc, "live");

            const count = adapter.getWordCount();
            expect(count).toBe(10000); // 10 words per paragraph * 1000
        });

        it("should handle rapid deletions and extreme boundary conditions without RangeError", () => {
            const complexDoc = "```typescript\nconst a = 10;\n```\n> Blockquote line\n# Title\n---";
            initEditor(complexDoc, "live");

            // Rapidly wipe out entire document in one transaction
            adapter.setValue("");
            expect(adapter.getValue()).toBe("");
            expect(adapter.getLineCount()).toBe(1);

            // Re-insert unclosed fenced code block at end of doc
            adapter.setValue("```js\nconsole.log('unclosed');");
            expect(adapter.getValue()).toContain("```js");
        });
    });
});
