/**
 * ETag Generator Tests
 * Tests for ETag generation and comparison utilities
 */

import { describe, it, expect } from 'vitest';
import { generateETagSync, compareETags } from './etag-generator';

describe('ETag Generator', () => {
    describe('generateETagSync', () => {
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
