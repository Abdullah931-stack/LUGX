import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorAdapter, EditorMode, EditorSelection, DirectionSettings } from "./types";
import {
    livePreviewPlugin,
    modeCompartment,
    readOnlyCompartment,
    directionSettingsState,
    setDirectionSettingsEffect,
    directionCompartment,
    resolveDirectionExtension,
} from "./markdown-extensions";
import {
    startGhostEffect,
    updateGhostEffect,
    clearGhostEffect,
    codeMirrorStreamingGhostField,
    CMStreamingGhostOptions,
} from "./streaming-ghost";

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

    replaceRanges(changes: { from: number; to: number; insert: string }[]): void {
        if (!changes || changes.length === 0) return;
        const docLength = this.view.state.doc.length;
        const sorted = changes
            .map((c) => ({
                from: Math.max(0, Math.min(c.from, docLength)),
                to: Math.max(0, Math.min(c.to, docLength)),
                insert: c.insert,
            }))
            .sort((a, b) => a.from - b.from);

        // Defensive non-overlapping filter
        const validChanges: { from: number; to: number; insert: string }[] = [];
        let lastTo = -1;
        for (const c of sorted) {
            if (c.from >= lastTo) {
                validChanges.push(c);
                lastTo = c.to;
            }
        }

        if (validChanges.length === 0) return;

        this.view.dispatch({
            changes: validChanges,
            userEvent: "input",
        });
    }

    getSelectedText(): string {
        const { from, to } = this.getSelection();
        if (from === to) return "";
        return this.view.state.sliceDoc(from, to);
    }

    insertMarkdown(prefix: string, suffix: string = "", placeholder: string = ""): void {
        const { from, to } = this.getSelection();
        const isBlockPrefix =
            (prefix.startsWith("#") ||
                prefix.startsWith("- ") ||
                prefix.startsWith("1. ") ||
                prefix.startsWith("> ")) &&
            suffix === "";

        // Handle block-level formatting at line start
        if (isBlockPrefix) {
            const line = this.view.state.doc.lineAt(from);
            const lineText = line.text;
            if (!lineText.startsWith(prefix)) {
                this.view.dispatch({
                    changes: { from: line.from, to: line.from, insert: prefix },
                    userEvent: "input",
                    scrollIntoView: true,
                });
            }
            this.view.focus();
            return;
        }

        const hasSelection = from !== to;
        const selectedText = hasSelection ? this.view.state.sliceDoc(from, to) : "";
        const textToWrap = hasSelection ? selectedText : placeholder;
        const replacement = `${prefix}${textToWrap}${suffix}`;

        const newFrom = hasSelection ? from : from + prefix.length;
        const newTo = hasSelection ? from + replacement.length : newFrom + placeholder.length;

        this.view.dispatch({
            changes: { from, to, insert: replacement },
            selection: { anchor: newFrom, head: newTo },
            userEvent: "input",
            scrollIntoView: true,
        });
        this.view.focus();
    }

    setEditable(editable: boolean): void {
        this.view.dispatch({
            effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!editable)),
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

    getDirectionSettings(): DirectionSettings {
        return (
            this.view.state.field(directionSettingsState, false) ?? {
                mode: "auto",
                lockCodeBlocksLTR: true,
            }
        );
    }

    setDirectionSettings(settings: Partial<DirectionSettings>): void {
        const current = this.getDirectionSettings();
        const next: DirectionSettings = {
            mode: settings.mode ?? current.mode,
            lockCodeBlocksLTR: settings.lockCodeBlocksLTR ?? current.lockCodeBlocksLTR,
        };

        const effects = [
            setDirectionSettingsEffect.of(next),
            directionCompartment.reconfigure(resolveDirectionExtension(next.mode, this.view.state.doc.toString())),
        ];

        this.view.dispatch({ effects });
    }

    startStreamingGhost(options: CMStreamingGhostOptions): void {
        const docLength = this.view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(options.from, docLength));
        const safeTo = Math.max(safeFrom, Math.min(options.to, docLength));
        this.view.dispatch({
            effects: startGhostEffect.of({
                from: safeFrom,
                to: safeTo,
                text: options.text || "",
                operation: options.operation,
                isStreaming: options.isStreaming ?? true,
                onApply: options.onApply,
                onReject: options.onReject,
                onRetry: options.onRetry,
                onStop: options.onStop,
            }),
        });
    }

    updateStreamingGhost(text: string, isStreaming?: boolean): void {
        this.view.dispatch({
            effects: updateGhostEffect.of({ text, isStreaming }),
        });
    }

    clearStreamingGhost(): void {
        this.view.dispatch({
            effects: clearGhostEffect.of(),
        });
    }

    getGhostRange(): { from: number; to: number } | null {
        const ghostState = this.view.state.field(codeMirrorStreamingGhostField, false);
        if (!ghostState || !ghostState.active) return null;
        return {
            from: ghostState.from,
            to: ghostState.to,
        };
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
