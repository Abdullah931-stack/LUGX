/**
 * Error Handler Tests
 * Tests for sync error handling and recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncErrorHandler, SyncErrorType, SyncError } from './error-handler';

describe('Sync Error Handler', () => {
    let handler: SyncErrorHandler;

    beforeEach(() => {
        vi.clearAllMocks();
        handler = new SyncErrorHandler();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createError', () => {
        it('should create error with required fields', () => {
            const error = handler.createError(
                SyncErrorType.NETWORK_ERROR,
                'Network failed'
            );

            expect(error.type).toBe(SyncErrorType.NETWORK_ERROR);
            expect(error.message).toBe('Network failed');
            expect(error.timestamp).toBeDefined();
            expect(typeof error.recoverable).toBe('boolean');
        });

        it('should set recoverable based on error type', () => {
            const networkError = handler.createError(SyncErrorType.NETWORK_ERROR, 'test');
            const authError = handler.createError(SyncErrorType.AUTH_ERROR, 'test');

            // Network errors are typically recoverable
            expect(networkError.recoverable).toBe(true);
            // Auth errors are not recoverable
            expect(authError.recoverable).toBe(false);
        });

        it('should accept optional parameters', () => {
            const error = handler.createError(
                SyncErrorType.SERVER_ERROR,
                'Server error',
                {
                    retryAfter: 30,
                    statusCode: 500,
                    metadata: { url: '/api/test' },
                }
            );

            expect(error.retryAfter).toBe(30);
            expect(error.statusCode).toBe(500);
            expect(error.metadata?.url).toBe('/api/test');
        });
    });

    describe('fromException', () => {
        it('should convert Error to SyncError', () => {
            const error = new Error('Something went wrong');
            const syncError = handler.fromException(error, 'test context');

            expect(syncError.type).toBeDefined();
            expect(syncError.message).toContain('Something went wrong');
            expect(syncError.timestamp).toBeDefined();
        });

        it('should detect network errors from TypeError with fetch', () => {
            const networkError = new TypeError('Failed to fetch');
            const syncError = handler.fromException(networkError, 'sync');

            expect(syncError.type).toBe(SyncErrorType.NETWORK_ERROR);
        });

        it('should detect quota errors', () => {
            const quotaError = new Error('QuotaExceededError');
            const syncError = handler.fromException(quotaError, 'save');

            expect(syncError.type).toBe(SyncErrorType.QUOTA_EXCEEDED);
        });

        it('should handle non-Error objects', () => {
            const syncError = handler.fromException('string error', 'context');

            expect(syncError.message).toContain('string error');
            expect(syncError.type).toBe(SyncErrorType.UNKNOWN_ERROR);
        });

        it('should include context in message', () => {
            const error = new Error('Test error');
            const syncError = handler.fromException(error, 'my-context');

            expect(syncError.message).toContain('my-context');
        });
    });

    describe('handle', () => {
        it('should log error to console', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            const syncError = handler.createError(
                SyncErrorType.NETWORK_ERROR,
                'Network failed'
            );

            await handler.handle(syncError);

            expect(consoleSpy).toHaveBeenCalled();
        });

        it('should notify registered callbacks', async () => {
            const callback = vi.fn();
            handler.onError(callback);

            const syncError = handler.createError(
                SyncErrorType.STORAGE_ERROR,
                'Storage full'
            );

            await handler.handle(syncError);

            expect(callback).toHaveBeenCalledWith(syncError);
        });

        it('should notify multiple callbacks', async () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            handler.onError(callback1);
            handler.onError(callback2);

            const syncError = handler.createError(
                SyncErrorType.UNKNOWN_ERROR,
                'Unknown'
            );

            await handler.handle(syncError);

            expect(callback1).toHaveBeenCalledWith(syncError);
            expect(callback2).toHaveBeenCalledWith(syncError);
        });

        it('should add error to log', async () => {
            const syncError = handler.createError(
                SyncErrorType.UNKNOWN_ERROR,
                'Test error'
            );

            await handler.handle(syncError);

            const errors = handler.getRecentErrors();
            expect(errors.length).toBe(1);
            expect(errors[0].message).toBe('Test error');
        });
    });

    describe('onError', () => {
        it('should return unsubscribe function', () => {
            const callback = vi.fn();
            const unsubscribe = handler.onError(callback);

            expect(typeof unsubscribe).toBe('function');
        });

        it('should unsubscribe correctly', async () => {
            const callback = vi.fn();
            const unsubscribe = handler.onError(callback);
            unsubscribe();

            const syncError = handler.createError(
                SyncErrorType.UNKNOWN_ERROR,
                'Test'
            );

            await handler.handle(syncError);

            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('getRecentErrors', () => {
        it('should return empty array initially', () => {
            expect(handler.getRecentErrors()).toEqual([]);
        });

        it('should return handled errors', async () => {
            const syncError = handler.createError(
                SyncErrorType.NETWORK_ERROR,
                'Test error'
            );

            await handler.handle(syncError);

            const errors = handler.getRecentErrors();
            expect(errors.length).toBe(1);
            expect(errors[0].message).toBe('Test error');
        });

        it('should respect count parameter', async () => {
            // Handle 5 errors
            for (let i = 0; i < 5; i++) {
                await handler.handle(
                    handler.createError(SyncErrorType.UNKNOWN_ERROR, `Error ${i}`)
                );
            }

            const errors = handler.getRecentErrors(3);
            expect(errors.length).toBe(3);
        });
    });

    describe('clearLog', () => {
        it('should clear all stored errors', async () => {
            await handler.handle(
                handler.createError(SyncErrorType.UNKNOWN_ERROR, 'Error 1')
            );

            handler.clearLog();

            expect(handler.getRecentErrors()).toEqual([]);
        });
    });

    describe('fromResponse', () => {
        it('should create error from 401 response', async () => {
            const response = new Response(null, { status: 401 });
            const error = await handler.fromResponse(response);

            expect(error.type).toBe(SyncErrorType.AUTH_ERROR);
            expect(error.statusCode).toBe(401);
        });

        it('should create error from 412 conflict response', async () => {
            const response = new Response(null, { status: 412 });
            const error = await handler.fromResponse(response);

            expect(error.type).toBe(SyncErrorType.CONFLICT_ERROR);
        });

        it('should create error from 429 rate limit response', async () => {
            const response = new Response(null, {
                status: 429,
                headers: { 'Retry-After': '30' },
            });
            const error = await handler.fromResponse(response);

            expect(error.type).toBe(SyncErrorType.RATE_LIMIT_ERROR);
            expect(error.recoverable).toBe(true);
            expect(error.retryAfter).toBe(30);
        });

        it('should create error from 500 server error', async () => {
            const response = new Response(null, { status: 500 });
            const error = await handler.fromResponse(response);

            expect(error.type).toBe(SyncErrorType.SERVER_ERROR);
            expect(error.recoverable).toBe(true);
        });
    });

    describe('SyncErrorType enum', () => {
        it('should have all expected error types', () => {
            expect(SyncErrorType.NETWORK_ERROR).toBeDefined();
            expect(SyncErrorType.CONFLICT_ERROR).toBeDefined();
            expect(SyncErrorType.QUOTA_EXCEEDED).toBeDefined();
            expect(SyncErrorType.AUTH_ERROR).toBeDefined();
            expect(SyncErrorType.UNKNOWN_ERROR).toBeDefined();
        });
    });
});
