import { redis, REDIS_KEYS } from "../redis";

// =========================================================================
// Configuration & Constants
// =========================================================================
export const TWENTY_FOUR_HOURS_IN_SECONDS = 86400; // 24 hours per key lifecycle
const DEFAULT_MAX_REQUESTS_PER_KEY = 20;
const CIRCUIT_BREAKER_PREFIX = "gemini:circuit_breaker:";
const MODEL_FAILURES_PREFIX = "gemini:model_failures:";
const KEY_COOLDOWN_PREFIX = "gemini:key_cooldown:";
const KEY_DISABLED_PREFIX = "gemini:key_disabled:";
const CIRCUIT_PROBE_PREFIX = "gemini:circuit_probe:";

export const DEFAULT_CIRCUIT_TTL_SECONDS = 600; // 10 minutes circuit cooldown on repeated failures
export const DEFAULT_KEY_COOLDOWN_SECONDS = 300; // 5 minutes key cooldown on 429 rate limit
export const PROBE_LOCK_TTL_SECONDS = 300; // 5 minutes (300s) cooldown lock for single probe in half-open state

/**
 * Technical HTTP error codes that trigger key rotation.
 */
export const ROTATION_ERROR_CODES = [
    401, // Unauthorized / Invalid API Key
    403, // Forbidden / Quota exceeded
    429, // Too Many Requests / Rate limit reached
    500, // Internal Server Error
    502, // Bad Gateway
    503, // Service Unavailable / High demand
    504, // Gateway Timeout
];

// =========================================================================
// Type Definitions
// =========================================================================
export type KeyStatus = "healthy" | "exhausted" | "cooldown" | "disabled";
export type CircuitState = "closed" | "open" | "half-open";
export type GeminiErrorCategory =
    | "quota"
    | "authentication"
    | "overload"
    | "transient"
    | "invalid_request"
    | "cancelled"
    | "unknown";

export interface GeminiErrorClassification {
    category: GeminiErrorCategory;
    statusCode: number;
    retryableWithKey: boolean;
    retryableWithModel: boolean;
    reason: string;
}

export interface KeyInfo {
    key: string;
    index: number;
    status?: KeyStatus;
}

export interface KeyStateInfo {
    index: number;
    status: KeyStatus;
    usageCount: number;
    requestsPerKey: number;
    remainingTtlSeconds: number;
    reason: string;
    disabled: boolean;
    cooldownRemainingSeconds?: number;
}

// =========================================================================
// Custom Errors
// =========================================================================

/**
 * Custom Error thrown when Redis is unavailable, enforcing a strict Fail-Closed policy
 * for quota-sensitive operations.
 */
export class RedisUnavailableError extends Error {
    public readonly cause?: unknown;

    constructor(operation: string, cause?: unknown) {
        super(`Redis service unavailable during ${operation}. Enforcing fail-closed policy for quota protection.`);
        this.name = "RedisUnavailableError";
        this.cause = cause;
    }
}

/**
 * Custom Error thrown when all API keys in the rotation pool have exhausted their quota or are in cooldown.
 */
export class AllKeysExhaustedError extends Error {
    public readonly minRemainingTtlSeconds: number;
    public readonly retryAfter: number;
    public readonly keyStates?: KeyStateInfo[];

    constructor(minRemainingTtlSeconds: number, keyStates?: KeyStateInfo[]) {
        const remainingMinutes = Math.max(1, Math.ceil(minRemainingTtlSeconds / 60));
        const remainingHours = (minRemainingTtlSeconds / 3600).toFixed(1);
        super(
            `All configured Gemini API keys are currently exhausted, in cooldown, or disabled. Cooldown active. Next key unlocks in ~${remainingHours}h (${remainingMinutes}m).`
        );
        this.name = "AllKeysExhaustedError";
        this.minRemainingTtlSeconds = minRemainingTtlSeconds;
        this.retryAfter = minRemainingTtlSeconds;
        this.keyStates = keyStates;
    }
}

