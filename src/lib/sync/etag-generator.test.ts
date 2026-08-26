/**
 * ETag Generator Tests
 * Tests for ETag generation and comparison utilities
 */

import { describe, it, expect } from 'vitest';
import { generateETagSync, compareETags, normalizeMarkdownSource } from './etag-generator';

describe('ETag Generator & Normalization', () => {
    describe('normalizeMarkdownSource', () => {
        it('normalizes CRLF to LF', () => {
            const input = 'Line 1\r\nLine 2\r\nLine 3';
            expect(normalizeMarkdownSource(input)).toBe('Line 1\nLine 2\nLine 3');
        });

        it('normalizes lone CR to LF', () => {
            const input = 'Line 1\rLine 2\rLine 3';
            expect(normalizeMarkdownSource(input)).toBe('Line 1\nLine 2\nLine 3');
        });

        it('normalizes Unicode strings to NFC', () => {
            // "é" in NFD is 'e' + combining acute accent (U+0301)
            const nfd = 'e\u0301';
            // "é" in NFC is single code point (U+00E9)
            const nfc = '\u00E9';
            expect(nfd).not.toBe(nfc);
            expect(normalizeMarkdownSource(nfd)).toBe(nfc);
        });

        it('strips null bytes (\0) to protect PostgreSQL text encoding', () => {
            const input = 'Safe\0 Markdown\0 text\0 with null bytes';
            expect(normalizeMarkdownSource(input)).toBe('Safe Markdown text with null bytes');
        });

        it('handles null, undefined, and empty string safely', () => {
            expect(normalizeMarkdownSource(null)).toBe('');
            expect(normalizeMarkdownSource(undefined)).toBe('');
            expect(normalizeMarkdownSource('')).toBe('');
        });
    });

    describe('generateETagSync', () => {
        it('generates identical ETag across CRLF and LF line endings (cross-platform stability)', () => {
            const fileWindows = {
                id: 'file-123',
                content: '# Title\r\nParagraph 1\r\nParagraph 2\r\n',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const fileUnix = {
                id: 'file-123',
                content: '# Title\nParagraph 1\nParagraph 2\n',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etagWindows = generateETagSync(fileWindows);
            const etagUnix = generateETagSync(fileUnix);

            expect(etagWindows).toBe(etagUnix);
        });

        it('generates identical ETag across Unicode NFD and NFC representations', () => {
            const fileNFD = {
                id: 'file-123',
                content: 'Café: e\u0301',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const fileNFC = {
                id: 'file-123',
                content: 'Café: \u00E9',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etagNFD = generateETagSync(fileNFD);
            const etagNFC = generateETagSync(fileNFC);

            expect(etagNFD).toBe(etagNFC);
        });

        it('should generate consistent ETag for same input', () => {
            const file = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag1 = generateETagSync(file);
            const etag2 = generateETagSync(file);

            expect(etag1).toBe(etag2);
        });

        it('should generate different ETags for different content', () => {
            const file1 = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const file2 = {
                id: 'file-123',
                content: 'Hello World!',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag1 = generateETagSync(file1);
            const etag2 = generateETagSync(file2);

            expect(etag1).not.toBe(etag2);
        });

        it('should generate different ETags for different file IDs', () => {
            const file1 = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const file2 = {
                id: 'file-456',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag1 = generateETagSync(file1);
            const etag2 = generateETagSync(file2);

            expect(etag1).not.toBe(etag2);
        });

        it('should generate different ETags for different timestamps', () => {
            const file1 = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const file2 = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-02T00:00:00Z'),
            };

            const etag1 = generateETagSync(file1);
            const etag2 = generateETagSync(file2);

            expect(etag1).not.toBe(etag2);
        });

        it('should handle empty content', () => {
            const file = {
                id: 'file-123',
                content: '',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag = generateETagSync(file);

            expect(etag).toBeDefined();
            expect(typeof etag).toBe('string');
            expect(etag.length).toBeGreaterThan(0);
        });

        it('should handle special characters in content', () => {
            const file = {
                id: 'file-123',
                content: 'مرحبا بالعالم 🌍 <script>alert("test")</script>',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag = generateETagSync(file);

            expect(etag).toBeDefined();
            expect(typeof etag).toBe('string');
        });

        it('should generate ETag as hex string', () => {
            const file = {
                id: 'file-123',
                content: 'Hello World',
                updatedAt: new Date('2024-01-01T00:00:00Z'),
            };

            const etag = generateETagSync(file);

            // Should be valid hex string
            expect(/^[a-f0-9]+$/i.test(etag)).toBe(true);
        });
    });

    describe('compareETags', () => {
        it('should return true for identical ETags', () => {
            const etag = 'abc123def456';

            expect(compareETags(etag, etag)).toBe(true);
        });

        it('should return false for different ETags', () => {
            expect(compareETags('abc123', 'def456')).toBe(false);
        });

        it('should handle quoted ETags', () => {
            // compareETags should normalize by stripping quotes
            expect(compareETags('"abc123"', 'abc123')).toBe(true);
            expect(compareETags('abc123', '"abc123"')).toBe(true);
            expect(compareETags('"abc123"', '"abc123"')).toBe(true);
        });

        it('should handle weak ETags (W/)', () => {
            // compareETags should normalize by stripping W/ prefix
            expect(compareETags('W/"abc123"', 'abc123')).toBe(true);
            expect(compareETags('abc123', 'W/"abc123"')).toBe(true);
            expect(compareETags('W/"abc123"', 'W/"abc123"')).toBe(true);
        });

        it('should return false for empty ETags', () => {
            expect(compareETags('', 'abc123')).toBe(false);
            expect(compareETags('abc123', '')).toBe(false);
            expect(compareETags('', '')).toBe(false);
        });

        it('should be case-insensitive', () => {
            expect(compareETags('ABC123', 'abc123')).toBe(true);
            expect(compareETags('AbC123', 'aBc123')).toBe(true);
        });
    });
});
