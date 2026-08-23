import { Redis } from "@upstash/redis";

let redisInstance: Redis | null = null;
let lastUrl: string | undefined;
let lastToken: string | undefined;

/**
 * Lazily initialize and return the Upstash Redis client.
 * Ensures environment variables loaded at runtime (.env.local) are properly bound.
 */
export function getRedisClient(): Redis {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!redisInstance || lastUrl !== url || lastToken !== token) {
        if (!url || !token) {
            // Safe fallback during unconfigured environments
            redisInstance = new Redis({
                url: url || "https://placeholder-redis.upstash.io",
                token: token || "placeholder-token",
            });
        } else {
            redisInstance = new Redis({ url, token });
        }
        lastUrl = url;
        lastToken = token;
    }

    return redisInstance;
}

/**
 * Exported Redis proxy to allow seamless direct usage across the entire codebase.
 */
export const redis = new Proxy({} as Redis, {
    get(_target, prop) {
        const client = getRedisClient();
        const value = (client as any)[prop];
        return typeof value === "function" ? value.bind(client) : value;
    },
});

// Key constants for Redis operations
export const REDIS_KEYS = {
    CURRENT_KEY_INDEX: "gemini:current_key_index",
    USAGE_COUNT_PREFIX: "gemini:usage_count:",
} as const;
