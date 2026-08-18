import { redis, REDIS_KEYS } from "../redis";

// Constants
const ONE_HOUR_IN_SECONDS = 3600;
const DEFAULT_MAX_REQUESTS_PER_KEY = 20;
const CIRCUIT_BREAKER_PREFIX = "gemini:circuit_breaker:";
const MODEL_FAILURES_PREFIX = "gemini:model_failures:";
const DEFAULT_CIRCUIT_TTL_SECONDS = 3600; // 1 hour cooldown when model is overloaded

/**
 * Technical HTTP error codes that should trigger automatic key rotation.
 * These include rate limits, server errors, quota issues, and authentication faults.
 */
export const ROTATION_ERROR_CODES = [
    400, // Bad Request / Invalid API key
    401, // Unauthorized
    403, // Forbidden / Quota exceeded
    429, // Too Many Requests / Rate limit reached
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable / High demand
    504, // Gateway Timeout
];

/**
 * Retrieve all valid API keys configured in the environment.
 * Supports GEMINI_KEY_1 through GEMINI_KEY_20 and filters placeholders/empty entries.
 */
export function getApiKeys(): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= 20; i++) {
        const key = process.env[`GEMINI_KEY_${i}`];
        if (key && typeof key === "string") {
            const trimmed = key.trim();
            if (trimmed && !trimmed.includes("...") && !trimmed.startsWith("CHANGE_ME")) {
                keys.push(trimmed);
            }
        }
    }
    return keys;
}

/**
 * Get the max requests per key limit from environment.
 */
export function getRequestsPerKey(): number {
    const envVal = process.env.GEMINI_REQUESTS_PER_KEY;
    if (envVal) {
        const parsed = parseInt(envVal, 10);
        if (!isNaN(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return DEFAULT_MAX_REQUESTS_PER_KEY;
}

/**
 * Key Rotation Information returned when selecting a key for request execution.
 */
export interface KeyInfo {
    key: string;
    index: number;
}

/**
 * Get an API key for making a request WITHOUT incrementing the counter.
 * The counter is only incremented after a confirmed successful request via confirmApiKeyUsage().
 * 
 * Algorithm:
 * 1. Fetch configured keys list.
 * 2. Retrieve current key index from Redis (defaulting to 0).
 * 3. Inspect usage count for the current key.
 * 4. If current key usage >= limit (e.g. 20), rotate to next available key in Redis and set TTL.
 * 5. Return active key and index.
 */
export async function getApiKeyForRequest(): Promise<KeyInfo> {
    const keys = getApiKeys();
    const requestsPerKey = getRequestsPerKey();

    if (keys.length === 0) {
        throw new Error("No Gemini API keys configured");
    }

    let currentIndex = 0;
    try {
        const storedIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX);
        if (typeof storedIndex === "number" && !isNaN(storedIndex)) {
            currentIndex = storedIndex;
        }
    } catch (redisErr) {
        console.warn("[Key Rotation] Redis read error for current_key_index:", redisErr);
    }

    // Keep index within array bounds
    if (currentIndex >= keys.length || currentIndex < 0) {
        currentIndex = 0;
        try {
            await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, 0);
        } catch {
            // Ignore Redis write error
        }
    }

    // Look for a key index that has not exhausted its quota
    let inspectedCount = 0;
    while (inspectedCount < keys.length) {
        const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
        let usageCount = 0;

        try {
            const count = await redis.get<number>(usageKey);
            if (typeof count === "number" && !isNaN(count)) {
                usageCount = count;
            }
        } catch (redisErr) {
            console.warn(`[Key Rotation] Redis read error for usage_count ${currentIndex}:`, redisErr);
        }

        if (usageCount < requestsPerKey) {
            return {
                key: keys[currentIndex],
                index: currentIndex,
            };
        }

        // Key reached limit - set TTL on old counter and rotate to next
        try {
            await redis.expire(usageKey, ONE_HOUR_IN_SECONDS);
        } catch {
            // Ignore TTL failure
        }

        const oldIndex = currentIndex;
        currentIndex = (currentIndex + 1) % keys.length;

        try {
            await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, currentIndex);
            const newUsageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
            await redis.set(newUsageKey, 0);
        } catch {
            // Ignore Redis write error
        }

        console.log(`[Key Rotation] Key ${oldIndex} reached quota limit (${usageCount}/${requestsPerKey}). Rotated index to ${currentIndex}`);
        inspectedCount++;
    }

    // If all keys reached usage limit, return current index
    return {
        key: keys[currentIndex],
        index: currentIndex,
    };
}