/**
 * Custom Error thrown when circuit breaker is OPEN and no fallback model is configured.
 */
export class CircuitBreakerOpenError extends Error {
    public readonly modelName: string;
    public readonly retryAfter: number;

    constructor(modelName: string, retryAfter = DEFAULT_CIRCUIT_TTL_SECONDS) {
        super(`Circuit Breaker is OPEN for model '${modelName}'. High server demand.`);
        this.name = "CircuitBreakerOpenError";
        this.modelName = modelName;
        this.retryAfter = retryAfter;
    }
}

// =========================================================================
// Sanitization & Security Helpers
// =========================================================================

/**
 * Mask an API key to safely include in logs or error diagnostics without exposing sensitive credentials.
 * E.g., "AIzaSyD-1234567890abcdef" -> "AIza...cdef"
 */
export function maskApiKey(key?: string): string {
    if (!key || typeof key !== "string") return "unknown_key";
    const trimmed = key.trim();
    if (trimmed.length <= 8) return "***masked***";
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Sanitize error messages to ensure no raw API keys or sensitive query parameters leak into logs.
 */
export function sanitizeErrorMessage(message?: string): string {
    if (!message || typeof message !== "string") return "";
    return message
        .replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]")
        .replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED_API_KEY]");
}

// =========================================================================
// Environment & Configuration Helpers
// =========================================================================

/**
 * Retrieve all valid API keys configured in the environment.
 * Supports GEMINI_KEY_1 through GEMINI_KEY_20 and filters placeholders/empty entries.
 */
