import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =========================================================================
// Mock Setup using vi.hoisted for Redis
// =========================================================================
const { mockStore, mockExpires, mockRedis, MOCK_REDIS_KEYS, resetMocks } = vi.hoisted(() => {
    const mockStore: Map<string, unknown> = new Map();
    const mockExpires: Map<string, number> = new Map();

    const defaultTtlImpl = async (key: string) => mockExpires.get(key) ?? -1;
    const defaultGetImpl = async (key: string) => mockStore.get(key) ?? null;
    const defaultSetImpl = async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
        if (options?.nx && mockStore.has(key)) {
            return null; // Atomic NX semantics: cannot set if key exists
        }
        mockStore.set(key, value);
        if (options?.ex) {
            mockExpires.set(key, options.ex);
        }
        return 'OK';
    };
    const defaultDelImpl = async (key: string) => {
        mockStore.delete(key);
        mockExpires.delete(key);
        return 1;
    };
    const defaultIncrImpl = async (key: string) => {
        const current = (mockStore.get(key) as number) ?? 0;
        const newValue = current + 1;
        mockStore.set(key, newValue);
        return newValue;
    };
    const defaultExpireImpl = async (key: string, seconds: number) => {
        mockExpires.set(key, seconds);
        return 1;
    };

    const mockRedis = {
        get: vi.fn(defaultGetImpl),
        set: vi.fn(defaultSetImpl),
        del: vi.fn(defaultDelImpl),
        incr: vi.fn(defaultIncrImpl),
        expire: vi.fn(defaultExpireImpl),
        ttl: vi.fn(defaultTtlImpl),
    };

    const MOCK_REDIS_KEYS = {
        CURRENT_KEY_INDEX: 'gemini:current_key_index',
        USAGE_COUNT_PREFIX: 'gemini:usage_count:',
    };

    const resetMocks = () => {
        mockStore.clear();
        mockExpires.clear();
        vi.clearAllMocks();
        mockRedis.get.mockImplementation(defaultGetImpl);
        mockRedis.set.mockImplementation(defaultSetImpl);
        mockRedis.del.mockImplementation(defaultDelImpl);
        mockRedis.incr.mockImplementation(defaultIncrImpl);
        mockRedis.expire.mockImplementation(defaultExpireImpl);
        mockRedis.ttl.mockImplementation(defaultTtlImpl);
    };

    return { mockStore, mockExpires, mockRedis, MOCK_REDIS_KEYS, resetMocks };
});

// Mock Redis module
vi.mock('../redis', () => ({
    redis: mockRedis,
    REDIS_KEYS: MOCK_REDIS_KEYS,
}));

// Import module under test after setting up mocks
import {
    getApiKeyForRequest,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    extractErrorCode,
    is503OrOverloadError,
    classifyGeminiError,
    maskApiKey,
    sanitizeErrorMessage,
    getKeyState,
    markKeyCooldown,
    markKeyDisabled,
    getModelCircuitState,
    isModelCircuitOpen,
    tryAcquireHalfOpenProbe,
    releaseProbeLock,
    recordModelSuccess,
    recordModelFailure,
    tripModelCircuit,
    resetModelCircuit,
    getRotationStatus,
    AllKeysExhaustedError,
    RedisUnavailableError,
    ROTATION_ERROR_CODES,
    PROBE_LOCK_TTL_SECONDS,
} from './key-rotation';

