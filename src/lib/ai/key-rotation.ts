import { redis, REDIS_KEYS } from "../redis";

// Constants
const ONE_HOUR_IN_SECONDS = 3600;
const MAX_REQUESTS_PER_KEY = 20;

/**
 * Technical error codes that should trigger automatic key rotation.
 * These include rate limits, server errors, and authentication issues.
 */
export const ROTATION_ERROR_CODES = [
    400, // Bad Request - malformed request
    401, // Unauthorized - invalid API key
    403, // Forbidden - API key blocked or quota exceeded
    429, // Too Many Requests - rate limit exceeded
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable
    504, // Gateway Timeout
];

// Get all API keys from environment
function getApiKeys(): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= 10; i++) {
        const key = process.env[`GEMINI_KEY_${i}`];
        if (key) {
            keys.push(key);
        }
    }
    return keys;
}

// Get the requests per key limit from environment
function getRequestsPerKey(): number {
    return parseInt(process.env.GEMINI_REQUESTS_PER_KEY || String(MAX_REQUESTS_PER_KEY), 10);
}

/**
 * Key Rotation Information returned when getting a key for request
 */
export interface KeyInfo {
    key: string;
    index: number;
}

/**
 * Get an API key for making a request WITHOUT incrementing the counter.
 * The counter should only be incremented after a successful request using confirmApiKeyUsage().
 * 
 * Algorithm:
 * 1. Get current key index from Redis
 * 2. Get usage count for current key
 * 3. If usage >= limit, rotate to next key and set TTL on old counter
 * 4. Return current key WITHOUT incrementing
 */
export async function getApiKeyForRequest(): Promise<KeyInfo> {
    const keys = getApiKeys();
    const requestsPerKey = getRequestsPerKey();

    if (keys.length === 0) {
        throw new Error("No Gemini API keys configured");
    }

    // Get current key index (default to 0)
    let currentIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX) ?? 0;

    // Ensure index is within bounds
    if (currentIndex >= keys.length) {
        currentIndex = 0;
        await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, currentIndex);
    }

    // Get usage count for current key
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
    const usageCount = await redis.get<number>(usageKey) ?? 0;

    // Check if we need to rotate (counter reached limit)
    if (usageCount >= requestsPerKey) {
        // Set TTL on the OLD counter - it will be deleted after 1 hour
        await redis.expire(usageKey, ONE_HOUR_IN_SECONDS);

        // Rotate to next key
        const oldIndex = currentIndex;
        currentIndex = (currentIndex + 1) % keys.length;

        // Update index in Redis
        await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, currentIndex);

        // Reset usage count for new key (start fresh)
        const newUsageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
        await redis.set(newUsageKey, 0);

        console.log(`[Key Rotation] Rotated from key ${oldIndex} to key ${currentIndex} (limit reached: ${requestsPerKey})`);
    }

    return {
        key: keys[currentIndex],
        index: currentIndex,
    };
}

/**
 * Confirm API key usage after a SUCCESSFUL request.
 * This increments the usage counter only when the request succeeded.
 * If the counter reaches the limit, it triggers rotation for the NEXT request.
 * 
 * @param keyIndex - The index of the key that was used
 */
export async function confirmApiKeyUsage(keyIndex: number): Promise<void> {
    const requestsPerKey = getRequestsPerKey();
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${keyIndex}`;

    // Increment usage count
    const newCount = await redis.incr(usageKey);

    console.log(`[Key Rotation] Key ${keyIndex} usage: ${newCount}/${requestsPerKey}`);

    // If we just hit the limit, prepare for rotation on next request
    // Set TTL now so the counter gets cleaned up after 1 hour
    if (newCount >= requestsPerKey) {
        await redis.expire(usageKey, ONE_HOUR_IN_SECONDS);
        console.log(`[Key Rotation] Key ${keyIndex} reached limit. TTL set for ${ONE_HOUR_IN_SECONDS}s. Next request will use a new key.`);
    }
}

/**
 * Force rotation to next key and return the new key info.
 * Called when API returns error codes like 429 (rate limit), 403, 500, 503, etc.
 * This is used for automatic retry with a different key.
 * 
 * NOTE: TTL is NOT set here - it is only set when a counter reaches the limit (20).
 * Force rotation simply moves to the next key without affecting counter TTL.
 * 
 * @returns The new key information for immediate retry
 */
export async function forceKeyRotationAndGetKey(): Promise<KeyInfo> {
    const keys = getApiKeys();

    if (keys.length === 0) {
        throw new Error("No Gemini API keys configured");
    }

    // Get current index
    const currentIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX) ?? 0;

    // Rotate to next key (NO TTL is set here - TTL only when counter reaches 20)
    const newIndex = (currentIndex + 1) % keys.length;

    // Update index in Redis
    await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, newIndex);

    // Reset usage count for new key
    const newUsageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${newIndex}`;
    await redis.set(newUsageKey, 0);

    console.log(`[Key Rotation] FORCED rotation from key ${currentIndex} to key ${newIndex}`);

    return {
        key: keys[newIndex],
        index: newIndex,
    };
}

/**
 * Check if an error code should trigger key rotation
 * 
 * @param statusCode - HTTP status code from the error
 * @returns true if the key should be rotated
 */
export function shouldRotateOnError(statusCode: number): boolean {
    return ROTATION_ERROR_CODES.includes(statusCode);
}

/**
 * Extract HTTP status code from error message
 * 
 * @param error - The error object or message
 * @returns The extracted status code, or 0 if not found
 */
export function extractErrorCode(error: unknown): number {
    const errorMessage = (error as Error)?.message || String(error);
    const statusMatch = errorMessage.match(/(\d{3})/);
    return statusMatch ? parseInt(statusMatch[1], 10) : 0;
}

/**
 * Get current rotation status for monitoring
 */
export async function getRotationStatus(): Promise<{
    currentKeyIndex: number;
    totalKeys: number;
    usageCount: number;
    requestsPerKey: number;
}> {
    const keys = getApiKeys();
    const requestsPerKey = getRequestsPerKey();

    const currentIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX) ?? 0;
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${currentIndex}`;
    const usageCount = await redis.get<number>(usageKey) ?? 0;

    return {
        currentKeyIndex: currentIndex,
        totalKeys: keys.length,
        usageCount,
        requestsPerKey,
    };
}

// Legacy export for backward compatibility
// DEPRECATED: Use getApiKeyForRequest() and confirmApiKeyUsage() instead
export async function getRotatedApiKey(): Promise<string> {
    const { key } = await getApiKeyForRequest();
    return key;
}

// Legacy export for backward compatibility
// DEPRECATED: Use forceKeyRotationAndGetKey() instead
export async function forceKeyRotation(): Promise<void> {
    await forceKeyRotationAndGetKey();
}
