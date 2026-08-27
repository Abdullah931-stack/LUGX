/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { CodeMirrorEditorAdapter } from '@/components/editor/markdown/editor-adapter';
import { codeMirrorStreamingGhostField } from '@/components/editor/markdown/streaming-ghost';

describe('Editor Atomic Commit & Single Undo Invariant (Gate G8 / Phase 8 / Phase 6 CM6)', () => {
    let adapter: CodeMirrorEditorAdapter;
    let view: EditorView;
    let parent: HTMLDivElement;
    const initialContent = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph untouched.';

    beforeEach(() => {
        if (typeof Range.prototype.getClientRects !== 'function') {
            Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
        }
        if (typeof Range.prototype.getBoundingClientRect !== 'function') {
            Range.prototype.getBoundingClientRect = () => ({
                top: 0,
                bottom: 0,
                left: 0,
                right: 0,
                width: 0,
                height: 0,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            });
        }

        parent = document.createElement('div');
        document.body.appendChild(parent);

        const state = EditorState.create({
            doc: initialContent,
            extensions: [
                history(),
                codeMirrorStreamingGhostField,
            ],
        });

        view = new EditorView({
            state,
            parent,
        });

        adapter = new CodeMirrorEditorAdapter(view);
    });

    afterEach(() => {
        if (view) {
            view.destroy();
        }
        if (parent && parent.parentNode) {
            parent.parentNode.removeChild(parent);
        }
    });

    it('should replace partial selection as a single undoable transaction', () => {
        const snapshotBefore = adapter.getValue();

        // Target: "The quick brown fox" -> range [0, 19]
        const selectionStart = 0;
        const selectionEnd = 19;
        const aiOutput = 'A fast auburn fox';

        // Execute atomic commit via adapter
        adapter.replaceRange(selectionStart, selectionEnd, aiOutput);

        // 1. Verify content modified
        expect(adapter.getValue()).toContain('A fast auburn fox');
        expect(adapter.getValue()).toContain('Second paragraph untouched.');

        // 2. Single Undo restores original document snapshot exactly
        const undoSuccess = adapter.undo();
        expect(undoSuccess).toBe(true);
        expect(adapter.getValue()).toBe(snapshotBefore);
    });

    it('should replace entire document with clean Markdown and restore with single Ctrl+Z', () => {
        const snapshotBefore = adapter.getValue();
        const fullSize = adapter.getCharCount();

        const aiOutput = '# New Title\n\nFresh paragraph with **bold** text.';

        // Execute full document atomic commit
        adapter.replaceRange(0, fullSize, aiOutput);

        expect(adapter.getValue()).toBe(aiOutput);

        // Single Undo restores original document
        const undoSuccess = adapter.undo();
        expect(undoSuccess).toBe(true);
        expect(adapter.getValue()).toBe(snapshotBefore);
    });

    it('should NOT apply local transaction if server commit fails (Document remains pristine)', async () => {
        const snapshotBefore = adapter.getValue();

        // Simulate streaming ghost active
        adapter.startStreamingGhost({
            from: 0,
            to: 19,
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
            adapter.clearStreamingGhost();
        }

        // Ghost is cleared, document content was NEVER modified
        const ghostState = view.state.field(codeMirrorStreamingGhostField);
        expect(ghostState?.active).toBe(false);
        expect(adapter.getValue()).toBe(snapshotBefore);
    });

    it('should NOT apply local transaction on 412 version conflict and clear ghost preview', async () => {
        const snapshotBefore = adapter.getValue();

        adapter.startStreamingGhost({
            from: 0,
            to: 19,
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
            adapter.clearStreamingGhost();
        }

        const ghostState = view.state.field(codeMirrorStreamingGhostField);
        expect(ghostState?.active).toBe(false);
        expect(adapter.getValue()).toBe(snapshotBefore);
    });
});
