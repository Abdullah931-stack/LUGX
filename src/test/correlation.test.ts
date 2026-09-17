import { describe, it, expect } from 'vitest';
import {
    getOrGenerateCorrelationId,
    addCorrelationHeader,
    CORRELATION_HEADER,
} from '@/lib/utils/correlation';

describe('Correlation ID Utilities (Phase 17)', () => {
    it('should generate a valid UUID when no request or header is provided', () => {
        const id = getOrGenerateCorrelationId();
        expect(id).toBeDefined();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(10);
    });

    it('should extract existing X-Correlation-ID header from Headers instance', () => {
        const headers = new Headers();
        headers.set(CORRELATION_HEADER, 'test-correlation-12345');

        const extracted = getOrGenerateCorrelationId(headers);
        expect(extracted).toBe('test-correlation-12345');
    });

    it('should extract lowercase x-correlation-id from Request object', () => {
        const req = new Request('http://localhost:3000/api/test', {
            headers: { 'x-correlation-id': 'custom-req-id-789' },
        });

        const extracted = getOrGenerateCorrelationId(req);
        expect(extracted).toBe('custom-req-id-789');
    });

    it('should sanitize header value against malicious injection characters', () => {
        const mockRequest = {
            headers: new Headers({
                [CORRELATION_HEADER]: 'safe-id-with_valid_and_invalid$chars#123',
            }),
        };

        const extracted = getOrGenerateCorrelationId(mockRequest as unknown as Request);
        expect(extracted).not.toContain('$');
        expect(extracted).not.toContain('#');
        expect(extracted).toBe('safe-id-with_valid_and_invalidchars123');
    });

    it('should attach correlation header to response headers via addCorrelationHeader', () => {
        const headers = new Headers();
        addCorrelationHeader(headers, 'my-trace-id');
        expect(headers.get(CORRELATION_HEADER)).toBe('my-trace-id');
    });
});