describe('Key Rotation & Circuit Breaker System (Hardened)', () => {
    beforeEach(() => {
        for (let i = 1; i <= 20; i++) {
            vi.stubEnv(`GEMINI_KEY_${i}`, i <= 3 ? `test-key-secret-${i}` : '');
        }
        vi.stubEnv('GEMINI_REQUESTS_PER_KEY', '20');
        resetMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // =========================================================================
    // Key State Lifecycle (healthy, exhausted, cooldown, disabled)
    // =========================================================================
    describe('Key State Lifecycle', () => {
        it('should report key as healthy by default when under limit', async () => {
            const state = await getKeyState(0);
            expect(state.status).toBe('healthy');
            expect(state.disabled).toBe(false);
            expect(state.usageCount).toBe(0);
        });

        it('should report key as exhausted when usage reaches limit (20)', async () => {
            mockStore.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`, 20);
            mockExpires.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`, 36000);

            const state = await getKeyState(0);
            expect(state.status).toBe('exhausted');
            expect(state.disabled).toBe(false);
            expect(state.reason).toContain('limit reached');
        });

        it('should report key as in cooldown when cooldown TTL is active', async () => {
            await markKeyCooldown(0, 300, 'Rate limit 429');
            mockExpires.set('gemini:key_cooldown:0', 300);

            const state = await getKeyState(0);
            expect(state.status).toBe('cooldown');
            expect(state.cooldownRemainingSeconds).toBe(300);
            expect(state.reason).toContain('temporary cooldown');
        });

        it('should report key as disabled when 401 invalid key flag is set', async () => {
            await markKeyDisabled(0, '401 Unauthorized Key');

            const state = await getKeyState(0);
            expect(state.status).toBe('disabled');
            expect(state.disabled).toBe(true);
            expect(state.reason).toContain('permanently disabled');
        });

        it('should enforce Fail-Closed policy and throw RedisUnavailableError on Redis failure', async () => {
            mockRedis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            await expect(getKeyState(0)).rejects.toThrow(RedisUnavailableError);
        });
    });

    // =========================================================================
    // Key Selection & Fast-Path / Batch Rotation
    // =========================================================================
    describe('getApiKeyForRequest', () => {
        it('should return current key directly via Fast-Path when healthy', async () => {
            const result = await getApiKeyForRequest();
            expect(result.key).toBe('test-key-secret-1');
            expect(result.index).toBe(0);
            expect(result.status).toBe('healthy');
        });

        it('should skip disabled keys and select next healthy key', async () => {
            await markKeyDisabled(0, 'Invalid API Key');

            const result = await getApiKeyForRequest();
            expect(result.index).toBe(1);
            expect(result.key).toBe('test-key-secret-2');
        });

        it('should skip keys in cooldown and select next healthy key', async () => {
            await markKeyCooldown(0, 300, '429 Rate Limit');
            mockExpires.set('gemini:key_cooldown:0', 300);

            const result = await getApiKeyForRequest();
            expect(result.index).toBe(1);
            expect(result.key).toBe('test-key-secret-2');
        });

        it('should skip exhausted keys and select next healthy key', async () => {
            mockStore.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`, 20);

            const result = await getApiKeyForRequest();
            expect(result.index).toBe(1);
            expect(result.key).toBe('test-key-secret-2');
        });

        it('should throw AllKeysExhaustedError with retryAfter when all keys unavailable', async () => {
            mockStore.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`, 20);
            mockExpires.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`, 1200);

            await markKeyCooldown(1, 300, '429 Rate limit');
            mockExpires.set('gemini:key_cooldown:1', 300);

            await markKeyDisabled(2, '401 Invalid Key');

            try {
                await getApiKeyForRequest();
                expect.unreachable('Should have thrown AllKeysExhaustedError');
            } catch (err: any) {
                expect(err).toBeInstanceOf(AllKeysExhaustedError);
                expect(err.name).toBe('AllKeysExhaustedError');
                expect(err.retryAfter).toBe(300); // Minimum remaining cooldown TTL
                expect(err.keyStates).toHaveLength(3);
            }
        });

        it('should throw error when no API keys are configured', async () => {
            vi.stubEnv('GEMINI_KEY_1', '');
            vi.stubEnv('GEMINI_KEY_2', '');
            vi.stubEnv('GEMINI_KEY_3', '');

            await expect(getApiKeyForRequest()).rejects.toThrow('No Gemini API keys configured');
        });
    });

    // =========================================================================
    // Usage Confirmation & TTL Window
    // =========================================================================
    describe('confirmApiKeyUsage', () => {
        it('should increment usage counter and establish 24h window on first request', async () => {
            await confirmApiKeyUsage(0);

            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            expect(mockStore.get(usageKey)).toBe(1);
            expect(mockRedis.expire).toHaveBeenCalledWith(usageKey, 86400);
        });

        it('should NOT reset or extend 24h TTL on subsequent requests', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 5);
            mockExpires.set(usageKey, 54000);

            await confirmApiKeyUsage(0);

            expect(mockStore.get(usageKey)).toBe(6);
            expect(mockRedis.expire).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Force Rotation & State Transition on Failure
    // =========================================================================
    describe('forceKeyRotationAndGetKey', () => {
        it('should disable key and rotate when triggered by 401 error', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            const error401 = new Error('API key not valid (401)');
            const nextKey = await forceKeyRotationAndGetKey(error401);

            expect(nextKey.index).toBe(1);
            expect(mockStore.get('gemini:key_disabled:0')).toBeDefined();
        });

        it('should put key into cooldown and rotate when triggered by 429 error', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            const error429 = new Error('429 Too Many Requests: quota exceeded');
            const nextKey = await forceKeyRotationAndGetKey(error429);

            expect(nextKey.index).toBe(1);
            expect(mockStore.get('gemini:key_cooldown:0')).toBeDefined();
        });

        it('should preserve existing usage counts of new healthy key', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);
            mockStore.set(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}1`, 15);

            const nextKey = await forceKeyRotationAndGetKey();

            expect(nextKey.index).toBe(1);
            expect(mockStore.get(`${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}1`)).toBe(15);
        });
    });

    // =========================================================================
    // 3-State Distributed Circuit Breaker Management (Atomic Probing)
    // =========================================================================
    describe('3-State Distributed Circuit Breaker', () => {
        const model = 'gemini-3.7-flash';

        it('should have 5 minutes (300s) cooldown lock for single probe', () => {
            expect(PROBE_LOCK_TTL_SECONDS).toBe(300);
        });

        it('should report CLOSED state by default', async () => {
            const state = await getModelCircuitState(model);
            expect(state).toBe('closed');
            expect(await isModelCircuitOpen(model)).toBe(false);
        });

        it('should transition to OPEN state after consecutive 503 failures', async () => {
            await recordModelFailure(model);
            expect(await getModelCircuitState(model)).toBe('closed');

            await recordModelFailure(model); // 2nd failure trips circuit
            expect(await getModelCircuitState(model)).toBe('open');
            expect(await isModelCircuitOpen(model)).toBe(true);
        });

        it('should transition to HALF-OPEN state when OPEN TTL expires', async () => {
            mockStore.set(`gemini:model_failures:${model}`, 2);
            mockStore.delete(`gemini:circuit_breaker:${model}`);

            const state = await getModelCircuitState(model);
            expect(state).toBe('half-open');
        });

        it('should atomically permit only ONE single probe in HALF-OPEN state via SET NX with 300s TTL', async () => {
            mockStore.set(`gemini:model_failures:${model}`, 2);

            // First concurrent probe request wins
            const probe1 = await tryAcquireHalfOpenProbe(model);
            expect(probe1).toBe(true);
            expect(mockRedis.set).toHaveBeenCalledWith(
                `gemini:circuit_probe:${model}`,
                'probing',
                expect.objectContaining({ nx: true, ex: 300 })
            );

            // Second concurrent request within lock duration is rejected
            const probe2 = await tryAcquireHalfOpenProbe(model);
            expect(probe2).toBe(false);
        });

        it('should explicitly release probe lock via releaseProbeLock', async () => {
            await tryAcquireHalfOpenProbe(model);
            expect(mockStore.has(`gemini:circuit_probe:${model}`)).toBe(true);

            await releaseProbeLock(model);
            expect(mockStore.has(`gemini:circuit_probe:${model}`)).toBe(false);
        });

        it('should reset to CLOSED state on recorded success', async () => {
            await tripModelCircuit(model, 600);
            expect(await isModelCircuitOpen(model)).toBe(true);

            await recordModelSuccess(model);

            const state = await getModelCircuitState(model);
            expect(state).toBe('closed');
            expect(await isModelCircuitOpen(model)).toBe(false);
        });

        it('should trip back to OPEN state with backoff if probe fails', async () => {
            await tripModelCircuit(model, 600);
            expect(await isModelCircuitOpen(model)).toBe(true);
        });
    });

    // =========================================================================
    // Error Classification & Sanitization
    // =========================================================================
    describe('classifyGeminiError & sanitizeErrorMessage', () => {
        it('should classify 400 Bad Request as invalid_request (non-rotatable, fail-fast)', () => {
            const error = new Error('400 Bad Request: Invalid argument supplied');
            const result = classifyGeminiError(error);

            expect(result.category).toBe('invalid_request');
            expect(result.statusCode).toBe(400);
            expect(result.retryableWithKey).toBe(false);
            expect(result.retryableWithModel).toBe(false);
        });

        it('should sanitize Google API keys and query parameters from error strings', () => {
            const rawSdkMsg = 'fetch failed: https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=AIzaSyD1234567890abcdef1234567890abcde';
            const sanitized = sanitizeErrorMessage(rawSdkMsg);

            expect(sanitized).not.toContain('AIzaSyD1234567890abcdef1234567890abcde');
            expect(sanitized).toContain('[REDACTED_API_KEY]');
        });

        it('should classify 401 as authentication (rotatable, disables key)', () => {
            const error = new Error('API key not valid. Please pass a valid API key. (401)');
            const result = classifyGeminiError(error);

            expect(result.category).toBe('authentication');
            expect(result.statusCode).toBe(401);
            expect(result.retryableWithKey).toBe(true);
        });

        it('should classify 429 and ResourceExhausted as quota (rotatable, sets cooldown)', () => {
            const error = new Error('Resource has been exhausted (e.g. check quota) (429)');
            const result = classifyGeminiError(error);

            expect(result.category).toBe('quota');
            expect(result.statusCode).toBe(429);
            expect(result.retryableWithKey).toBe(true);
        });

        it('should classify 503 and high demand as overload (rotatable to fallback model)', () => {
            const error = new Error('503 Service Unavailable: Model is overloaded');
            const result = classifyGeminiError(error);

            expect(result.category).toBe('overload');
            expect(result.statusCode).toBe(503);
            expect(result.retryableWithModel).toBe(true);
            expect(result.retryableWithKey).toBe(false);
        });

        it('should classify 500, 502, 504 and fetch failed as transient', () => {
            const error = new Error('fetch failed: ECONNRESET');
            const result = classifyGeminiError(error);

            expect(result.category).toBe('transient');
            expect(result.retryableWithKey).toBe(true);
        });

        it('should classify AbortError as cancelled (non-rotatable)', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            const result = classifyGeminiError(abortErr);

            expect(result.category).toBe('cancelled');
            expect(result.retryableWithKey).toBe(false);
            expect(result.retryableWithModel).toBe(false);
        });
    });

    // =========================================================================
    // Sanitization & Masking
    // =========================================================================
    describe('maskApiKey', () => {
        it('should mask standard API key securely', () => {
            expect(maskApiKey('AIzaSyD-1234567890abcdef')).toBe('AIza...cdef');
        });

        it('should handle short or invalid keys safely', () => {
            expect(maskApiKey('short')).toBe('***masked***');
            expect(maskApiKey('')).toBe('unknown_key');
            expect(maskApiKey(undefined)).toBe('unknown_key');
        });
    });

    // =========================================================================
    // extractErrorCode Precision (Avoiding False Positives)
    // =========================================================================
    describe('extractErrorCode precision', () => {
        it('should return false for 400 Bad Request', () => {
            expect(shouldRotateOnError(400)).toBe(false);
            expect(shouldRotateOnError(new Error('400 Bad Request'))).toBe(false);
        });

        it('should return true for 401, 403, 429, 500, 502, 503, 504', () => {
            for (const code of ROTATION_ERROR_CODES) {
                expect(shouldRotateOnError(code)).toBe(true);
            }
        });

        it('should extract status codes correctly from structured properties', () => {
            expect(extractErrorCode({ status: 503 })).toBe(503);
            expect(extractErrorCode({ statusCode: 401 })).toBe(401);
            expect(extractErrorCode({ response: { status: 429 } })).toBe(429);
            expect(extractErrorCode(new Error('status: 400'))).toBe(400);
            expect(extractErrorCode(null)).toBe(0);
        });

        it('should avoid false positive match on non-HTTP numbers in payload', () => {
            const docMsg = new Error('File item document_id_400 loaded successfully');
            expect(extractErrorCode(docMsg)).toBe(0);
        });
    });
});
