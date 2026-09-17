/**
 * Correlation ID & Structured Error Utilities
 *
 * Implements lightweight, non-breaking distributed tracing across
 * API route handlers, Server Actions, NDJSON stream frames, and client telemetry.
 */

export const CORRELATION_HEADER = 'X-Correlation-ID';

/**
 * Extracts an existing correlation ID from request headers or generates a fresh UUID.
 */
export function getOrGenerateCorrelationId(source?: Request | Headers | null): string {
    if (!source) {
        return crypto.randomUUID();
    }

    let existingId: string | null = null;
    if (source instanceof Headers) {
        existingId = source.get(CORRELATION_HEADER) || source.get('x-correlation-id');
    } else if ('headers' in source && source.headers instanceof Headers) {
        existingId = source.headers.get(CORRELATION_HEADER) || source.headers.get('x-correlation-id');
    }

    if (existingId && existingId.trim().length > 0) {
        // Enforce safe ASCII alphanumeric + hyphen characters to prevent header injection
        const sanitized = existingId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
        if (sanitized.length > 0) {
            return sanitized;
        }
    }

    return crypto.randomUUID();
}

/**
 * Helper to attach X-Correlation-ID to an existing Headers instance.
 */
export function addCorrelationHeader(headers: Headers, correlationId: string): void {
    headers.set(CORRELATION_HEADER, correlationId);
}

/**
 * Standardized API Error Shape for structured logging and typed diagnostics.
 */
export interface StructuredApiError {
    code: string;
    message: string;
    correlationId: string;
    operationId?: string;
    status: number;
    retryable: boolean;
    timestamp: number;
}
