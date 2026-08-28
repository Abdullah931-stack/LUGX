import { Compartment, Extension, RangeSetBuilder, EditorState, StateField, StateEffect, Prec } from "@codemirror/state";
import {
    EditorView,
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate,
    WidgetType,
    placeholder as cmPlaceholder,
    keymap,
    KeyBinding,
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
import { EditorMode, TextDirectionMode, DirectionSettings } from "./types";
import { markdownThemeExtension } from "./markdown-theme";
import { codeMirrorStreamingGhostField } from "./streaming-ghost";

// Compartments for dynamic reconfiguration without state recreation
export const modeCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const placeholderCompartment = new Compartment();
export const directionCompartment = new Compartment();

/**
 * State Effect for dynamically updating text direction settings
 */
export const setDirectionSettingsEffect = StateEffect.define<DirectionSettings>();

/**
 * StateField tracking active DirectionSettings
 */
export const directionSettingsState = StateField.define<DirectionSettings>({
    create() {
        return {
            mode: "auto",
            lockCodeBlocksLTR: true,
        };
    },
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setDirectionSettingsEffect)) {
                return effect.value;
            }
        }
        return value;
    },
});

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

        const isReadOnly = Boolean(view.state.facet(EditorState.readOnly));
        if (isReadOnly) {
            input.disabled = true;
        }

        input.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (view.state.facet(EditorState.readOnly)) {
                return;
            }

            const from = this.markerPos;
            const docLength = view.state.doc.length;
            if (from + 3 > docLength) return;

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

// Line-level bidi decorations cache
const bidiLineDecorations = {
    auto: Decoration.line({ attributes: { dir: "auto" } }),
    rtl: Decoration.line({ attributes: { dir: "rtl" }, class: "cm-bidi-rtl" }),
    ltr: Decoration.line({ attributes: { dir: "ltr" }, class: "cm-bidi-ltr" }),
    codeLTR: Decoration.line({ attributes: { dir: "ltr" }, class: "cm-bidi-ltr" }),
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
    const docLen = doc.length;

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
        const safeVisibleFrom = Math.min(Math.max(0, from), docLen);
        const safeVisibleTo = Math.min(Math.max(safeVisibleFrom, to), docLen);

        tree.iterate({
            from: safeVisibleFrom,
            to: safeVisibleTo,
            enter(node) {
                const name = node.name;
                const nodeFrom = Math.min(Math.max(0, node.from), docLen);
                const nodeTo = Math.min(Math.max(nodeFrom, node.to), docLen);

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
                    const line = doc.lineAt(nodeFrom);
                    const cursorTouching = isCursorInside(selection, line.from, line.to);
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
                    const visibleStart = Math.max(startLine, doc.lineAt(safeVisibleFrom).number);
                    const visibleEnd = Math.min(endLine, doc.lineAt(safeVisibleTo).number);
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
                    const visibleStart = Math.max(startLine, doc.lineAt(safeVisibleFrom).number);
                    const visibleEnd = Math.min(endLine, doc.lineAt(safeVisibleTo).number);
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
        const sideA = (a.deco as unknown as { startSide?: number }).startSide ?? 0;
        const sideB = (b.deco as unknown as { startSide?: number }).startSide ?? 0;
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
 * Build line-level direction decorations to ensure robust bidi isolation
 * that is immune to CodeMirror 6 viewport virtualization.
 */
function buildBidiLineDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    const settings = view.state.field(directionSettingsState, false) ?? {
        mode: "auto" as TextDirectionMode,
        lockCodeBlocksLTR: true,
    };
    const { mode, lockCodeBlocksLTR } = settings;

    // Collect fenced code line ranges if code block LTR locking is enabled
    const fencedLines = new Set<number>();
    const docLen = doc.length;
    if (lockCodeBlocksLTR) {
        const tree = syntaxTree(view.state);
        for (const { from, to } of view.visibleRanges) {
            const safeVisibleFrom = Math.min(Math.max(0, from), docLen);
            const safeVisibleTo = Math.min(Math.max(safeVisibleFrom, to), docLen);

            tree.iterate({
                from: safeVisibleFrom,
                to: safeVisibleTo,
                enter(node) {
                    if (node.name === "FencedCode") {
                        const nodeFrom = Math.min(Math.max(0, node.from), docLen);
                        const nodeTo = Math.min(Math.max(nodeFrom, node.to), docLen);
                        const startLine = doc.lineAt(nodeFrom).number;
                        const endLine = doc.lineAt(nodeTo).number;
                        const visibleStart = Math.max(startLine, doc.lineAt(safeVisibleFrom).number);
                        const visibleEnd = Math.min(endLine, doc.lineAt(safeVisibleTo).number);
                        for (let l = visibleStart; l <= visibleEnd; l++) {
                            fencedLines.add(doc.line(l).from);
                        }
                    }
                },
            });
        }
    }

    const processedLines = new Set<number>();

    for (const { from, to } of view.visibleRanges) {
        const safeVisibleFrom = Math.min(Math.max(0, from), docLen);
        const safeVisibleTo = Math.min(Math.max(safeVisibleFrom, to), docLen);
        const startLine = doc.lineAt(safeVisibleFrom).number;
        const endLine = doc.lineAt(safeVisibleTo).number;

        for (let l = startLine; l <= endLine; l++) {
            const line = doc.line(l);
            if (processedLines.has(line.from)) continue;
            processedLines.add(line.from);

            let deco = bidiLineDecorations.auto;
            if (lockCodeBlocksLTR && fencedLines.has(line.from)) {
                deco = bidiLineDecorations.codeLTR;
            } else if (mode === "rtl") {
                deco = bidiLineDecorations.rtl;
            } else if (mode === "ltr") {
                deco = bidiLineDecorations.ltr;
            } else {
                deco = bidiLineDecorations.auto;
            }

            builder.add(line.from, line.from, deco);
        }
    }

    return builder.finish();
}

/**
 * Line-level Bidi Isolation ViewPlugin
 * Active in both Live Preview and Source modes to ensure line directions are never lost on scroll.
 */
export const bidiLinePlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
            this.decorations = buildBidiLineDecorations(view);
        }

        update(update: ViewUpdate) {
            if (update.view.composing) {
                return;
            }

            const settingsChanged =
                update.transactions.some((tr) => tr.effects.some((e) => e.is(setDirectionSettingsEffect))) ||
                update.startState.field(directionSettingsState, false) !==
                    update.state.field(directionSettingsState, false);

            if (
                update.docChanged ||
                update.viewportChanged ||
                settingsChanged
            ) {
                this.decorations = buildBidiLineDecorations(update.view);
            }
        }
    },
    {
        decorations: (v) => v.decorations,
    }
);

