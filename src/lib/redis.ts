import { Redis } from "@upstash/redis";

// Initialize Upstash Redis client
export const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Key constants for Redis operations
export const REDIS_KEYS = {
    CURRENT_KEY_INDEX: "gemini:current_key_index",
    USAGE_COUNT_PREFIX: "gemini:usage_count:",
} as const;
