import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    RateLimiter,
    RATE_LIMITS,
    aiStreamRateLimiter,
    rateLimitExceededResponse,
} from '@/lib/rate-limit';
import { redis } from '@/lib/redis';

vi.mock('@/lib/redis', () => {
    return {
        redis: {
            pipeline: vi.fn(),
            zcount: vi.fn(),
            del: vi.fn(),
        },
    };
});

describe('Rate Limiter Suite (Phase 17)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should define AI_STREAM in RATE_LIMITS with 30 req / 60 seconds', () => {
        expect(RATE_LIMITS.AI_STREAM).toBeDefined();
        expect(RATE_LIMITS.AI_STREAM.limit).toBe(30);
        expect(RATE_LIMITS.AI_STREAM.windowSeconds).toBe(60);
    });

    it('should export aiStreamRateLimiter instance', () => {
        expect(aiStreamRateLimiter).toBeInstanceOf(RateLimiter);
    });

    it('should allow request when within limit', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([0, 5, 1, 1]), // count is 5
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60 });
        const result = await limiter.limit('user-1');

        expect(result.success).toBe(true);
        expect(result.remaining).toBe(4);
        expect(result.limit).toBe(10);
    });

    it('should reject request when limit is reached', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([0, 10, 1, 1]), // count is 10 >= limit
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60 });
        const result = await limiter.limit('user-1');

        expect(result.success).toBe(false);
        expect(result.remaining).toBe(0);
    });

    it('should FAIL OPEN (allow request) when Redis throws an error', async () => {
        const mockPipeline = {
            zremrangebyscore: vi.fn().mockReturnThis(),
            zcard: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            expire: vi.fn().mockReturnThis(),
            exec: vi.fn().mockRejectedValue(new Error('Redis cluster unreachable')),
        };
        vi.mocked(redis.pipeline).mockReturnValue(mockPipeline as unknown as ReturnType<typeof redis.pipeline>);

        const limiter = new RateLimiter('test', { limit: 10, windowSeconds: 60 });
        const result = await limiter.limit('user-failopen');

        // Must fail open so user is not blocked
        expect(result.success).toBe(true);
        expect(result.remaining).toBe(10);
    });

    it('should generate 429 response with Retry-After header in rateLimitExceededResponse', () => {
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