/**
 * Detect text direction helper
 * Scans leading characters to determine if text is primarily RTL or LTR
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
    return "rtl"; // Default to RTL for empty/neutral markdown in bilingual context
}

/**
 * Resolve stable EditorView.contentAttributes extension from direction mode and document text
 */
export function resolveDirectionExtension(mode: TextDirectionMode, docString?: string): Extension {
    if (mode === "rtl") {
        return EditorView.contentAttributes.of({ dir: "rtl" });
    }
    if (mode === "ltr") {
        return EditorView.contentAttributes.of({ dir: "ltr" });
    }
    // "auto" mode: compute stable document base direction from in-memory doc (not virtualized DOM)
    const baseDir = docString ? detectMarkdownDirection(docString.slice(0, 2000)) : "rtl";
    return EditorView.contentAttributes.of({ dir: baseDir });
}

function performToggleDirection(view: EditorView, onToggle?: (newMode: TextDirectionMode) => void): boolean {
    const current = view.state.field(directionSettingsState, false) ?? {
        mode: "auto" as TextDirectionMode,
        lockCodeBlocksLTR: true,
    };
    const nextMode: TextDirectionMode =
        current.mode === "auto" ? "rtl" : current.mode === "rtl" ? "ltr" : "auto";

    const nextSettings: DirectionSettings = {
        ...current,
        mode: nextMode,
    };

    view.dispatch({
        effects: [
            setDirectionSettingsEffect.of(nextSettings),
            directionCompartment.reconfigure(resolveDirectionExtension(nextMode, view.state.doc.toString())),
        ],
    });

    if (onToggle) {
        onToggle(nextMode);
    }
    return true;
}

/**
 * Direction Toggle Keybinding
 * Cycles through auto -> rtl -> ltr -> auto
 */
export const toggleDirectionKeymap = (onToggle?: (newMode: TextDirectionMode) => void): KeyBinding[] => [
    {
        key: "Mod-Alt-d",
        run: (view: EditorView) => performToggleDirection(view, onToggle),
    },
    {
        key: "Mod-Alt-D",
        run: (view: EditorView) => performToggleDirection(view, onToggle),
    },
];

/**
 * Configuration options for assembling all CodeMirror extensions
 */
export interface EditorExtensionOptions {
    mode?: EditorMode;
    placeholder?: string;
    readOnly?: boolean;
    dir?: TextDirectionMode;
    lockCodeBlocksLTR?: boolean;
    initialDoc?: string;
    onDirectionChange?: (settings: DirectionSettings) => void;
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
    const initialLockCodeBlocks = options.lockCodeBlocksLTR ?? true;
    const initialDoc = options.initialDoc ?? "";

    const initialSettings: DirectionSettings = {
        mode: initialDir,
        lockCodeBlocksLTR: initialLockCodeBlocks,
    };

    return [
        // 1. Markdown Language with GFM
        markdown({
            base: markdownLanguage,
            extensions: [GFM],
        }),

        // 2. Direction State & Line-Level Bidi Isolation Plugin (Always Active)
        directionSettingsState.init(() => initialSettings),
        bidiLinePlugin,

        // 3. Stable Document Direction Compartment (No DOM virtualization jumping)
        directionCompartment.of(resolveDirectionExtension(initialDir, initialDoc)),

        // 4. Theme & Styling
        markdownThemeExtension,
        highlightSelectionMatches(),

        // 5. Mode Compartment (Live Preview vs Source Mode)
        modeCompartment.of(initialMode === "live" ? [livePreviewPlugin] : []),

        // 6. Read-Only Compartment
        readOnlyCompartment.of(EditorState.readOnly.of(initialReadOnly)),

        // 7. Placeholder Compartment
        placeholderCompartment.of(cmPlaceholder(initialPlaceholder)),

        // 8. Highest Priority Direction Keymap
        Prec.highest(
            keymap.of(
                toggleDirectionKeymap((newMode) => {
                    if (options.onDirectionChange) {
                        options.onDirectionChange({
                            mode: newMode,
                            lockCodeBlocksLTR: initialLockCodeBlocks,
                        });
                    }
                })
            )
        ),

        // 9. Standard History & Keymaps
        history(),
        keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...standardKeymap,
            indentWithTab,
        ]),

        // 10. Line Wrapping
        EditorView.lineWrapping,

        // 11. Streaming Ghost Extension (Dynamic AI Preview Layer)
        codeMirrorStreamingGhostField,

        // 12. Update Listener
        EditorView.updateListener.of((update) => {
            if (options.onUpdate) {
                options.onUpdate(update);
            }
        }),
    ];
}