export function getApiKeys(): string[] {
    const keys: string[] = [];
    for (let i = 1; i <= 20; i++) {
        const key = process.env[`GEMINI_KEY_${i}`];
        if (key && typeof key === "string") {
            const trimmed = key.trim().replace(/^["']|["']$/g, ""); // Strip surrounding quotes
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

// =========================================================================
// Error Classification & Extraction
// =========================================================================

/**
 * Extract HTTP status code from error object or message string with high precision,
 * avoiding accidental false positives on user content numbers (e.g. document IDs).
 */
export function extractErrorCode(error: unknown): number {
    if (error === null || error === undefined) return 0;
    if (typeof error === "object" && error !== null) {
        if ("status" in error && typeof (error as any).status === "number") {
            return (error as any).status;
        }
        if ("statusCode" in error && typeof (error as any).statusCode === "number") {
            return (error as any).statusCode;
        }
        if ("code" in error && typeof (error as any).code === "number") {
            return (error as any).code;
        }
        if ("response" in error && typeof (error as any).response === "object" && (error as any).response !== null) {
            const resp = (error as any).response;
            if (typeof resp.status === "number") return resp.status;
            if (typeof resp.statusCode === "number") return resp.statusCode;
        }
    }
    const errorMessage = (error as Error)?.message || String(error);

    // 1. Explicit HTTP error prefixes to prevent false positives on random payload numbers
    const explicitStatusMatch = errorMessage.match(
        /(?:status|statusCode|http|error|code|api|returned|failed with|\[)\s*[:=]?\s*(400|401|403|404|429|500|502|503|504)\b/i
    );
    if (explicitStatusMatch) {
        return parseInt(explicitStatusMatch[1], 10);
    }

    // 2. Standalone error code at start or end of string
    const standaloneMatch = errorMessage.match(
        /^\s*(400|401|403|404|429|500|502|503|504)\b|\b(400|401|403|404|429|500|502|503|504)\s*$/
    );
    if (standaloneMatch) {
        return parseInt(standaloneMatch[1] || standaloneMatch[2], 10);
    }

    // 3. Fallback boundary search
    const boundaryMatch = errorMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    return boundaryMatch ? parseInt(boundaryMatch[1], 10) : 0;
}

/**
 * Classify Gemini and network errors into structured categories.
 * Enforces non-rotation for unfixable errors (e.g. 400 Bad Request, validation faults).
 */
export function classifyGeminiError(error: unknown): GeminiErrorClassification {
    if (error === null || error === undefined) {
        return {
            category: "unknown",
            statusCode: 0,
            retryableWithKey: false,
            retryableWithModel: false,
            reason: "Unknown error",
        };
    }

    const statusCode = extractErrorCode(error);
    const errorObj = error as Error;
    const message = (errorObj?.message || String(error)).toLowerCase();
    const errorName = (errorObj?.name || "").toLowerCase();

    // Check for Abort / Cancellation
    if (
        errorName.includes("abort") ||
        message.includes("aborted") ||
        message.includes("cancelled") ||
        message.includes("canceled")
    ) {
        return {
            category: "cancelled",
            statusCode: 499,
            retryableWithKey: false,
            retryableWithModel: false,
            reason: "Request cancelled by client",
        };
    }

    // Check for 400 Bad Request / Invalid Argument / Safety Filters (Non-recoverable with another key)
    if (
        statusCode === 400 ||
        message.includes("invalid argument") ||
        message.includes("bad request") ||
        message.includes("content moderation") ||
        message.includes("safety rating") ||
        message.includes("invalid json") ||
        message.includes("malformed")
    ) {
        return {
            category: "invalid_request",
            statusCode: 400,
            retryableWithKey: false,
            retryableWithModel: false,
            reason: "Invalid client request or moderation block (non-rotatable)",
        };
    }

    // Check for 401 Unauthorized / Invalid API Key
    if (
        statusCode === 401 ||
        message.includes("api key not valid") ||
        message.includes("api_key_invalid") ||
        message.includes("unauthorized") ||
        message.includes("invalid api key")
    ) {
        return {
            category: "authentication",
            statusCode: 401,
            retryableWithKey: true,
            retryableWithModel: false,
            reason: "API key invalid or unauthorized",
        };
    }

    // Check for 429 / Resource Exhausted (Quota & Rate limits)
    if (
        statusCode === 429 ||
        statusCode === 403 ||
        message.includes("quota exceeded") ||
        message.includes("rate limit") ||
        message.includes("too many requests") ||
        message.includes("resource_exhausted")
    ) {
        return {
            category: "quota",
            statusCode: statusCode || 429,
            retryableWithKey: true,
            retryableWithModel: false,
            reason: "API key quota or rate limit exceeded",
        };
    }

    // Check for 503 / High Demand / Overloaded Model
    if (
        statusCode === 503 ||
        message.includes("503") ||
        message.includes("high demand") ||
        message.includes("service unavailable") ||
        message.includes("overloaded") ||
        message.includes("failed to parse stream")
    ) {
        return {
            category: "overload",
            statusCode: 503,
            retryableWithKey: false,
            retryableWithModel: true,
            reason: "AI Model is currently overloaded or experiencing high demand",
        };
    }

    // Check for 500/502/504 or Transient Network errors
    if (
        statusCode === 500 ||
        statusCode === 502 ||
        statusCode === 504 ||
        message.includes("fetch failed") ||
        message.includes("econnreset") ||
        message.includes("socket hang up") ||
        message.includes("und_err_connect_timeout") ||
        message.includes("timeout") ||
        message.includes("econnrefused") ||
        message.includes("network error")
    ) {
        return {
            category: "transient",
            statusCode: statusCode || 500,
            retryableWithKey: true,
            retryableWithModel: false,
            reason: "Transient network or upstream gateway error",
        };
    }

    return {
        category: "unknown",
        statusCode: statusCode || 0,
        retryableWithKey: shouldRotateOnError(statusCode),
        retryableWithModel: false,
        reason: "Unclassified error",
    };
}

/**
 * Check if the error is specifically a 503 / High Demand / Overloaded server error.
 */
export function is503OrOverloadError(errorOrCode: unknown): boolean {
    if (typeof errorOrCode === "number") {
        return errorOrCode === 503;
    }
    const classification = classifyGeminiError(errorOrCode);
    return classification.category === "overload";
}

/**
 * Determine whether an error is rotatable to another API key.
 * Strictly excludes 400 Bad Request, client cancellations, and safety blocks.
 */
export function shouldRotateOnError(errorOrCode: unknown): boolean {
    if (typeof errorOrCode === "number") {
        return ROTATION_ERROR_CODES.includes(errorOrCode);
    }
    const classification = classifyGeminiError(errorOrCode);
    return classification.retryableWithKey;
}

// =========================================================================
// Key State Management (Healthy, Exhausted, Cooldown, Disabled)
// =========================================================================

/**
 * Inspect individual key state in Redis.
 * Enforces Fail-Closed behavior if Redis connection fails.
 */
export async function getKeyState(keyIndex: number): Promise<KeyStateInfo> {
    const requestsPerKey = getRequestsPerKey();
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${keyIndex}`;
    const cooldownKey = `${KEY_COOLDOWN_PREFIX}${keyIndex}`;
    const disabledKey = `${KEY_DISABLED_PREFIX}${keyIndex}`;

    let usageCount = 0;
    let remainingTtlSeconds = 0;
    let isDisabled = false;
    let cooldownRemaining = 0;

    try {
        const [usage, usageTtl, disabledVal, cooldownTtl] = await Promise.all([
            redis.get<number>(usageKey),
            redis.ttl(usageKey),
            redis.get<string>(disabledKey),
            redis.ttl(cooldownKey),
        ]);

        if (typeof usage === "number" && !isNaN(usage)) usageCount = usage;
        if (typeof usageTtl === "number" && usageTtl > 0) remainingTtlSeconds = usageTtl;
        isDisabled = Boolean(disabledVal);
        if (typeof cooldownTtl === "number" && cooldownTtl > 0) cooldownRemaining = cooldownTtl;
    } catch (redisErr) {
        console.warn(`[Key Rotation] Redis inspection error for key #${keyIndex + 1}:`, redisErr);
        throw new RedisUnavailableError(`inspecting key state #${keyIndex + 1}`, redisErr);
    }

    if (isDisabled) {
        return {
            index: keyIndex,
            status: "disabled",
            usageCount,
            requestsPerKey,
            remainingTtlSeconds: remainingTtlSeconds || TWENTY_FOUR_HOURS_IN_SECONDS,
            reason: "Key permanently disabled (401 Authentication Failure)",
            disabled: true,
        };
    }

    if (cooldownRemaining > 0) {
        return {
            index: keyIndex,
            status: "cooldown",
            usageCount,
            requestsPerKey,
            remainingTtlSeconds: Math.max(cooldownRemaining, remainingTtlSeconds),
            reason: "Key in temporary cooldown (429 Rate Limit)",
            disabled: false,
            cooldownRemainingSeconds: cooldownRemaining,
        };
    }

    if (usageCount >= requestsPerKey) {
        return {
            index: keyIndex,
            status: "exhausted",
            usageCount,
            requestsPerKey,
            remainingTtlSeconds: remainingTtlSeconds || TWENTY_FOUR_HOURS_IN_SECONDS,
            reason: "Key daily request limit reached (20/20)",
            disabled: false,
        };
    }

    return {
        index: keyIndex,
        status: "healthy",
        usageCount,
        requestsPerKey,
        remainingTtlSeconds,
        reason: "Key is active and healthy",
        disabled: false,
    };
}

/**
 * Mark a key in temporary cooldown (e.g. after receiving a 429 rate limit).
 */
export async function markKeyCooldown(
    keyIndex: number,
    ttlSeconds = DEFAULT_KEY_COOLDOWN_SECONDS,
    reason = "Rate limited"
): Promise<void> {
    try {
        const cooldownKey = `${KEY_COOLDOWN_PREFIX}${keyIndex}`;
        await redis.set(cooldownKey, reason);
        await redis.expire(cooldownKey, ttlSeconds);
        console.log(`[Key Rotation] Key #${keyIndex + 1} placed in COOLDOWN for ${ttlSeconds}s (Reason: ${reason})`);
    } catch (err) {
        console.warn(`[Key Rotation] Failed to set cooldown for key #${keyIndex + 1}:`, err);
    }
}

/**
 * Mark a key as disabled (e.g. after receiving a 401 unauthorized / invalid key).
 */
export async function markKeyDisabled(
    keyIndex: number,
    reason = "Invalid API Key (401)"
): Promise<void> {
    try {
        const disabledKey = `${KEY_DISABLED_PREFIX}${keyIndex}`;
        await redis.set(disabledKey, reason);
        await redis.expire(disabledKey, TWENTY_FOUR_HOURS_IN_SECONDS);
        console.warn(`[Key Rotation] Key #${keyIndex + 1} DISABLED in Redis (Reason: ${reason})`);
    } catch (err) {
        console.warn(`[Key Rotation] Failed to disable key #${keyIndex + 1}:`, err);
    }
}

/**
 * Select a healthy API key for request execution with Fast-Path and Batch inspection.
 * Usage is atomically incremented only on confirmed success via confirmApiKeyUsage().
 */
export async function getApiKeyForRequest(): Promise<KeyInfo> {
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
    } catch (redisErr) {
        console.warn("[Key Rotation] Redis read error for current_key_index:", redisErr);
        throw new RedisUnavailableError("reading current key index", redisErr);
    }

    if (currentIndex >= keys.length || currentIndex < 0) {
        currentIndex = 0;
        try {
            await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, 0);
        } catch {
            // Ignore write error
        }
    }

    // 1. Fast-Path: Check the active current index first
    const currentState = await getKeyState(currentIndex);
    if (currentState.status === "healthy") {
        return {
            key: keys[currentIndex],
            index: currentIndex,
            status: "healthy",
        };
    }

    // 2. Batch Inspection: Concurrently inspect all keys in a single parallel batch
    const allStates = await Promise.all(keys.map((_, i) => getKeyState(i)));

    let minRemainingTtl = TWENTY_FOUR_HOURS_IN_SECONDS;
    for (let offset = 0; offset < keys.length; offset++) {
        const checkIndex = (currentIndex + offset) % keys.length;
        const state = allStates[checkIndex];

        if (state.status === "healthy") {
            if (checkIndex !== currentIndex) {
                try {
                    await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, checkIndex);
                } catch {
                    // Ignore write error
                }
            }
            return {
                key: keys[checkIndex],
                index: checkIndex,
                status: "healthy",
            };
        }

        if (state.remainingTtlSeconds > 0 && state.remainingTtlSeconds < minRemainingTtl) {
            minRemainingTtl = state.remainingTtlSeconds;
        }
    }

    // All keys are exhausted, in cooldown, or disabled
    throw new AllKeysExhaustedError(minRemainingTtl, allStates);
}

/**
 * Confirm API key usage after a successful response chunk or completion.
 * Atomically increments the Redis usage counter and starts the fixed 24h TTL clock on the first request.
 */
export async function confirmApiKeyUsage(keyIndex: number): Promise<void> {
    const keys = getApiKeys();
    if (keyIndex < 0 || keyIndex >= keys.length) return;

    const requestsPerKey = getRequestsPerKey();
    const usageKey = `${REDIS_KEYS.USAGE_COUNT_PREFIX}${keyIndex}`;

    try {
        const newCount = await redis.incr(usageKey);
        console.log(`[Key Rotation] Key #${keyIndex + 1}/${keys.length} usage: ${newCount}/${requestsPerKey}`);

        if (newCount === 1) {
            await redis.expire(usageKey, TWENTY_FOUR_HOURS_IN_SECONDS);
            console.log(`[Key Rotation] Key #${keyIndex + 1} initialized 24-hour quota window (${TWENTY_FOUR_HOURS_IN_SECONDS}s).`);
        } else {
            const currentTtl = await redis.ttl(usageKey);
            if (currentTtl < 0) {
                await redis.expire(usageKey, TWENTY_FOUR_HOURS_IN_SECONDS);
            }
        }

        if (newCount >= requestsPerKey) {
            const ttl = await redis.ttl(usageKey);
            const remainingHours = ttl > 0 ? (ttl / 3600).toFixed(1) : "24";
            console.log(`[Key Rotation] Key #${keyIndex + 1} reached limit (${newCount}/${requestsPerKey}). Cooldown active for remaining ${remainingHours}h.`);
        }
    } catch (redisErr) {
        console.warn(`[Key Rotation] Failed to increment usage counter for key #${keyIndex + 1}:`, redisErr);
    }
}

/**
 * Force immediate rotation to the next healthy key in the pool and update Redis.
 * Handles state transitions based on the triggering error (e.g. 401 disables, 429 sets cooldown).
 */
export async function forceKeyRotationAndGetKey(lastError?: unknown): Promise<KeyInfo> {
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
    } catch (redisErr) {
        throw new RedisUnavailableError("reading current key index during forced rotation", redisErr);
    }

    // Apply error-specific state transition to current key
    if (lastError) {
        const classification = classifyGeminiError(lastError);
        if (classification.category === "authentication") {
            await markKeyDisabled(currentIndex, classification.reason);
        } else if (classification.category === "quota") {
            await markKeyCooldown(currentIndex, DEFAULT_KEY_COOLDOWN_SECONDS, classification.reason);
        }
    }

    // Batch inspect all states concurrently
    const allStates = await Promise.all(keys.map((_, i) => getKeyState(i)));

    let minRemainingTtl = TWENTY_FOUR_HOURS_IN_SECONDS;
    for (let offset = 1; offset <= keys.length; offset++) {
        const nextIndex = (currentIndex + offset) % keys.length;
        const state = allStates[nextIndex];

        if (state.status === "healthy") {
            try {
                await redis.set(REDIS_KEYS.CURRENT_KEY_INDEX, nextIndex);
            } catch (redisErr) {
                console.warn("[Key Rotation] Redis write error during forced rotation:", redisErr);
            }
            console.log(`[Key Rotation] FORCED rotation from key #${currentIndex + 1} to healthy key #${nextIndex + 1}`);
            return {
                key: keys[nextIndex],
                index: nextIndex,
                status: "healthy",
            };
        }

        if (state.remainingTtlSeconds > 0 && state.remainingTtlSeconds < minRemainingTtl) {
            minRemainingTtl = state.remainingTtlSeconds;
        }
    }

    throw new AllKeysExhaustedError(minRemainingTtl, allStates);
}

// =========================================================================
// Distributed 3-State Circuit Breaker Management (Redis-backed)
// =========================================================================

/**
 * Get the current Circuit Breaker state for a specific AI model.
 * States:
 * - 'closed': Normal state, primary model operates smoothly.
 * - 'open': Repeated failures occurred; primary model is bypassed to fallback.
 * - 'half-open': Cooldown expired; single probe lock is permitted to verify health.
 */
export async function getModelCircuitState(modelName: string): Promise<CircuitState> {
    if (!modelName) return "closed";
    try {
        const stateKey = `${CIRCUIT_BREAKER_PREFIX}${modelName}`;
        const stateVal = await redis.get<string>(stateKey);

        if (stateVal === "open") {
            return "open";
        }

        const failuresKey = `${MODEL_FAILURES_PREFIX}${modelName}`;
        const failureCount = await redis.get<number>(failuresKey);

        if (typeof failureCount === "number" && failureCount >= 2) {
            return "half-open";
        }

        return "closed";
    } catch (err) {
        console.warn(`[Circuit Breaker] Error reading circuit state for '${modelName}':`, err);
        return "closed";
    }
}

/**
 * Check if the Circuit Breaker is currently OPEN (or non-probing half-open) for a given AI model.
 */
export async function isModelCircuitOpen(modelName: string): Promise<boolean> {
    const state = await getModelCircuitState(modelName);
    return state === "open";
}

/**
 * Attempt to acquire the single-probe lock when circuit is in HALF-OPEN state.
 * Uses atomic SET NX with EX (5 minutes = 300s) to prevent TOCTOU race conditions under high concurrency.
 */
export async function tryAcquireHalfOpenProbe(modelName: string): Promise<boolean> {
    if (!modelName) return false;
    try {
        const probeKey = `${CIRCUIT_PROBE_PREFIX}${modelName}`;
        // Atomic single-command acquisition (SET key value NX EX seconds)
        const acquired = await redis.set(probeKey, "probing", {
            nx: true,
            ex: PROBE_LOCK_TTL_SECONDS,
        });

        return acquired === "OK";
    } catch {
        return false;
    }
}

/**
 * Explicitly release the probe lock for a model.
 */
export async function releaseProbeLock(modelName: string): Promise<void> {
    if (!modelName) return;
    try {
        const probeKey = `${CIRCUIT_PROBE_PREFIX}${modelName}`;
        await redis.del(probeKey);
    } catch {
        // Ignore deletion error
    }
}

/**
 * Record a successful execution on a model.
 * Resets the circuit breaker, failure counts, and probe locks to CLOSED state.
 */
export async function recordModelSuccess(modelName: string): Promise<void> {
    if (!modelName) return;
    try {
        const stateKey = `${CIRCUIT_BREAKER_PREFIX}${modelName}`;
        const failuresKey = `${MODEL_FAILURES_PREFIX}${modelName}`;
        const probeKey = `${CIRCUIT_PROBE_PREFIX}${modelName}`;

        await Promise.all([
            redis.del(stateKey),
            redis.del(failuresKey),
            redis.del(probeKey),
        ]);
    } catch {
        // Ignore reset error
    }
}

/**
 * Trip the Circuit Breaker for an overloaded model in Redis.
 * Transitions state to 'open' with backoff TTL.
 */
export async function tripModelCircuit(
    modelName: string,
    ttlSeconds = DEFAULT_CIRCUIT_TTL_SECONDS
): Promise<void> {
    if (!modelName) return;
    try {
        const stateKey = `${CIRCUIT_BREAKER_PREFIX}${modelName}`;
        const failuresKey = `${MODEL_FAILURES_PREFIX}${modelName}`;
        const probeKey = `${CIRCUIT_PROBE_PREFIX}${modelName}`;

        await redis.set(stateKey, "open");
        await redis.expire(stateKey, ttlSeconds);
        await redis.set(failuresKey, 2);
        await redis.expire(failuresKey, ttlSeconds * 2);
        await redis.del(probeKey);

        console.log(`[Circuit Breaker] Model '${modelName}' marked as OVERLOADED in Upstash Redis (Circuit OPEN for ${ttlSeconds}s)`);
    } catch (err) {
        console.warn(`[Circuit Breaker] Failed to trip circuit in Redis for model '${modelName}':`, err);
    }
}

/**
 * Record a 503 / High Demand failure for a model.
 * If a model fails consecutively (>= 2), trips the Circuit Breaker in Redis.
 */
export async function recordModelFailure(modelName: string): Promise<void> {
    if (!modelName) return;
    try {
        const failuresKey = `${MODEL_FAILURES_PREFIX}${modelName}`;
        const count = await redis.incr(failuresKey);
        await redis.expire(failuresKey, 300); // 5-minute sliding window

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
 * Reset the Circuit Breaker for a model (e.g. when testing or manual recovery).
 */
export async function resetModelCircuit(modelName: string): Promise<void> {
    await recordModelSuccess(modelName);
}

// =========================================================================
// Monitoring & Diagnostics
// =========================================================================

/**
 * Get current rotation status and pool health diagnostics.
 */
export async function getRotationStatus(): Promise<{
    currentKeyIndex: number;
    totalKeys: number;
    usageCount: number;
    requestsPerKey: number;
    keyStates?: KeyStateInfo[];
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
