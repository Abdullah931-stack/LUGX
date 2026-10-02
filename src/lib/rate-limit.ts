/**
 * Rate Limiter for Sync, File, Auth, and AI Streaming APIs
 * 
 * Uses Upstash Redis for distributed rate limiting.
 * Implements sliding window algorithm for accurate rate limiting.
 * 
 * POLICY (Hardened Phase 13 - LUGX-079):
 * - Sensitive endpoints (AI Streaming, Auth) operate in Fail-Closed mode
 *   upon Redis errors or missing config, protecting upstream LLM quotas and brute-force vectors.
 * - General endpoints (Sync, File) operate in Fail-Open mode
 *   upon Redis errors to preserve offline-first user continuity.
 */

import { redis, isRedisConfigured } from './redis';

export type RateLimitFailureMode = 'fail-closed' | 'fail-open';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
    /** Maximum requests allowed in the window */
    limit: number;
    /** Time window in seconds */
    windowSeconds: number;
    /**
     * Failure mode when Redis is unreachable or unconfigured.
     * - 'fail-closed': Rejects requests with HTTP 503/429 to protect resources and quotas.
     * - 'fail-open': Allows requests through to preserve user continuity.
     * @default 'fail-open'
     */
    failureMode?: RateLimitFailureMode;
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
    /** True if Redis was degraded/unreachable and fallback policy engaged */
    isDegraded?: boolean;
}

/**
 * Default rate limit configurations with explicit per-tier failure modes
 */
export const RATE_LIMITS = {
    /** Sync API: 100 requests per 15 minutes (fail-open for offline continuity) */
    SYNC_API: { limit: 100, windowSeconds: 15 * 60, failureMode: 'fail-open' as const },
    /** File API: 200 requests per 15 minutes (fail-open for offline continuity) */
    FILE_API: { limit: 200, windowSeconds: 15 * 60, failureMode: 'fail-open' as const },
    /** General API: 300 requests per 15 minutes */
    GENERAL: { limit: 300, windowSeconds: 15 * 60, failureMode: 'fail-open' as const },
    /** Auth (sign-in/sign-up): 20 requests per 15 minutes (fail-closed against credential stuffing) */
    AUTH: { limit: 20, windowSeconds: 15 * 60, failureMode: 'fail-closed' as const },
    /** AI Streaming API: 30 requests per 60 seconds (fail-closed to protect upstream LLM keys) */
    AI_STREAM: { limit: 30, windowSeconds: 60, failureMode: 'fail-closed' as const },
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
        this.config = {
            failureMode: 'fail-open',
            ...config,
        };
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

        if (!isRedisConfigured()) {
            if (this.config.failureMode === 'fail-closed') {
                return {
                    success: false,
                    remaining: 0,
                    reset: Math.ceil(Date.now() / 1000) + Math.min(this.config.windowSeconds, 60),
                    limit: this.config.limit,
                    isDegraded: true,
                };
            }
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
                isDegraded: true,
            };
        }

        try {
            // Phase 1: Clean stale entries and count current active tokens
            const pipeline = redis.pipeline();
            pipeline.zremrangebyscore(key, 0, windowStart);
            pipeline.zcard(key);

            const results = await pipeline.exec();
            const currentCount = (results[1] as number) || 0;

            // LUGX-079 fix: Only append request token if within limit
            if (currentCount >= this.config.limit) {
                return {
                    success: false,
                    remaining: 0,
                    reset: Math.ceil((now + this.config.windowSeconds * 1000) / 1000),
                    limit: this.config.limit,
                };
            }

            // Phase 2: Consume 1 token only when request is allowed
            const consumePipeline = redis.pipeline();
            consumePipeline.zadd(key, { score: now, member: `${now}-${Math.random()}` });
            consumePipeline.expire(key, this.config.windowSeconds);
            await consumePipeline.exec();

            return {
                success: true,
                remaining: Math.max(0, this.config.limit - currentCount - 1),
                reset: Math.ceil((now + this.config.windowSeconds * 1000) / 1000),
                limit: this.config.limit,
            };
        } catch (error) {
            console.error(`[RateLimiter:${this.keyPrefix}] Redis error:`, error);
            if (this.config.failureMode === 'fail-closed') {
                return {
                    success: false,
                    remaining: 0,
                    reset: Math.ceil(Date.now() / 1000) + Math.min(this.config.windowSeconds, 60),
                    limit: this.config.limit,
                    isDegraded: true,
                };
            }

            // On Redis error with fail-open policy, allow the request
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
                isDegraded: true,
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

        if (!isRedisConfigured()) {
            if (this.config.failureMode === 'fail-closed') {
                return {
                    success: false,
                    remaining: 0,
                    reset: Math.ceil(Date.now() / 1000) + Math.min(this.config.windowSeconds, 60),
                    limit: this.config.limit,
                    isDegraded: true,
                };
            }
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
                isDegraded: true,
            };
        }

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
            console.error(`[RateLimiter:${this.keyPrefix}] Redis error:`, error);
            if (this.config.failureMode === 'fail-closed') {
                return {
                    success: false,
                    remaining: 0,
                    reset: Math.ceil(Date.now() / 1000) + Math.min(this.config.windowSeconds, 60),
                    limit: this.config.limit,
                    isDegraded: true,
                };
            }
            return {
                success: true,
                remaining: this.config.limit,
                reset: Math.ceil(Date.now() / 1000) + this.config.windowSeconds,
                limit: this.config.limit,
                isDegraded: true,
            };
        }
    }

    /**
     * Reset rate limit for an identifier
     */
    async reset(identifier: string): Promise<void> {
        const key = `ratelimit:${this.keyPrefix}:${identifier}`;
        try {
            await redis.del(key);
        } catch (error) {
            console.error(`[RateLimiter:${this.keyPrefix}] Reset error:`, error);
        }
    }
}

/**
 * Pre-configured rate limiters
 */
export const syncApiRateLimiter = new RateLimiter('sync', RATE_LIMITS.SYNC_API);
export const fileApiRateLimiter = new RateLimiter('file', RATE_LIMITS.FILE_API);
export const authRateLimiter = new RateLimiter('auth', RATE_LIMITS.AUTH);
export const aiStreamRateLimiter = new RateLimiter('ai-stream', RATE_LIMITS.AI_STREAM);

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
    if (result.isDegraded) {
        headers.set('X-RateLimit-Degraded', '1');
    }
}

/**
 * Create rate limit exceeded or service degraded response
 */
export function rateLimitExceededResponse(result: RateLimitResult): Response {
    const isDegraded = Boolean(result.isDegraded);
    const retryAfterSeconds = Math.max(1, Math.ceil(result.reset - Date.now() / 1000));
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Retry-After': retryAfterSeconds.toString(),
    });
    addRateLimitHeaders(headers, result);

    const status = isDegraded ? 503 : 429;
    const error = isDegraded ? 'Service Unavailable' : 'Too Many Requests';
    const message = isDegraded
        ? 'Rate limiting service is temporarily unavailable. Request blocked under fail-closed security policy.'
        : 'Rate limit exceeded. Please try again later.';

    return new Response(
        JSON.stringify({
            error,
            message,
            retryAfter: result.reset,
        }),
        {
            status,
            headers,
        }
    );
}
