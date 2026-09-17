import { describe, it, expect } from 'vitest';
import {
    validateFile,
    validateFileBuffer,
    isDisguisedBinary,
    MAX_FILE_SIZE,
} from './file-validator';

describe('File Validator Utility (Unit Tests)', () => {
    describe('validateFile (Browser File Object)', () => {
        it('accepts valid markdown file', () => {
            const file = new File(['# Title\n\nContent'], 'document.md', {
                type: 'text/markdown',
            });
            const result = validateFile(file);
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('md');
        });

        it('accepts valid text file', () => {
            const file = new File(['Plain text content'], 'notes.txt', {
                type: 'text/plain',
            });
            const result = validateFile(file);
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('txt');
        });

        it('accepts valid pdf file', () => {
            const file = new File(['%PDF-1.4 dummy content'], 'whitepaper.pdf', {
                type: 'application/pdf',
            });
            const result = validateFile(file);
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('pdf');
        });

        it('rejects file exceeding MAX_FILE_SIZE (10MB)', () => {
            const oversized = new File(['x'.repeat(100)], 'huge.md', {
                type: 'text/markdown',
            });
            Object.defineProperty(oversized, 'size', {
                value: MAX_FILE_SIZE + 1024,
            });

            const result = validateFile(oversized);
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('File size exceeds 10MB limit');
        });

        it('rejects disallowed file extensions', () => {
            const disallowed = ['script.sh', 'app.exe', 'photo.png', 'archive.zip', 'page.html'];
            for (const name of disallowed) {
                const file = new File(['test'], name, { type: 'text/plain' });
                const result = validateFile(file);
                expect(result.isValid).toBe(false);
                expect(result.error).toContain('Only PDF, MD, and TXT files are allowed');
            }
        });

        it('rejects disallowed MIME types for allowed extensions', () => {
            const file = new File(['test'], 'data.md', {
                type: 'application/x-msdownload',
            });
            const result = validateFile(file);
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('Invalid MIME type');
        });
    });

    describe('isDisguisedBinary (Magic Bytes Inspector)', () => {
        it('detects Windows PE executable (MZ header)', () => {
            const peBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
            const result = isDisguisedBinary(peBytes);
            expect(result.isBinary).toBe(true);
            expect(result.type).toContain('Windows Executable');
        });

        it('detects Linux ELF executable (\\x7fELF header)', () => {
            const elfBytes = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
            const result = isDisguisedBinary(elfBytes);
            expect(result.isBinary).toBe(true);
            expect(result.type).toContain('Linux Executable');
        });

        it('detects macOS Mach-O 64-bit and FAT binaries', () => {
            const machO1 = new Uint8Array([0xfe, 0xed, 0xfa, 0xcf, 0x00]);
            const machO2 = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x00]);
            expect(isDisguisedBinary(machO1).isBinary).toBe(true);
            expect(isDisguisedBinary(machO2).isBinary).toBe(true);
        });

        it('detects ZIP and JAR archives (PK\\x03\\x04)', () => {
            const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
            const result = isDisguisedBinary(zipBytes);
            expect(result.isBinary).toBe(true);
            expect(result.type).toContain('ZIP Archive');
        });

        it('detects 7-Zip archives (7z...)', () => {
            const sevenZipBytes = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
            const result = isDisguisedBinary(sevenZipBytes);
            expect(result.isBinary).toBe(true);
            expect(result.type).toContain('7-Zip Archive');
        });

        it('detects RAR archives (Rar!...)', () => {
            const rarBytes = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
            const result = isDisguisedBinary(rarBytes);
            expect(result.isBinary).toBe(true);
            expect(result.type).toContain('RAR Archive');
        });

        it('returns false for plain Markdown and UTF-8 text', () => {
            const textBytes = new TextEncoder().encode('# Markdown Header\n\nSome paragraph text.');
            expect(isDisguisedBinary(textBytes).isBinary).toBe(false);
        });

        it('does not falsely flag plain text starting with MZ characters as Windows PE executable', () => {
            const mzText = new TextEncoder().encode('MZ: Meeting Notes and Architecture Specification');
            expect(isDisguisedBinary(mzText).isBinary).toBe(false);
        });
    });

    describe('validateFileBuffer (In-Memory Buffer Inspection)', () => {
        it('validates genuine UTF-8 Markdown text buffer', () => {
            const mdBytes = new TextEncoder().encode('# Document Title\n\n- Bullet 1\n- Bullet 2');
            const result = validateFileBuffer(mdBytes, 'notes.md');
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('md');
        });

        it('validates genuine Markdown text buffer starting with MZ', () => {
            const mzBytes = new TextEncoder().encode('MZ: System Specification\n\nDetailed breakdown.');
            const result = validateFileBuffer(mzBytes, 'mz-spec.md');
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('md');
        });

        it('validates genuine PDF buffer with %PDF header', () => {
            const pdfBytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj');
            const result = validateFileBuffer(pdfBytes, 'document.pdf');
            expect(result.isValid).toBe(true);
            expect(result.fileType).toBe('pdf');
        });

        it('rejects PDF buffer missing %PDF header', () => {
            const badPdfBytes = new TextEncoder().encode('Not a valid PDF header stream');
            const result = validateFileBuffer(badPdfBytes, 'corrupted.pdf');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('missing %PDF header');
        });

        it('rejects disguised Windows executable renamed to .md', () => {
            const disguisedPe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
            const result = validateFileBuffer(disguisedPe, 'malicious.md');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('disguised binary detected');
        });

        it('rejects disguised Linux ELF executable renamed to .txt', () => {
            const disguisedElf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
            const result = validateFileBuffer(disguisedElf, 'payload.txt');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('disguised binary detected');
        });

        it('rejects disguised ZIP archive renamed to .md', () => {
            const disguisedZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
            const result = validateFileBuffer(disguisedZip, 'bundle.md');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('disguised binary detected');
        });

        it('rejects invalid UTF-8 byte sequences in .txt file', () => {
            const malformedUtf8 = new Uint8Array([0xc0, 0xaf, 0xff, 0xfe]);
            const result = validateFileBuffer(malformedUtf8, 'broken.txt');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('content is not valid UTF-8');
        });

        it('rejects buffers exceeding MAX_FILE_SIZE', () => {
            const oversizedBytes = new Uint8Array(MAX_FILE_SIZE + 1);
            const result = validateFileBuffer(oversizedBytes, 'big.md');
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('File size exceeds 10MB limit');
        });
    });
});
