/**
 * Phase 10 Test Suite: Encrypted Document Export Governance (LUGX-004, LUGX-017, LUGX-019, LUGX-085)
 *
 * Verifies:
 * 1. exportDocument fails closed on encrypted files without explicit user confirmation.
 * 2. exportDocument permits plaintext export of encrypted files once explicit confirmation is provided.
 * 3. exportDocument allows direct export of normal (unencrypted) documents without prompting.
 * 4. triggerBrowserDownload triggers object URL creation and anchor dispatch.
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportDocument, triggerBrowserDownload } from '@/lib/export/export-service';

describe('Phase 10: Export Governance & Encrypted Content Protection', () => {
    describe('exportDocument Fail-Closed Barrier', () => {
        it('rejects exporting an encrypted document when confirmedPlaintextExport is false', async () => {
            const result = await exportDocument({
                content: '# Secret Encrypted Vault Document',
                filename: 'secret-vault-doc',
                format: 'md',
                isEncrypted: true,
                confirmedPlaintextExport: false,
            });

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('ENCRYPTED_EXPORT_UNCONFIRMED');
            expect(result.error).toContain('requires explicit user confirmation');
            expect(result.blob).toBeUndefined();
        });

        it('rejects exporting an encrypted document when confirmedPlaintextExport is omitted (defaults to false)', async () => {
            const result = await exportDocument({
                content: 'Secret text content',
                filename: 'secret-notes',
                format: 'txt',
                isEncrypted: true,
            });

            expect(result.success).toBe(false);
            expect(result.errorCode).toBe('ENCRYPTED_EXPORT_UNCONFIRMED');
            expect(result.blob).toBeUndefined();
        });

        it('permits exporting an encrypted document when confirmedPlaintextExport is explicitly true', async () => {
            const content = '# Confirmed Decrypted Content\n\nThis is exported after confirmation.';
            const result = await exportDocument({
                content,
                filename: 'confirmed-export',
                format: 'md',
                isEncrypted: true,
                confirmedPlaintextExport: true,
            });

            expect(result.success).toBe(true);
            expect(result.filename).toBe('confirmed-export.md');
            expect(result.blob).toBeDefined();

            const exportedText = await result.blob!.text();
            expect(exportedText).toBe(content);
        });

        it('permits exporting an unencrypted document directly without confirmation', async () => {
            const content = '# Public Document\n\nUnencrypted document content.';
            const result = await exportDocument({
                content,
                filename: 'public-doc',
                format: 'md',
                isEncrypted: false,
                confirmedPlaintextExport: false,
            });

            expect(result.success).toBe(true);
            expect(result.filename).toBe('public-doc.md');
            expect(result.blob).toBeDefined();

            const exportedText = await result.blob!.text();
            expect(exportedText).toBe(content);
        });

        it('correctly handles plain text format stripping markdown when confirmed', async () => {
            const content = '# Header\n\n**Bold text** and *italic* text.';
            const result = await exportDocument({
                content,
                filename: 'formatted-doc',
                format: 'txt',
                isEncrypted: true,
                confirmedPlaintextExport: true,
            });

            expect(result.success).toBe(true);
            expect(result.filename).toBe('formatted-doc.txt');
            expect(result.blob).toBeDefined();

            const exportedText = await result.blob!.text();
            expect(exportedText).not.toContain('**Bold text**');
            expect(exportedText).toContain('Bold text');
        });
    });

    describe('triggerBrowserDownload', () => {
        beforeEach(() => {
            vi.restoreAllMocks();
        });

        it('creates an object URL, clicks an anchor element, and revokes the URL', () => {
            const mockCreateObjectURL = vi.fn().mockReturnValue('blob:mock-url-123');
            const mockRevokeObjectURL = vi.fn();
            globalThis.URL.createObjectURL = mockCreateObjectURL;
            globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

            const appendSpy = vi.spyOn(document.body, 'appendChild');
            const removeSpy = vi.spyOn(document.body, 'removeChild');

            const testBlob = new Blob(['sample content'], { type: 'text/markdown' });
            triggerBrowserDownload(testBlob, 'download-test.md');

            expect(mockCreateObjectURL).toHaveBeenCalledWith(testBlob);
            expect(appendSpy).toHaveBeenCalled();
            expect(removeSpy).toHaveBeenCalled();
            expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url-123');
        });
    });
});
