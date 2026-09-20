/**
 * Phase 5 Closure: AI Gatekeeper (Matrix #6) + Log Sanitation (Matrix #10).
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { AIToolbar } from '@/components/editor/ai-toolbar';
import { SyncErrorHandler, SyncErrorType } from '@/lib/sync/error-handler';
import { SyncPerformanceMonitor } from '@/lib/sync/performance-monitor';
import { POST as aiStreamRoute } from '@/app/api/ai/stream/route';
import { commitAIFileOperation } from '@/server/actions/ai-commit';
const mockGetUser = vi.hoisted(() => vi.fn());
const mockDb = vi.hoisted(() => ({
    query: {
        files: { findFirst: vi.fn() },
        userVaultProfiles: { findFirst: vi.fn() },
        aiReservations: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ id: 'u' }]) })) })),
}));
const mockTxDb = vi.hoisted(() => ({
    transaction: vi.fn(async (cb: (tx: never) => unknown) => cb({
        update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 'f', version: 2, etag: 'e2', updatedAt: new Date() }]) }) }) }),
        insert: () => ({ values: () => Promise.resolve([{ id: 'x' }]) }),
    } as never)),
}));
const mockAiOps = vi.hoisted(() => ({
    getUserTier: vi.fn().mockResolvedValue('pro'),
    reserveAndUpdateUsage: vi.fn().mockResolvedValue({ reserved: true }),
    refundAIReservation: vi.fn().mockResolvedValue({ success: true }),
    refundUsage: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('@/lib/supabase/server', () => ({ getUser: mockGetUser }));
vi.mock('@/lib/db', () => ({
    db: mockDb,
    schema: {
        files: { id: 'id', userId: 'user_id', version: 'version', etag: 'etag', deletedAt: 'deleted_at', isEncrypted: 'is_encrypted', encryptionMetadata: 'encryption_metadata', content: 'content', title: 'title' },
        userVaultProfiles: { userId: 'user_id', allowAIOnEncryptedFiles: 'allow_ai_on_encrypted_files', updatedAt: 'updated_at' },
        aiReservations: { id: 'id', operationId: 'operation_id', userId: 'user_id', fileId: 'file_id', status: 'status' },
    },
}));
vi.mock('@/lib/db/transactional', () => ({ txDb: mockTxDb }));
vi.mock('@/server/actions/ai-ops', () => mockAiOps);
vi.mock('@/lib/ai/client', () => ({
    streamWithAI: vi.fn().mockResolvedValue(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close(); } })),
    processWithAI: vi.fn().mockResolvedValue('ok'),
}));
const noop = () => undefined;
const SECRET_DOC = 'CLOSURE_SECRET_DOC_ALPHA_9f8e7d6c5b4a';
describe('Phase 5 Closure: AI Hard Block + Log Sanitation (Matrix #6/#10)', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.restoreAllMocks(); });
    it('#6 UI hides AI tools and shows badge on encrypted files', () => {
        const { container } = render(React.createElement(AIToolbar, {
            onCorrect: noop, onImprove: noop, onSummarize: noop, onTranslate: noop,
            onToPrompt: noop, onUndo: noop, onRedo: noop, onExport: noop,
            onCopy: noop, onSearch: noop, canUndo: true, canRedo: false,
            isLoading: false, showToPrompt: true, isEncrypted: true, allowAIOnEncrypted: false,
        }));
        expect(screen.getByTestId('ai-encrypted-badge')).toBeTruthy();
        expect(container.textContent).not.toContain('Improve');
        expect(container.textContent).not.toContain('Summarize');
    });

    it('#6 API rejects encrypted stream with 403 and no quota reservation', async () => {
        mockGetUser.mockResolvedValueOnce({ id: 'u1' });
        mockDb.query.files.findFirst.mockResolvedValueOnce({ id: 'f1', userId: 'u1', isEncrypted: true });
        mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({ userId: 'u1', allowAIOnEncryptedFiles: false });
        const res = await aiStreamRoute(new NextRequest('http://localhost/api/ai/stream', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'secret', operation: 'improve', fileId: 'f1' }),
        }));
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('AI_PROHIBITED_ON_ENCRYPTED_FILES');
        expect(mockAiOps.reserveAndUpdateUsage).not.toHaveBeenCalled();
    });
    it('#6 commit guard rejects plaintext commit without IV and refunds', async () => {
        mockGetUser.mockResolvedValueOnce({ id: 'u1' });
        mockDb.query.aiReservations.findFirst.mockResolvedValueOnce({ id: 'r', operationId: 'op1', userId: 'u1', fileId: 'f1', status: 'reserved' });
        mockDb.query.files.findFirst.mockResolvedValueOnce({ id: 'f1', userId: 'u1', isEncrypted: true, version: 1 });
        mockDb.query.userVaultProfiles.findFirst.mockResolvedValueOnce({ userId: 'u1', allowAIOnEncryptedFiles: true });
        const result = await commitAIFileOperation({ operationId: 'op1', fileId: 'f1', expectedVersion: 1, resultContent: 'plain', encryptionMetadata: null });
        expect(result.success).toBe(false);
        expect(mockAiOps.refundAIReservation).toHaveBeenCalled();
    });
    it('#10 error-handler and performance-monitor never leak secrets', async () => {
        const handler = new SyncErrorHandler();
        const monitor = new SyncPerformanceMonitor();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const err = handler.createError(SyncErrorType.ENCRYPTION_ERROR, `decrypt failed: content=${SECRET_DOC} ciphertext=${SECRET_DOC}`, {
                metadata: { fileId: 'f1', content: SECRET_DOC, ciphertext: SECRET_DOC, masterKey: SECRET_DOC, mnemonic: SECRET_DOC, password: SECRET_DOC, iv: SECRET_DOC, salt: SECRET_DOC, nested: { seed: SECRET_DOC } },
                originalError: new Error(`leak content=${SECRET_DOC}`),
            });
            await handler.handle(err);
            monitor.recordMetric('sync_duration', 5, { fileId: 'f1', content: SECRET_DOC, ciphertext: SECRET_DOC });
            monitor.recordMetric('push_duration', 3, { nested: { password: SECRET_DOC, plaintext: SECRET_DOC } });
            const logged = handler.getRecentErrors(5);
            const serialized = JSON.stringify({ logged, count: monitor.getMetricsCount(), report: monitor.generateReport(60000) });
            const consoleOut = JSON.stringify(errSpy.mock.calls);
            expect(serialized).not.toContain(SECRET_DOC);
            expect(consoleOut).not.toContain(SECRET_DOC);
            expect(monitor.getMetricsCount()).toBe(2);
            expect(logged.length).toBeGreaterThan(0);
        } finally {
            errSpy.mockRestore();
        }
    });
});
