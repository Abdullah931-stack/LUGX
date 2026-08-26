import { Compartment, Extension, RangeSetBuilder, EditorState } from "@codemirror/state";
import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
    placeholder as cmPlaceholder,
    keymap,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
    defaultKeymap,
    history,
    historyKeymap,
    standardKeymap,
    indentWithTab,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { GFM } from "@lezer/markdown";
import { EditorMode } from "./types";
import { markdownThemeExtension } from "./markdown-theme";
import { codeMirrorStreamingGhostField } from "@/lib/extensions/streaming-ghost-extension";

// Compartments for dynamic reconfiguration without state recreation
export const modeCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const placeholderCompartment = new Compartment();
export const directionCompartment = new Compartment();

/**
 * Interactive Task Checkbox Widget
 * Safely dispatches a surgical change transaction when clicked.
 */
class TaskCheckboxWidget extends WidgetType {
    constructor(
        readonly checked: boolean,
        readonly markerPos: number
    ) {
        super();
    }

    eq(other: TaskCheckboxWidget) {
        return this.checked === other.checked && this.markerPos === other.markerPos;
    }

    toDOM(view: EditorView): HTMLElement {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = this.checked;
        input.className = "cm-md-task-checkbox";
        input.setAttribute("aria-label", "Markdown task checkbox");

        input.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const from = this.markerPos;
            const docText = view.state.doc.sliceString(from, from + 3);
            if (docText === "[ ]" || docText === "[x]" || docText === "[X]") {
                const nextMarker = this.checked ? "[ ]" : "[x]";
                view.dispatch({
                    changes: { from, to: from + 3, insert: nextMarker },
                    userEvent: "input",
                });
            }
        });

        return input;
    }

    ignoreEvent(): boolean {
        return false;
    }
}

/**
 * Pre-defined decoration marks and line styling
 */
const marks = {
    bold: Decoration.mark({ class: "cm-md-bold" }),
    italic: Decoration.mark({ class: "cm-md-italic" }),
    strikethrough: Decoration.mark({ class: "cm-md-strikethrough" }),
    codeInline: Decoration.mark({ class: "cm-md-code-inline" }),
    linkText: Decoration.mark({ class: "cm-md-link" }),
    delimiterHidden: Decoration.mark({ class: "cm-md-delimiter-hidden" }),
    delimiterVisible: Decoration.mark({ class: "cm-md-delimiter-visible" }),
};

const lineDecorations = {
    h1: Decoration.line({ class: "cm-md-header-1" }),
    h2: Decoration.line({ class: "cm-md-header-2" }),
    h3: Decoration.line({ class: "cm-md-header-3" }),
    h4: Decoration.line({ class: "cm-md-header-4" }),
    h5: Decoration.line({ class: "cm-md-header-5" }),
    h6: Decoration.line({ class: "cm-md-header-6" }),
    codeBlock: Decoration.line({ class: "cm-md-code-block" }),
    blockquote: Decoration.line({ class: "cm-md-blockquote" }),
    hr: Decoration.line({ class: "cm-md-hr" }),
};

/**
 * Check if the current cursor or any selection range intersects the given offset range
 */
function isCursorInside(selection: EditorState["selection"], from: number, to: number): boolean {
    for (const range of selection.ranges) {
        // Expand slightly (+1 / -1) to prevent premature delimiter hiding while typing adjacent characters
        if (range.from <= to && range.to >= from) {
            return true;
        }
    }
    return false;
}

/**
 * Build decorations set from the Lezer Markdown syntax tree
 */
function buildMarkdownDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const tree = syntaxTree(view.state);
    const selection = view.state.selection;
    const doc = view.state.doc;

    // Track line decorations to prevent applying multiple line decorations to the same line
    const decoratedLines = new Set<number>();

    // Store decorations to add in ascending order
    interface PendingDeco {
        from: number;
        to: number;
        deco: Decoration;
        isLine?: boolean;
    }
    const pending: PendingDeco[] = [];

    // Traverse the syntax tree
    for (const { from, to } of view.visibleRanges) {
        tree.iterate({
            from,
            to,
            enter(node) {
                const name = node.name;
                const nodeFrom = node.from;
                const nodeTo = node.to;

                // 1. Headings (ATXHeading1 to ATXHeading6, SetextHeading1, SetextHeading2)
                if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
                    const line = doc.lineAt(nodeFrom);
                    if (!decoratedLines.has(line.from)) {
                        let headerDeco = lineDecorations.h1;
                        if (name.endsWith("2")) headerDeco = lineDecorations.h2;
                        else if (name.endsWith("3")) headerDeco = lineDecorations.h3;
                        else if (name.endsWith("4")) headerDeco = lineDecorations.h4;
                        else if (name.endsWith("5")) headerDeco = lineDecorations.h5;
                        else if (name.endsWith("6")) headerDeco = lineDecorations.h6;

                        pending.push({ from: line.from, to: line.from, deco: headerDeco, isLine: true });
                        decoratedLines.add(line.from);
                    }
                }

                // HeaderMark (#, ##, etc.)
                if (name === "HeaderMark") {
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo + 1);
                    if (!cursorTouching) {
                        pending.push({ from: nodeFrom, to: nodeTo, deco: marks.delimiterHidden });
                    } else {
                        pending.push({ from: nodeFrom, to: nodeTo, deco: marks.delimiterVisible });
                    }
                }

                // 2. Bold / StrongEmphasis
                if (name === "StrongEmphasis") {
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo);
                    pending.push({ from: nodeFrom, to: nodeTo, deco: marks.bold });

                    // Find delimiter tokens inside StrongEmphasis
                    // Standard Markdown bold delimiters are 2 chars: ** or __
                    if (!cursorTouching && nodeTo - nodeFrom >= 4) {
                        pending.push({ from: nodeFrom, to: nodeFrom + 2, deco: marks.delimiterHidden });
                        pending.push({ from: nodeTo - 2, to: nodeTo, deco: marks.delimiterHidden });
                    }
                }

                // 3. Italic / Emphasis
                if (name === "Emphasis") {
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo);
                    pending.push({ from: nodeFrom, to: nodeTo, deco: marks.italic });

                    // Standard Markdown italic delimiters are 1 char: * or _
                    if (!cursorTouching && nodeTo - nodeFrom >= 2) {
                        pending.push({ from: nodeFrom, to: nodeFrom + 1, deco: marks.delimiterHidden });
                        pending.push({ from: nodeTo - 1, to: nodeTo, deco: marks.delimiterHidden });
                    }
                }

                // 4. Strikethrough
                if (name === "Strikethrough") {
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo);
                    pending.push({ from: nodeFrom, to: nodeTo, deco: marks.strikethrough });

                    if (!cursorTouching && nodeTo - nodeFrom >= 4) {
                        pending.push({ from: nodeFrom, to: nodeFrom + 2, deco: marks.delimiterHidden });
                        pending.push({ from: nodeTo - 2, to: nodeTo, deco: marks.delimiterHidden });
                    }
                }

                // 5. Inline Code
                if (name === "InlineCode") {
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo);
                    pending.push({ from: nodeFrom, to: nodeTo, deco: marks.codeInline });

                    if (!cursorTouching && nodeTo - nodeFrom >= 2) {
                        pending.push({ from: nodeFrom, to: nodeFrom + 1, deco: marks.delimiterHidden });
                        pending.push({ from: nodeTo - 1, to: nodeTo, deco: marks.delimiterHidden });
                    }
                }

                // 6. Fenced Code Block
                if (name === "FencedCode") {
                    const startLine = doc.lineAt(nodeFrom).number;
                    const endLine = doc.lineAt(nodeTo).number;
                    const visibleStart = Math.max(startLine, doc.lineAt(from).number);
                    const visibleEnd = Math.min(endLine, doc.lineAt(to).number);
                    for (let l = visibleStart; l <= visibleEnd; l++) {
                        const line = doc.line(l);
                        if (!decoratedLines.has(line.from)) {
                            pending.push({ from: line.from, to: line.from, deco: lineDecorations.codeBlock, isLine: true });
                            decoratedLines.add(line.from);
                        }
                    }
                }

                // 7. Blockquote
                if (name === "Blockquote") {
                    const startLine = doc.lineAt(nodeFrom).number;
                    const endLine = doc.lineAt(nodeTo).number;
                    const visibleStart = Math.max(startLine, doc.lineAt(from).number);
                    const visibleEnd = Math.min(endLine, doc.lineAt(to).number);
                    for (let l = visibleStart; l <= visibleEnd; l++) {
                        const line = doc.line(l);
                        if (!decoratedLines.has(line.from)) {
                            pending.push({ from: line.from, to: line.from, deco: lineDecorations.blockquote, isLine: true });
                            decoratedLines.add(line.from);
                        }
                    }
                }

                // 8. Task Markers ([ ] or [x])
                if (name === "TaskMarker") {
                    const text = doc.sliceString(nodeFrom, nodeTo);
                    const isChecked = text.toLowerCase().includes("x");
                    const cursorTouching = isCursorInside(selection, nodeFrom, nodeTo);

                    // Insert interactive checkbox widget
                    const widgetDeco = Decoration.widget({
                        widget: new TaskCheckboxWidget(isChecked, nodeFrom),
                        side: -1,
                    });
                    pending.push({ from: nodeFrom, to: nodeFrom, deco: widgetDeco });

                    if (!cursorTouching) {
                        pending.push({ from: nodeFrom, to: nodeTo, deco: marks.delimiterHidden });
                    }
                }

                // 9. Links [text](url)
                if (name === "Link") {
                    pending.push({ from: nodeFrom, to: nodeTo, deco: marks.linkText });
                }

                // 10. Horizontal Rule
                if (name === "HorizontalRule") {
                    const line = doc.lineAt(nodeFrom);
                    if (!decoratedLines.has(line.from)) {
                        pending.push({ from: line.from, to: line.from, deco: lineDecorations.hr, isLine: true });
                        decoratedLines.add(line.from);
                    }
                }
            },
        });
    }

    // Sort pending decorations by 'from' ascending:
    // 1. Line decorations come first at the same position.
    // 2. Point/Widget decorations sorted by startSide.
    // 3. For range/mark decorations starting at the same 'from', larger ranges ('to' descending) come first.
    pending.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        if (a.isLine && !b.isLine) return -1;
        if (!a.isLine && b.isLine) return 1;
        const sideA = (a.deco as any).startSide ?? 0;
        const sideB = (b.deco as any).startSide ?? 0;
        if (sideA !== sideB) return sideA - sideB;
        return b.to - a.to;
    });

    for (const item of pending) {
        if (item.isLine) {
            builder.add(item.from, item.from, item.deco);
        } else if (item.from <= item.to) {
            builder.add(item.from, item.to, item.deco);
        }
    }

    return builder.finish();
}

