import { describe, it, expect } from 'vitest';
import {
    createStreamSession,
    transitionSession,
    isValidTransition,
    assertSessionIntegrity,
    isTerminalStatus,
    AIStreamStatus,
} from '@/lib/ai/stream-session';
import { EphemeralPreviewBuffer } from '@/lib/ai/preview-buffer';

describe('AIStreamSession State Machine & Integrity Guards (Phase 7 / Gate G6 & G8)', () => {
    describe('FSM Transitions & Terminal States', () => {
        it('should correctly identify terminal session states', () => {
            expect(isTerminalStatus('committed')).toBe(true);
            expect(isTerminalStatus('aborted')).toBe(true);
            expect(isTerminalStatus('failed')).toBe(true);
            expect(isTerminalStatus('conflict')).toBe(true);
            expect(isTerminalStatus('rolled_back')).toBe(true);

            expect(isTerminalStatus('idle')).toBe(false);
            expect(isTerminalStatus('reserving')).toBe(false);
            expect(isTerminalStatus('reserved')).toBe(false);
            expect(isTerminalStatus('streaming')).toBe(false);
            expect(isTerminalStatus('preview_ready')).toBe(false);
            expect(isTerminalStatus('completed')).toBe(false);
            expect(isTerminalStatus('committing')).toBe(false);
            expect(isTerminalStatus('aborting')).toBe(false);
        });

        it('should correctly allow canonical legal state transitions', () => {
            // Canonical path: idle -> reserving -> streaming -> preview_ready -> committing -> committed -> idle
            expect(isValidTransition('idle', 'reserving')).toBe(true);
            expect(isValidTransition('reserving', 'streaming')).toBe(true);
            expect(isValidTransition('streaming', 'preview_ready')).toBe(true);
            expect(isValidTransition('preview_ready', 'committing')).toBe(true);
            expect(isValidTransition('committing', 'committed')).toBe(true);
            expect(isValidTransition('committed', 'idle')).toBe(true);

            // Backward-compatible path: idle -> reserved -> streaming -> completed -> committing -> committed
            expect(isValidTransition('idle', 'reserved')).toBe(true);
            expect(isValidTransition('reserved', 'streaming')).toBe(true);
            expect(isValidTransition('streaming', 'completed')).toBe(true);
            expect(isValidTransition('completed', 'committing')).toBe(true);
        });

        it('should strictly reject illegal transitions', () => {
            expect(isValidTransition('idle', 'committed')).toBe(false);
            expect(isValidTransition('idle', 'streaming')).toBe(false);
            expect(isValidTransition('streaming', 'committed')).toBe(false);
            expect(isValidTransition('committed', 'streaming')).toBe(false);
            expect(isValidTransition('preview_ready', 'streaming')).toBe(false);
        });

        it('should execute full lifecycle on a session object with timestamps and validation', () => {
            const session = createStreamSession({
                sessionId: 's-1',
                operationId: 'op-1',
                fileId: 'file-1',
                operation: 'improve',
                originalMarkdown: '# Test Heading\ntest',
                originalText: 'test',
                selection: { from: 0, to: 4 },
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            expect(session.status).toBe('idle');

            // idle -> reserving
            transitionSession(session, 'reserving');
            expect(session.status).toBe('reserving');

            // reserving -> streaming
            transitionSession(session, 'streaming');
            expect(session.status).toBe('streaming');
            expect(session.firstChunkAt).toBeDefined();

            // streaming -> preview_ready
            transitionSession(session, 'preview_ready');
            expect(session.status).toBe('preview_ready');
            expect(session.completedAt).toBeDefined();

            // preview_ready -> committing
            transitionSession(session, 'committing');
            expect(session.status).toBe('committing');

            // committing -> committed
            transitionSession(session, 'committed');
            expect(session.status).toBe('committed');

            // committed -> idle
            transitionSession(session, 'idle');
            expect(session.status).toBe('idle');
        });

        it('should throw an error when attempting an invalid transition on a session', () => {
            const session = createStreamSession({
                sessionId: 's-err',
                operationId: 'op-err',
                fileId: 'file-err',
                operation: 'improve',
                originalMarkdown: '# Test Heading\ntest',
                originalText: 'test',
                selection: { from: 0, to: 4 },
                expectedVersion: 1,
                originalEtag: 'etag-1',
                editorGeneration: 1,
            });

            transitionSession(session, 'reserving');

            // Illegal: reserving -> committed (must go through streaming -> preview_ready -> committing)
            expect(() => transitionSession(session, 'committed')).toThrowError(
                /Invalid transition/
            );
        });

        it('should allow cancellation transitions to aborting/aborted/conflict/rolled_back', () => {
            const session = createStreamSession({
                sessionId: 's-2',
                operationId: 'op-2',
                fileId: 'file-2',
                operation: 'correct',
                originalMarkdown: 'hello world',
                originalText: 'hello',
                selection: { from: 0, to: 5 },
                expectedVersion: 1,
                originalEtag: 'etag-2',
                editorGeneration: 1,
            });

            transitionSession(session, 'reserving');
            transitionSession(session, 'streaming');
            transitionSession(session, 'aborting');
            transitionSession(session, 'aborted');
            expect(session.status).toBe('aborted');

            // Can reset back to idle
            transitionSession(session, 'idle');
            expect(session.status).toBe('idle');
        });

        it('should handle conflict state during commit', () => {
            const session = createStreamSession({
                sessionId: 's-conflict',
                operationId: 'op-conflict',
                fileId: 'file-c',
                operation: 'improve',
                originalMarkdown: 'conflict document',
                originalText: 'conflict',
                selection: { from: 0, to: 8 },
                expectedVersion: 1,
                originalEtag: 'etag-c',
                editorGeneration: 1,
            });

            transitionSession(session, 'reserving');
            transitionSession(session, 'streaming');
            transitionSession(session, 'preview_ready');
            transitionSession(session, 'committing');
            transitionSession(session, 'conflict', 'Version mismatch (412)');

            expect(session.status).toBe('conflict');
            expect(session.failureReason).toBe('Version mismatch (412)');
            expect(isTerminalStatus(session.status)).toBe(true);
        });
    });

    describe('Generation & Version Integrity Guards', () => {
        it('should pass integrity assertion when generation and version match', () => {
            const session = createStreamSession({
                sessionId: 's-3',
                operationId: 'op-3',
                fileId: 'file-3',
                operation: 'summarize',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 3,
                originalEtag: 'etag-3',
                editorGeneration: 2,
            });

            const check = assertSessionIntegrity(session, 2, 3);
            expect(check.valid).toBe(true);
        });

        it('should reject commit if editor generation changed (stale session)', () => {
            const session = createStreamSession({
                sessionId: 's-4',
                operationId: 'op-4',
                fileId: 'file-4',
                operation: 'improve',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 1,
                originalEtag: 'etag-4',
                editorGeneration: 1,
            });

            // Editor generation advanced to 2 (e.g. user reloaded or switched document)
            const check = assertSessionIntegrity(session, 2, 1);
            expect(check.valid).toBe(false);
            expect(check.reason).toContain('generation mismatch');
        });

        it('should reject commit if file version changed concurrently', () => {
            const session = createStreamSession({
                sessionId: 's-5',
                operationId: 'op-5',
                fileId: 'file-5',
                operation: 'improve',
                originalMarkdown: 'content here',
                originalText: 'content',
                selection: { from: 0, to: 7 },
                expectedVersion: 1,
                originalEtag: 'etag-5',
                editorGeneration: 1,
            });

            // File version changed to 2 on server
            const check = assertSessionIntegrity(session, 1, 2);
            expect(check.valid).toBe(false);
            expect(check.reason).toContain('version mismatch');
        });
    });

    describe('EphemeralPreviewBuffer Memory Ceiling & Operations', () => {
        it('should append and accumulate text chunks per session', () => {
            const buffer = new EphemeralPreviewBuffer(1000);
            buffer.open('sess-1');

            const res1 = buffer.append('sess-1', 'Hello ');
            expect(res1.text).toBe('Hello ');
            expect(res1.truncated).toBe(false);

            const res2 = buffer.append('sess-1', 'World!');
            expect(res2.text).toBe('Hello World!');
            expect(buffer.getLength('sess-1')).toBe(12);

            buffer.close('sess-1');
            expect(buffer.has('sess-1')).toBe(false);
            expect(buffer.getText('sess-1')).toBe('');
        });

        it('should truncate incoming text when exceeding memory ceiling', () => {
            const smallBuffer = new EphemeralPreviewBuffer(10);
            smallBuffer.open('sess-2');

            const res = smallBuffer.append('sess-2', '1234567890EXTRA');
            expect(res.text).toBe('1234567890');
            expect(res.truncated).toBe(true);
            expect(smallBuffer.getLength('sess-2')).toBe(10);

            smallBuffer.close('sess-2');
        });
    });
});

