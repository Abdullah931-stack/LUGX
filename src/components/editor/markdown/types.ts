/**
 * Standalone Markdown Editor Types & Contracts
 * Strict UTF-8 Raw Markdown source of truth with zero HTML serialization.
 */

export type EditorMode = "live" | "source";

export interface EditorSelection {
    from: number;
    to: number;
}

export interface EditorSnapshot {
    content: string;
    selection: EditorSelection;
    generation: number;
    isDirty: boolean;
}

/**
 * EditorAdapter interface
 * Provides an engine-agnostic abstraction over CodeMirror 6.
 * All callers in the app interact with this contract rather than CM6 directly.
 */
export interface EditorAdapter {
    /** Get current raw Markdown document content */
    getValue(): string;
    /** Replace whole document with new content and optional origin tag */
    setValue(content: string, origin?: string): void;
    /** Get primary cursor / selection range as UTF-16 code unit offsets */
    getSelection(): EditorSelection;
    /** Set primary cursor / selection range */
    setSelection(from: number, to?: number): void;
    /** Replace text in the specified range [from, to] */
    replaceRange(from: number, to: number, insert: string): void;
    /** Focus the editor */
    focus(): void;
    /** Blur the editor */
    blur(): void;
    /** Check if editor currently has focus */
    hasFocus(): boolean;
    /** Perform undo operation */
    undo(): boolean;
    /** Perform redo operation */
    redo(): boolean;
    /** Check if undo history is available */
    canUndo(): boolean;
    /** Check if redo history is available */
    canRedo(): boolean;
    /** Word count in the current document (Unicode/RTL-safe) */
    getWordCount(): number;
    /** Character count in the current document */
    getCharCount(): number;
    /** Line count in the current document */
    getLineCount(): number;
    /** Count of Markdown headings in document */
    getHeadingCount(): number;
    /** Get current rendering mode (live preview or raw source) */
    getMode(): EditorMode;
    /** Toggle rendering mode */
    setMode(mode: EditorMode): void;
    /** Destroy underlying editor instance */
    destroy(): void;
}

export interface MarkdownEditorProps {
    /** Controlled raw Markdown value */
    value?: string;
    /** Initial uncontrolled value */
    defaultValue?: string;
    /** Callback invoked whenever raw Markdown text changes */
    onChange?: (value: string) => void;
    /** Callback invoked whenever cursor selection changes */
    onSelectionChange?: (selection: EditorSelection) => void;
    /** Callback fired when EditorAdapter instance is initialized and ready */
    onAdapterReady?: (adapter: EditorAdapter) => void;
    /** Rendering mode: 'live' (decoration-based preview) or 'source' (raw text) */
    mode?: EditorMode;
    /** Mode change callback */
    onModeChange?: (mode: EditorMode) => void;
    /** Placeholder string displayed when document is empty */
    placeholder?: string;
    /** Read-only mode */
    readOnly?: boolean;
    /** Auto-focus on mount */
    autoFocus?: boolean;
    /** Additional CSS class for the container */
    className?: string;
    /** Base text direction: 'auto' | 'rtl' | 'ltr' */
    dir?: "auto" | "rtl" | "ltr";
}