/**
 * Live Preview ViewPlugin
 * Responsible for computing and rendering live decorations while preserving raw Markdown state.
 */
export const livePreviewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = buildMarkdownDecorations(view);
        }

        update(update: ViewUpdate) {
            // IME Composition Guard:
            // When user is typing with an IME, never recalculate decorations to avoid breaking composition state
            if (update.view.composing) {
                return;
            }

            if (
                update.docChanged ||
                update.selectionSet ||
                update.viewportChanged
            ) {
                this.decorations = buildMarkdownDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations,
    }
);

/**
 * Detect text direction helper
 */
export function detectMarkdownDirection(content: string): "rtl" | "ltr" {
    const rtlRegex = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    const ltrRegex = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02B8]/;

    // Scan the first few non-markdown characters
    const cleanText = content.replace(/[#*`_~>[\]()\-+0-9.]/g, "").trim();
    for (const char of cleanText) {
        if (rtlRegex.test(char)) return "rtl";
        if (ltrRegex.test(char)) return "ltr";
    }
    return "ltr";
}

/**
 * Configuration options for assembling all CodeMirror extensions
 */
export interface EditorExtensionOptions {
    mode?: EditorMode;
    placeholder?: string;
    readOnly?: boolean;
    dir?: "auto" | "rtl" | "ltr";
    onUpdate?: (update: ViewUpdate) => void;
}

/**
 * Create full CodeMirror 6 extension set for Markdown editor
 */
export function createMarkdownExtensions(options: EditorExtensionOptions = {}): Extension[] {
    const initialMode = options.mode ?? "live";
    const initialReadOnly = options.readOnly ?? false;
    const initialPlaceholder = options.placeholder ?? "Start writing in Markdown...";
    const initialDir = options.dir ?? "auto";

    return [
        // 1. Markdown Language with GFM
        markdown({
            base: markdownLanguage,
            extensions: [GFM],
        }),

        // 2. Bidi & Direction Support
        directionCompartment.of(
            initialDir === "rtl"
                ? EditorView.contentAttributes.of({ dir: "rtl" })
                : initialDir === "ltr"
                  ? EditorView.contentAttributes.of({ dir: "ltr" })
                  : EditorView.contentAttributes.of({ dir: "auto" })
        ),

        // 3. Theme & Styling
        markdownThemeExtension,
        highlightSelectionMatches(),

        // 4. Mode Compartment (Live Preview vs Source Mode)
        modeCompartment.of(initialMode === "live" ? [livePreviewPlugin] : []),

        // 5. Read-Only Compartment
        readOnlyCompartment.of(EditorState.readOnly.of(initialReadOnly)),

        // 6. Placeholder Compartment
        placeholderCompartment.of(cmPlaceholder(initialPlaceholder)),

        // 7. History & Keymaps
        history(),
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...standardKeymap,
            indentWithTab,
        ]),

        // 8. Line Wrapping
        EditorView.lineWrapping,

        // 9. Streaming Ghost Extension (Dynamic AI Preview Layer)
        codeMirrorStreamingGhostField,

        // 10. Update Listener
        EditorView.updateListener.of((update) => {
            if (options.onUpdate) {
                options.onUpdate(update);
            }
        }),
    ];
}
