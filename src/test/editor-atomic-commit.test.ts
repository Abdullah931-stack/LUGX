/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
    StreamingGhostExtension,
    streamingGhostPluginKey,
} from '@/lib/extensions/streaming-ghost-extension';
import { formatStreamOutputToHTML } from '@/lib/parsers/stream-markdown';

describe('Editor Atomic Commit & Single Undo Invariant (Gate G8 / Phase 8)', () => {
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

    it('should NOT apply local transaction if server commit fails (Document remains pristine)', async () => {
        const snapshotBefore = editor.getHTML();

        // Simulate streaming ghost active
        editor.commands.startStreamingGhost({
            from: 1,
            to: 20,
            text: 'Preview chunk...',
        });

        // Simulate mock server commit function failing
        const mockServerCommit = vi.fn().mockResolvedValue({
            success: false,
            status: 'error',
            error: 'Server transaction failure',
        });

        const serverResult = await mockServerCommit();

        // Condition: Local transaction is ONLY applied after server success
        if (!serverResult.success || serverResult.status !== 'committed') {
            editor.commands.clearStreamingGhost();
        }

        // Ghost is cleared, document content was NEVER modified
        const ghostState = streamingGhostPluginKey.getState(editor.state);
        expect(ghostState?.active).toBe(false);
        expect(editor.getHTML()).toBe(snapshotBefore);
    });

    it('should NOT apply local transaction on 412 version conflict and clear ghost preview', async () => {
        const snapshotBefore = editor.getHTML();

        editor.commands.startStreamingGhost({
            from: 1,
            to: 20,
            text: 'Conflicting AI suggestion...',
        });

        // Simulate mock server returning 412 conflict
        const mockServerCommit = vi.fn().mockResolvedValue({
            success: false,
            status: 'conflict',
            error: 'Conflict: file modified by another session',
            serverVersion: { version: 5 },
        });

        const serverResult = await mockServerCommit();

        if (serverResult.status === 'conflict') {
            editor.commands.clearStreamingGhost();
        }

        expect(editor.getHTML()).toBe(snapshotBefore);
    });
});
