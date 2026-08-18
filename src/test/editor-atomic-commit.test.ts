/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { StreamingGhostExtension } from '@/lib/extensions/streaming-ghost-extension';
import { formatStreamOutputToHTML } from '@/lib/parsers/stream-markdown';

describe('Editor Atomic Commit & Single Undo Invariant (Gate G8)', () => {
    let editor: Editor;
    const initialContent = '<p>The quick brown fox jumps over the lazy dog.</p><p>Second paragraph untouched.</p>';

    beforeEach(() => {
        editor = new Editor({
            extensions: [StarterKit, StreamingGhostExtension],
            content: initialContent,
        });
    });

    it('should replace partial selection as a single undoable transaction', () => {
        const snapshotBefore = editor.getHTML();

        // Target: "The quick brown fox" -> range [1, 20]
        const selectionStart = 1;
        const selectionEnd = 20;

        const aiOutput = 'A fast auburn fox';
        const { html: safeHtml } = formatStreamOutputToHTML(aiOutput);

        // Execute atomic commit
        editor.chain()
            .setTextSelection({ from: selectionStart, to: selectionEnd })
            .deleteSelection()
            .insertContent(safeHtml)
            .run();

        // 1. Verify content modified
        expect(editor.getHTML()).toContain('A fast auburn fox');
        expect(editor.getHTML()).toContain('Second paragraph untouched.');

        // 2. Single Undo restores original document snapshot exactly
        const undoSuccess = editor.commands.undo();
        expect(undoSuccess).toBe(true);
        expect(editor.getHTML()).toBe(snapshotBefore);
    });

    it('should replace entire document with clean Markdown converted HTML and restore with single Ctrl+Z', () => {
        const snapshotBefore = editor.getHTML();
        const fullSize = editor.state.doc.content.size;

        const aiOutput = '# New Title\n\nFresh paragraph with **bold** text.';
        const { html: safeHtml } = formatStreamOutputToHTML(aiOutput);

        // Execute full document atomic commit
        editor.chain()
            .setTextSelection({ from: 0, to: fullSize })
            .deleteSelection()
            .insertContent(safeHtml)
            .run();

        expect(editor.getHTML()).toContain('<h1>New Title</h1>');
        expect(editor.getHTML()).toContain('<strong>bold</strong>');

        // Single Undo restores original document
        editor.commands.undo();
        expect(editor.getHTML()).toBe(snapshotBefore);
    });
});