/**
 * Confirm API key usage after a SUCCESSFUL response chunk or completion.
 * Increments the Redis usage counter only for confirmed successful work.
 * 
 * @param keyIndex - The index of the key that was successfully used
 */
export async function confirmApiKeyUsage(keyIndex: number): Promise<void> {
    const keys = getApiKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) return;

    const requestsPerKey = getRequestsPerKey();
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${keyIndex}`;

    try {
        const newCount = await redis.incr(usageKey);
        console.log(`[Key Rotation] Key ${keyIndex} (${keyIndex + 1}/${keys.length}) usage: ${newCount}/${requestsPerKey}`);

        if (newCount >= requestsPerKey) {
            await redis.expire(usageKey, ONE_HOUR_IN_SECONDS);
            console.log(`[Key Rotation] Key ${keyIndex} reached limit. TTL set for ${ONE_HOUR_IN_SECONDS}s. Next request will use a new key.`);
        }
    } catch (redisErr) {
        console.warn(`[Key Rotation] Failed to increment usage counter for key ${keyIndex}:`, redisErr);
    }
}

/**
 * Force immediate rotation to the next key in the pool and update Redis.
 * Called when an API key fails with rate limits (429), quota exhaustion, or authentication issues.
 * 
 * NOTE: TTL is NOT set here - TTL is only set when counter reaches the limit (20).
 * Force rotation moves to the next key and resets its counter for a fresh start.
 * 
 * @returns The new key information for immediate failover retry
 */
export async function forceKeyRotationAndGetKey(): Promise<KeyInfo> {
    const keys = getApiKeys();
    if (keys.length === 0) {
        throw new Error("No Gemini API keys configured");
    }

    let currentIndex = 0;
    try {
        const storedIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX);
        if (typeof storedIndex === "number" && !isNaN(storedIndex)) {
            currentIndex = storedIndex;
        }
    } catch {
        // Fallback to 0
    }

    const nextIndex = (currentIndex + 1) % keys.length;

    try {
        await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, nextIndex);
        const newUsageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${nextIndex}`;
        await redis.set(newUsageKey, 0);
    } catch (redisErr) {
        console.warn("[Key Rotation] Redis write error during forced rotation:", redisErr);
    }

    console.log(`[Key Rotation] FORCED rotation from key ${currentIndex} to key ${nextIndex}`);

    return {
        key: keys[nextIndex],
        index: nextIndex,
    };
}

/**
 * Extract HTTP status code from error object or message string.
 */
export function extractErrorCode(error: unknown): number {
    if (error === null || error === undefined) return 0;
    if (typeof error === "object" && error !== null && "status" in error && typeof (error as any).status === "number") {
        return (error as any).status;
    }
    const errorMessage = (error as Error)?.message || String(error);
    const statusMatch = errorMessage.match(/(\d{3})/);
    return statusMatch ? parseInt(statusMatch[1], 10) : 0;
}

/**
 * Check if the error is specifically a 503 / High Demand / Overloaded server error.
 */
export function is503OrOverloadError(errorOrCode: unknown): boolean {
    if (typeof errorOrCode === "number") {
        return errorOrCode === 503;
    }

    const statusCode = extractErrorCode(errorOrCode);
    if (statusCode === 503) {
        return true;
    }

    const message = ((errorOrCode as Error)?.message || String(errorOrCode)).toLowerCase();
    return (
        message.includes("503") ||
        message.includes("high demand") ||
        message.includes("service unavailable") ||
        message.includes("overloaded") ||
        message.includes("failed to parse stream")
    );
}

/**
 * Determine whether an error is a rotatable technical error.
 * Includes HTTP codes (400, 401, 403, 429, 500, 502, 503, 504),
 * quota limit messages, stream parser aborts, and transient network errors.
 */
