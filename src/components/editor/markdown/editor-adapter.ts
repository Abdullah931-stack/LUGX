import { EditorView } from "@codemirror/view";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorAdapter, EditorMode, EditorSelection } from "./types";
import { livePreviewPlugin, modeCompartment } from "./markdown-extensions";

/**
 * Word count helper that reliably handles Unicode, Arabic, and mixed text.
 */
export function calculateWordCount(text: string): number {
    if (!text || text.trim() === "") return 0;
    // Match sequences of non-whitespace characters
    const matches = text.trim().match(/[\p{L}\p{N}\p{M}_-]+/gu);
    return matches ? matches.length : 0;
}

/**
 * CodeMirror 6 Editor Adapter implementation
 */
export class CodeMirrorEditorAdapter implements EditorAdapter {
    private currentMode: EditorMode = "live";

    constructor(
        private view: EditorView,
        initialMode: EditorMode = "live"
    ) {
        this.currentMode = initialMode;
    }

    /**
     * Get underlying EditorView instance (internal use only)
     */
    getEditorView(): EditorView {
        return this.view;
    }

    getValue(): string {
        return this.view.state.doc.toString();
    }

    setValue(content: string, origin?: string): void {
        const currentLength = this.view.state.doc.length;
        this.view.dispatch({
            changes: { from: 0, to: currentLength, insert: content },
            userEvent: origin || "set",
        });
    }

    getSelection(): EditorSelection {
        const main = this.view.state.selection.main;
        return {
            from: main.from,
            to: main.to,
        };
    }

    setSelection(from: number, to?: number): void {
        const docLength = this.view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(from, docLength));
        const safeTo = to !== undefined ? Math.max(0, Math.min(to, docLength)) : safeFrom;

        this.view.dispatch({
            selection: { anchor: safeFrom, head: safeTo },
            scrollIntoView: true,
        });
    }

    replaceRange(from: number, to: number, insert: string): void {
        const docLength = this.view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(from, docLength));
        const safeTo = Math.max(safeFrom, Math.min(to, docLength));

        this.view.dispatch({
            changes: { from: safeFrom, to: safeTo, insert },
            userEvent: "input",
        });
    }

    focus(): void {
        this.view.focus();
    }

    blur(): void {
        this.view.contentDOM.blur();
    }

    hasFocus(): boolean {
        return this.view.hasFocus;
    }

    undo(): boolean {
        return undo({
            state: this.view.state,
            dispatch: this.view.dispatch,
        });
    }

    redo(): boolean {
        return redo({
            state: this.view.state,
            dispatch: this.view.dispatch,
        });
    }

    canUndo(): boolean {
        return undoDepth(this.view.state) > 0;
    }

    canRedo(): boolean {
        return redoDepth(this.view.state) > 0;
    }

    getWordCount(): number {
        return calculateWordCount(this.view.state.doc.toString());
    }

    getCharCount(): number {
        return this.view.state.doc.length;
    }

    getLineCount(): number {
        return this.view.state.doc.lines;
    }

    getHeadingCount(): number {
        let count = 0;
        const tree = syntaxTree(this.view.state);
        tree.iterate({
            enter(node) {
                if (node.name.startsWith("ATXHeading") || node.name.startsWith("SetextHeading")) {
                    count++;
                }
            },
        });
        return count;
    }

    getMode(): EditorMode {
        return this.currentMode;
    }

    setMode(mode: EditorMode): void {
        if (this.currentMode === mode) return;
        this.currentMode = mode;

        this.view.dispatch({
            effects: modeCompartment.reconfigure(mode === "live" ? [livePreviewPlugin] : []),
        });
    }

    destroy(): void {
        this.view.destroy();
    }
}

/**
 * Factory function to create an EditorAdapter from an EditorView
 */
export function createEditorAdapter(view: EditorView, initialMode: EditorMode = "live"): EditorAdapter {
    return new CodeMirrorEditorAdapter(view, initialMode);
}
