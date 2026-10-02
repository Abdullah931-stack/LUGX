import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    RateLimiter,
    RATE_LIMITS,
    aiStreamRateLimiter,
    authRateLimiter,
    syncApiRateLimiter,
    rateLimitExceededResponse,
} from '@/lib/rate-limit';
import { redis, isRedisConfigured } from '@/lib/redis';

vi.mock('@/lib/redis', () => {
    return {
        isRedisConfigured: vi.fn(() => true),
        redis: {
            pipeline: vi.fn(),
            zcount: vi.fn(),
            del: vi.fn(),
        },
    };
});

describe('Rate Limiter Suite — Hardened Dual-Policy & Fail-Closed (Phase 13 / LUGX-079)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(isRedisConfigured).mockReturnValue(true);
    });

    it('should define AI_STREAM and AUTH with fail-closed policy', () => {
        expect(RATE_LIMITS.AI_STREAM).toBeDefined();
        expect(RATE_LIMITS.AI_STREAM.limit).toBe(30);
        expect(RATE_LIMITS.AI_STREAM.windowSeconds).toBe(60);
        expect(RATE_LIMITS.AI_STREAM.failureMode).toBe('fail-closed');

        expect(RATE_LIMITS.AUTH).toBeDefined();
        expect(RATE_LIMITS.AUTH.limit).toBe(20);
        expect(RATE_LIMITS.AUTH.failureMode).toBe('fail-closed');
    });

    it('should define SYNC_API and FILE_API with fail-open policy for offline-first continuity', () => {
        expect(RATE_LIMITS.SYNC_API.failureMode).toBe('fail-open');
        expect(RATE_LIMITS.FILE_API.failureMode).toBe('fail-open');
    });

    it('should export pre-configured limiter instances with correct policies', () => {
        expect(aiStreamRateLimiter).toBeInstanceOf(RateLimiter);
        expect(authRateLimiter).toBeInstanceOf(RateLimiter);
        expect(syncApiRateLimiter).toBeInstanceOf(RateLimiter);
    });

    it('should allow request when within limit and only then append zadd token', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn()
                .mockResolvedValueOnce([0, 5]) // Phase 1: active count = 5
                .mockResolvedValueOnce([1, 1]), // Phase 2: zadd + expire
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60, failureMode: 'fail-closed' });
        const result = await limiter.limit('user-1');

        expect(result.success).toBe(true);
        expect(result.remaining).toBe(4);
        expect(result.limit).toBe(10);
        // Phase 2 executed zadd
        expect(mockPipeline.zadd).toHaveBeenCalledTimes(1);
    });

    it('should reject request when limit is reached WITHOUT executing zadd (preventing retry trap LUGX-079)', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValueOnce([0, 10]), // count is 10 >= limit
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60, failureMode: 'fail-closed' });
        const result = await limiter.limit('user-1');

        expect(result.success).toBe(false);
        expect(result.remaining).toBe(0);
        // zadd must NEVER be called when limit is already reached
        expect(mockPipeline.zadd).not.toHaveBeenCalled();
    });

    it('should FAIL OPEN (allow request) when Redis throws an error and policy is fail-open', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            exec: vi.fn().mockRejectedValue(new Error('Redis cluster unreachable')),
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60, failureMode: 'fail-open' });
        const result = await limiter.limit('user-failopen');

        expect(result.success).toBe(true);
        expect(result.remaining).toBe(10);
        expect(result.isDegraded).toBe(true);
    });

    it('should FAIL CLOSED (reject request) when Redis throws an error and policy is fail-closed', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            exec: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test-ai', { limit: 30, windowSeconds: 60, failureMode: 'fail-closed' });
        const result = await limiter.limit('user-failclosed');

        expect(result.success).toBe(false);
        expect(result.remaining).toBe(0);
        expect(result.isDegraded).toBe(true);
    });

    it('should immediately FAIL CLOSED without network timeout when Redis is unconfigured and policy is fail-closed', async () => {
        vi.mocked(isRedisConfigured).mockReturnValue(false);

        const limiter = new RateLimiter('test-ai-unconfigured', { limit: 30, windowSeconds: 60, failureMode: 'fail-closed' });
        const result = await limiter.limit('user-unconfigured');

        expect(result.success).toBe(false);
        expect(result.remaining).toBe(0);
        expect(result.isDegraded).toBe(true);
        expect(redis.pipeline).not.toHaveBeenCalled();
    });

    it('should generate HTTP 429 response when regular rate limit is exceeded', () => {
        const resetTimestamp = Math.ceil(Date.now() / 1000) + 45;
        const response = rateLimitExceededResponse({
            success: false,
            remaining: 0,
            reset: resetTimestamp,
            limit: 30,
        });

        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBeDefined();
        expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
        expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(response.headers.get('X-RateLimit-Degraded')).toBeNull();
    });

    it('should generate HTTP 503 Service Unavailable when rate limiter is degraded under fail-closed policy', async () => {
        const resetTimestamp = Math.ceil(Date.now() / 1000) + 30;
        const response = rateLimitExceededResponse({
            success: false,
            remaining: 0,
            reset: resetTimestamp,
            limit: 30,
            isDegraded: true,
        });

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBeDefined();
        expect(response.headers.get('X-RateLimit-Degraded')).toBe('1');
        const body = await response.json();
        expect(body.error).toBe('Service Unavailable');
        expect(body.message).toContain('fail-closed security policy');
    });

    it('should enforce Retry-After is at least 1 second even when reset is in the past or now', () => {
        const pastResetTimestamp = Math.floor(Date.now() / 1000) - 5;
        const response = rateLimitExceededResponse({
            success: false,
            remaining: 0,
            reset: pastResetTimestamp,
            limit: 30,
        });

        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('1');
    });
});