export function shouldRotateOnError(errorOrCode: unknown): boolean {
    if (typeof errorOrCode === "number") {
        return ROTATION_ERROR_CODES.includes(errorOrCode);
    }

    const statusCode = extractErrorCode(errorOrCode);
    if (statusCode !== 0) {
        return ROTATION_ERROR_CODES.includes(statusCode);
    }

    const message = ((errorOrCode as Error)?.message || String(errorOrCode)).toLowerCase();

    return (
        message.includes("quota exceeded") ||
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("high demand") ||
        message.includes("service unavailable") ||
        message.includes("failed to parse stream") ||
        message.includes("api key not valid") ||
        message.includes("api_key_invalid") ||
        message.includes("resource_exhausted") ||
        message.includes("fetch failed") ||
        message.includes("econnreset") ||
        message.includes("socket hang up") ||
        message.includes("und_err_connect_timeout") ||
        message.includes("overloaded")
    );
}

// =========================================================================
// Distributed Circuit Breaker Management (Redis-backed Model Failover)
// =========================================================================

/**
 * Check if the Circuit Breaker is currently OPEN for a given AI model.
 * If open, requests immediately bypass the primary model and route to fallback.
 */
export async function isModelCircuitOpen(modelName: string): Promise<boolean> {
    if (!modelName) return false;
    try {
        const state = await redis.get<string>(`${CIRCUIT_BREAKER_PREFIX}${modelName}`);
        return state === "open";
    } catch {
        return false;
    }
}

/**
 * Trip the Circuit Breaker for an overloaded model in Redis.
 * Sets a TTL (default: 1 hour) during which requests will automatically use the fallback model.
 * 
 * @param modelName - The identifier of the overloaded model (e.g. "gemini-3.7-flash")
 * @param ttlSeconds - Optional duration in seconds (default: 3600s = 1 hour)
 */
export async function tripModelCircuit(
    modelName: string,
    ttlSeconds = DEFAULT_CIRCUIT_TTL_SECONDS
): Promise<void> {
    if (!modelName) return;
    try {
        const key = `${CIRCUIT_BREAKER_PREFIX}${modelName}`;
        await redis.set(key, "open");
        await redis.expire(key, ttlSeconds);
        console.log(`[Circuit Breaker] Model '${modelName}' marked as OVERLOADED in Upstash Redis (Circuit OPEN for ${ttlSeconds}s)`);
    } catch (err) {
        console.warn(`[Circuit Breaker] Failed to trip circuit in Redis for model '${modelName}':`, err);
    }
}

/**
 * Record a 503 / High Demand failure for a model.
 * If a model fails consecutively, trips the Circuit Breaker in Redis for 1 hour.
 */
export async function recordModelFailure(modelName: string): Promise<void> {
    if (!modelName) return;
    try {
        const failureKey = `${MODEL_FAILURES_PREFIX}${modelName}`;
        const count = await redis.incr(failureKey);
        await redis.expire(failureKey, 300); // 5-minute sliding window

        console.log(`[Circuit Breaker] Model '${modelName}' failure count: ${count}/2`);

        if (count >= 2) {
            await tripModelCircuit(modelName);
        }
    } catch {
        // Direct trip fallback if counter fails
        await tripModelCircuit(modelName);
    }
}

/**
 * Reset the Circuit Breaker for a model (e.g. when testing or recovering).
 */
export async function resetModelCircuit(modelName: string): Promise<void> {
    if (!modelName) return;
    try {
        await redis.del(`${CIRCUIT_BREAKER_PREFIX}${modelName}`);
        await redis.del(`${MODEL_FAILURES_PREFIX}${modelName}`);
    } catch {
        // Ignore reset error
    }
}

/**
 * Get current rotation status for monitoring and diagnostics.
 */
export async function getRotationStatus(): Promise<{
    currentKeyIndex: number;
    totalKeys: number;
    usageCount: number;
    requestsPerKey: number;
}> {
    const keys = getApiKeys();
    const requestsPerKey = getRequestsPerKey();

    let currentIndex = 0;
    let usageCount = 0;

    try {
        currentIndex = (await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX)) ?? 0;
        const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
        usageCount = (await redis.get<number>(usageKey)) ?? 0;
    } catch {
        // Fallback to local default
    }

    return {
        currentKeyIndex: currentIndex,
        totalKeys: keys.length,
        usageCount,
        requestsPerKey,
    };
}

// Backward compatibility helpers
export async function getRotatedApiKey(): Promise<string> {
    const { key } = await getApiKeyForRequest();
    return key;
}

export async function forceKeyRotation(): Promise<void> {
    await forceKeyRotationAndGetKey();
}
