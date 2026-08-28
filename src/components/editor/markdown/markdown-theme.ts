import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * LUGX Dark Theme for CodeMirror 6 Markdown Editor
 * High-contrast, sleek modern dark styling with full RTL and typography support.
 */
export const markdownDarkTheme = EditorView.theme(
    {
        "&": {
            color: "#e4e4e7",
            backgroundColor: "transparent",
            fontFamily: "var(--font-ibm-plex-arabic), var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
            fontWeight: "400",
            fontSynthesis: "none",
            WebkitFontSmoothing: "antialiased",
            MozOsxFontSmoothing: "grayscale",
            fontSize: "1rem",
            lineHeight: "1.75",
            outline: "none",
            height: "100%",
        },
        ".cm-content": {
            caretColor: "#818cf8",
            fontFamily: "inherit",
            fontWeight: "400",
            padding: "1.5rem 1rem",
            minHeight: "350px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
        },
        ".cm-line": {
            padding: "0 0.25rem",
            fontWeight: "400",
        },
        "&.cm-focused": {
            outline: "none",
        },
        ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "#818cf8",
            borderLeftWidth: "2px",
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
            backgroundColor: "rgba(99, 102, 241, 0.35) !important",
        },
        ".cm-activeLine": {
            backgroundColor: "rgba(255, 255, 255, 0.02)",
        },
        ".cm-placeholder": {
            color: "#71717a !important",
            fontStyle: "normal",
            pointerEvents: "none",
        },
        // Markdown specific formatting styles
        ".cm-md-bold": {
            fontWeight: "700",
            color: "#f4f4f5",
        },
        ".cm-md-italic": {
            fontStyle: "italic",
            color: "#e4e4e7",
        },
        ".cm-md-strikethrough": {
            textDecoration: "line-through",
            color: "#a1a1aa",
        },
        ".cm-md-header-1": {
            fontSize: "1.875rem",
            fontWeight: "800",
            lineHeight: "2.25rem",
            color: "#ffffff",
        },
        ".cm-md-header-2": {
            fontSize: "1.5rem",
            fontWeight: "700",
            lineHeight: "2rem",
            color: "#f4f4f5",
        },
        ".cm-md-header-3": {
            fontSize: "1.25rem",
            fontWeight: "600",
            lineHeight: "1.75rem",
            color: "#e4e4e7",
        },
        ".cm-md-header-4": {
            fontSize: "1.125rem",
            fontWeight: "600",
            lineHeight: "1.5rem",
            color: "#e4e4e7",
        },
        ".cm-md-header-5": {
            fontSize: "1rem",
            fontWeight: "600",
            lineHeight: "1.5rem",
            color: "#d4d4d8",
        },
        ".cm-md-header-6": {
            fontSize: "0.875rem",
            fontWeight: "600",
            lineHeight: "1.25rem",
            color: "#a1a1aa",
        },
        // Inline token delimiter hidden styling:
        // Uses opacity: 0 and font-size: 0 without DOM node replacement
        // to preserve Arabic cursive font shaping and eliminate caret jumping.
        ".cm-md-delimiter-hidden": {
            opacity: "0 !important",
            fontSize: "0px !important",
            letterSpacing: "-1ch !important",
            pointerEvents: "none !important",
            userSelect: "none !important",
            display: "inline",
        },
        ".cm-md-delimiter-visible": {
            opacity: "0.45",
            color: "#a1a1aa",
            fontWeight: "normal",
            fontStyle: "normal",
        },
        ".cm-md-code-inline": {
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: "0.875em",
            color: "#38bdf8",
            backgroundColor: "rgba(39, 39, 42, 0.8)",
            padding: "0.125rem 0.375rem",
            borderRadius: "0.25rem",
            border: "1px solid rgba(63, 63, 70, 0.5)",
        },
        ".cm-md-code-block": {
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            backgroundColor: "rgba(18, 18, 22, 0.95)",
            color: "#e4e4e7",
            unicodeBidi: "isolate",
            borderRadius: "0.375rem",
        },
        ".cm-bidi-ltr": {
            direction: "ltr",
            textAlign: "left",
            unicodeBidi: "isolate",
        },
        ".cm-bidi-rtl": {
            direction: "rtl",
            textAlign: "right",
            unicodeBidi: "isolate",
        },
        ".cm-md-blockquote": {
            borderLeft: "3px solid #6366f1",
            paddingLeft: "0.75rem",
            color: "#a1a1aa",
            fontStyle: "italic",
        },
        "[dir='rtl'] .cm-md-blockquote, .cm-rtl .cm-md-blockquote, .cm-line[dir='rtl'] .cm-md-blockquote, .cm-bidi-rtl.cm-md-blockquote": {
            borderLeft: "none",
            borderRight: "3px solid #6366f1",
            paddingLeft: "0",
            paddingRight: "0.75rem",
        },
        ".cm-md-link": {
            color: "#818cf8",
            textDecoration: "underline",
            textUnderlineOffset: "3px",
            cursor: "pointer",
        },
        ".cm-md-task-checkbox": {
            cursor: "pointer",
            accentColor: "#6366f1",
            verticalAlign: "middle",
            marginRight: "0.5rem",
        },
        "[dir='rtl'] .cm-md-task-checkbox, .cm-rtl .cm-md-task-checkbox, .cm-line[dir='rtl'] .cm-md-task-checkbox, .cm-bidi-rtl .cm-md-task-checkbox": {
            marginRight: "0",
            marginLeft: "0.5rem",
        },
        ".cm-md-hr": {
            borderBottom: "1px solid #3f3f46",
            display: "block",
            width: "100%",
            margin: "0.75rem 0",
        },
    },
    { dark: true }
);

/**
 * Syntax highlighting styles for code blocks and Markdown structures
 */
export const markdownHighlightStyle = HighlightStyle.define([
    { tag: t.heading1, color: "#ffffff", fontWeight: "800" },
    { tag: t.heading2, color: "#f4f4f5", fontWeight: "700" },
    { tag: t.heading3, color: "#e4e4e7", fontWeight: "600" },
    { tag: t.heading4, color: "#e4e4e7", fontWeight: "600" },
    { tag: t.heading5, color: "#d4d4d8", fontWeight: "600" },
    { tag: t.heading6, color: "#a1a1aa", fontWeight: "600" },
    { tag: t.emphasis, fontStyle: "italic", color: "#e4e4e7" },
    { tag: t.strong, fontWeight: "bold", color: "#f4f4f5" },
    { tag: t.strikethrough, textDecoration: "line-through", color: "#a1a1aa" },
    { tag: t.keyword, color: "#c084fc" },
    { tag: t.atom, color: "#f43f5e" },
    { tag: t.bool, color: "#fb923c" },
    { tag: t.url, color: "#818cf8", textDecoration: "underline" },
    { tag: t.link, color: "#818cf8" },
    { tag: t.labelName, color: "#38bdf8" },
    { tag: t.string, color: "#34d399" },
    { tag: t.number, color: "#fb923c" },
    { tag: t.comment, color: "#71717a", fontStyle: "italic" },
    { tag: t.monospace, color: "#38bdf8" },
    { tag: t.processingInstruction, color: "#a1a1aa" },
]);

export const markdownThemeExtension: Extension = [
    markdownDarkTheme,
    syntaxHighlighting(markdownHighlightStyle),
];
