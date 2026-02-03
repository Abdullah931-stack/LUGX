/**
 * Rate Limiter for Sync API
 * 
 * Uses Upstash Redis for distributed rate limiting.
 * Implements sliding window algorithm for accurate rate limiting.
 */

import { redis } from './redis';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
    /** Maximum requests allowed in the window */
    limit: number;
    /** Time window in seconds */
    windowSeconds: number;
}

/**
 * Rate limit result
 */
export interface RateLimitResult {
    /** Whether the request is allowed */
    success: boolean;
    /** Remaining requests in current window */
    remaining: number;
    /** Unix timestamp when the rate limit resets */
    reset: number;
    /** Total limit for the window */
    limit: number;
}

/**
 * Default rate limit configurations
 */
export const RATE_LIMITS = {
    /** Sync API: 100 requests per 15 minutes */
    SYNC_API: { limit: 100, windowSeconds: 15 * 60 },
    /** File API: 200 requests per 15 minutes */
    FILE_API: { limit: 200, windowSeconds: 15 * 60 },
    /** General API: 300 requests per 15 minutes */
    GENERAL: { limit: 300, windowSeconds: 15 * 60 },
} as const;

/**
 * Rate Limiter Class
 * Implements sliding window rate limiting with Redis
 */
export class RateLimiter {
    private keyPrefix: string;
    private config: RateLimitConfig;

    constructor(keyPrefix: string, config: RateLimitConfig) {
        this.keyPrefix = keyPrefix;
        this.config = config;
    }

    /**
     * Check and consume rate limit for an identifier
     * 
     * @param identifier - Unique identifier (user ID, IP, etc.)
     * @returns Rate limit result
     */
    async limit(identifier: string): Promise<RateLimitResult> {
        const key = `ratelimit:${this.keyPrefix}:${identifier}`;
        const now = Date.now();
        const windowStart = now - (this.config.windowSeconds * 1000);

        try {
            // Use Redis pipeline for atomic operations
            const pipeline = redis.pipeline();

            // Remove old entries outside the window
            pipeline.zremrangebyscore(key, 0, windowStart);

            // Count current entries in window
            pipeline.zcard(key);

            // Add current request
            pipeline.zadd(key, { score: now, member: `${now}-${Math.random()}` });

            // Set expiry on the key
            pipeline.expire(key, this.config.windowSeconds);

            const results = await pipeline.exec();

            // Get count from zcard result (index 1)
            const currentCount = (results[1] as number) || 0;

            const success = currentCount < this.config.limit;
            const remaining = Math.max(0, this.config.limit - currentCount - 1);
            const reset = Math.ceil((now + this.config.windowSeconds * 1000) / 1000);

            return {
                success,
                remaining,
                reset,
                limit: this.config.limit,
            };
        } catch (error) {
            console.error('[RateLimiter] Redis error:', error);
            // On Redis error, allow the request (fail open)
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
            };
        }
    }

    /**
     * Get current rate limit status without consuming
     */
    async getStatus(identifier: string): Promise<RateLimitResult> {
        const key = `ratelimit:${this.keyPrefix}:${identifier}`;
        const now = Date.now();
        const windowStart = now - (this.config.windowSeconds * 1000);

        try {
            // Count entries in current window
            const count = await redis.zcount(key, windowStart, now);
            const remaining = Math.max(0, this.config.limit - count);
            const reset = Math.ceil((now + this.config.windowSeconds * 1000) / 1000);

            return {
                success: count < this.config.limit,
                remaining,
                reset,
                limit: this.config.limit,
            };
        } catch (error) {
            console.error('[RateLimiter] Redis error:', error);
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
            };
        }
    }

    /**
     * Reset rate limit for an identifier
     */
    async reset(identifier: string): Promise<void> {
        const key = `ratelimit:${this.keyPrefix}:${identifier}`;
        await redis.del(key);
    }
}

/**
 * Pre-configured rate limiters
 */
export const syncApiRateLimiter = new RateLimiter('sync', RATE_LIMITS.SYNC_API);
export const fileApiRateLimiter = new RateLimiter('file', RATE_LIMITS.FILE_API);

/**
 * Helper to add rate limit headers to response
 */
export function addRateLimitHeaders(
    headers: Headers,
    result: RateLimitResult
): void {
    headers.set('X-RateLimit-Limit', result.limit.toString());
    headers.set('X-RateLimit-Remaining', result.remaining.toString());
    headers.set('X-RateLimit-Reset', result.reset.toString());
}

/**
 * Create rate limit exceeded response
 */
export function rateLimitExceededResponse(result: RateLimitResult): Response {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil(result.reset - Date.now() / 1000).toString(),
    });
    addRateLimitHeaders(headers, result);

    return new Response(
        JSON.stringify({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please try again later.',
            retryAfter: result.reset,
        }),
        {
            status: 429,
            headers,
        }
    );
}
