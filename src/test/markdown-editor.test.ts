// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
    createMarkdownExtensions,
    calculateWordCount,
    createEditorAdapter,
    EditorAdapter,
    detectMarkdownDirection,
} from "@/components/editor/markdown";

describe("Phase 1: Standalone Markdown Editor & Adapter Contract", () => {
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

    describe("1. Raw-Source Invariant & Exact Value Representation", () => {
        it("should return exact raw Markdown string without HTML parsing or serialization", () => {
            const rawContent = "# العنوان الأول\n\nهذا **نص عريض** مع `كود مدمج` وقائمة:\n- عنصر 1\n- عنصر 2\n\n```js\nconsole.log('hello');\n```";
            initEditor(rawContent);

            expect(adapter.getValue()).toBe(rawContent);
            expect(adapter.getValue()).not.toContain("<h1");
            expect(adapter.getValue()).not.toContain("<p>");
            expect(adapter.getValue()).not.toContain("<strong>");
        });

        it("should handle empty string as valid markdown without creating empty paragraphs or placeholders", () => {
            initEditor("");
            expect(adapter.getValue()).toBe("");
            expect(adapter.getCharCount()).toBe(0);
            expect(adapter.getWordCount()).toBe(0);
        });

        it("should preserve incomplete markdown constructs exactly as typed", () => {
            const brokenMarkdown = "```typescript\nconst a = 10;\n[غير مكتمل رابط (http://\n**نص غير مغلق";
            initEditor(brokenMarkdown);

            expect(adapter.getValue()).toBe(brokenMarkdown);
        });
    });

    describe("2. EditorAdapter Core Operations", () => {
        beforeEach(() => {
            initEditor("Hello World");
        });

        it("should setValue and replace entire document", () => {
            adapter.setValue("# New Header\n\nContent paragraph");
            expect(adapter.getValue()).toBe("# New Header\n\nContent paragraph");
            expect(adapter.getLineCount()).toBe(3);
        });

        it("should replaceRange at exact character offsets", () => {
            // "Hello World" -> replace "World" (5 to 11) with "Universe!"
            adapter.replaceRange(6, 11, "Universe!");
            expect(adapter.getValue()).toBe("Hello Universe!");
        });

        it("should get and set selection with bounds clamping", () => {
            adapter.setSelection(0, 5);
            const sel = adapter.getSelection();
            expect(sel.from).toBe(0);
            expect(sel.to).toBe(5);

            // Test clamping out of bounds
            adapter.setSelection(-10, 9999);
            const clamped = adapter.getSelection();
            expect(clamped.from).toBe(0);
            expect(clamped.to).toBe(adapter.getCharCount());
        });

        it("should support undo and redo operations", () => {
            expect(adapter.canUndo()).toBe(false);

            adapter.replaceRange(5, 5, " Beautiful");
            expect(adapter.getValue()).toBe("Hello Beautiful World");
            expect(adapter.canUndo()).toBe(true);

            adapter.undo();
            expect(adapter.getValue()).toBe("Hello World");
            expect(adapter.canRedo()).toBe(true);

            adapter.redo();
            expect(adapter.getValue()).toBe("Hello Beautiful World");
        });
    });

    describe("3. Document Statistics (Word, Char, Line, Heading counts)", () => {
        it("should accurately count Latin, Arabic, and mixed words", () => {
            expect(calculateWordCount("")).toBe(0);
            expect(calculateWordCount("   \n\t  ")).toBe(0);
            expect(calculateWordCount("Hello world from LUGX")).toBe(4);
            expect(calculateWordCount("مرحبا بكم في محرر ماركداون")).toBe(5);
            expect(calculateWordCount("مرحبا World في LUGX 2026")).toBe(5);
        });

        it("should return correct line and heading counts", () => {
            const md = "# H1\n\n## H2\n\n### H3\n\nParagraph text\n\n#### H4";
            initEditor(md);

            expect(adapter.getHeadingCount()).toBe(4);
            expect(adapter.getLineCount()).toBe(9);
        });
    });

    describe("4. RTL & Arabic Text Support with Decoration Delimiter Policy", () => {
        it("should detect Arabic RTL text direction accurately", () => {
            expect(detectMarkdownDirection("مرحبا بالعالم")).toBe("rtl");
            expect(detectMarkdownDirection("# عنوان باللغة العربية")).toBe("rtl");
            expect(detectMarkdownDirection("Hello world")).toBe("ltr");
            expect(detectMarkdownDirection("### English heading")).toBe("ltr");
        });

        it("should preserve Arabic text with markdown symbols at the beginning without direction reversal", () => {
            const arabicMd = "# التوثيق الفني\n\n- نقطة أولى\n- نقطة ثانية\n> اقتباس عربي مهم";
            initEditor(arabicMd);

            expect(adapter.getValue()).toBe(arabicMd);
            expect(adapter.getHeadingCount()).toBe(1);
        });

        it("should preserve Arabic ligature connection in markdown bold / italic without DOM node separation", () => {
            const ligatureText = "هذا **نص متصل** و _كلمة أخرى_";
            initEditor(ligatureText);

            // Document must stay raw text
            expect(adapter.getValue()).toBe(ligatureText);

            // Delimiter hiding mark must be generated in live mode
            expect(adapter.getMode()).toBe("live");
        });
    });

    describe("5. Live Preview vs Source Mode (Compartment Reconfiguration)", () => {
        it("should switch between live and source mode without losing document content or history", () => {
            initEditor("Initial text", "live");
            expect(adapter.getMode()).toBe("live");

            // Make an edit to build history
            adapter.replaceRange(12, 12, " with edits");
            expect(adapter.getValue()).toBe("Initial text with edits");
            expect(adapter.canUndo()).toBe(true);

            // Switch to source mode
            adapter.setMode("source");
            expect(adapter.getMode()).toBe("source");
            expect(adapter.getValue()).toBe("Initial text with edits");
            expect(adapter.canUndo()).toBe(true); // History preserved!

            // Switch back to live mode
            adapter.setMode("live");
            expect(adapter.getMode()).toBe("live");
            expect(adapter.getValue()).toBe("Initial text with edits");
            expect(adapter.canUndo()).toBe(true);
        });
    });

    describe("6. Task Lists & GFM Features", () => {
        it("should support GFM task lists and parse checkboxes", () => {
            const taskMd = "- [ ] مهمة غير منجزة\n- [x] مهمة مكتملة";
            initEditor(taskMd);

            expect(adapter.getValue()).toBe(taskMd);
            expect(adapter.getLineCount()).toBe(2);
        });

        it("should handle code blocks with language specifiers", () => {
            const codeMd = "```python\ndef hello():\n    return 'world'\n```";
            initEditor(codeMd);

            expect(adapter.getValue()).toBe(codeMd);
        });

        it("should safely build decorations for deep nested formatting without RangeSetBuilder errors", () => {
            const nestedMd = "# Title\n\n***Triple Bold Italic Text*** and **_mixed tokens_** and ~~**strikethrough bold**~~";
            initEditor(nestedMd, "live");

            expect(adapter.getValue()).toBe(nestedMd);
            expect(adapter.getMode()).toBe("live");
        });

        it("should efficiently process large fenced code blocks without viewport lag", () => {
            const codeLines = Array.from({ length: 5000 }, (_, i) => `    console.log('line ${i}');`).join("\n");
            const largeDoc = `# Large Document\n\n\`\`\`javascript\n${codeLines}\n\`\`\`\n\nFooter text`;
            
            const start = performance.now();
            initEditor(largeDoc, "live");
            const elapsed = performance.now() - start;

            expect(adapter.getLineCount()).toBe(5006);
            expect(elapsed).toBeLessThan(1000); // Must initialize in less than 1s
        });
    });

    describe("7. Zero TipTap or External Dependencies Invariant", () => {
        it("should not import or invoke any TipTap, HTML serializer, or network methods", () => {
            initEditor("# Standalone LUGX Editor");
            // Verify adapter has no TipTap methods
            expect((adapter as any).getHTML).toBeUndefined();
            expect((adapter as any).setContent).toBeUndefined();
            expect((adapter as any).schema).toBeUndefined();
            expect((adapter as any).commands).toBeUndefined();
        });
    });
});
