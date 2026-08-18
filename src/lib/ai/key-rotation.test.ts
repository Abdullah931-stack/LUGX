import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mocks that are available when vi.mock is hoisted
const { mockStore, mockExpires, mockRedis, MOCK_REDIS_KEYS, resetMocks } = vi.hoisted(() => {
    const mockStore: Map<string, unknown> = new Map();
    const mockExpires: Map<string, number> = new Map();

    const mockRedis = {
        get: vi.fn(async (key: string) => mockStore.get(key) ?? null),
        set: vi.fn(async (key: string, value: unknown) => {
            mockStore.set(key, value);
            return 'OK';
        }),
        del: vi.fn(async (key: string) => {
            mockStore.delete(key);
            return 1;
        }),
        incr: vi.fn(async (key: string) => {
            const current = (mockStore.get(key) as number) ?? 0;
            const newValue = current + 1;
            mockStore.set(key, newValue);
            return newValue;
        }),
        expire: vi.fn(async (key: string, seconds: number) => {
            mockExpires.set(key, seconds);
            return 1;
        }),
    };

    const MOCK_REDIS_KEYS = {
        CURRENT_KEY_INDEX: 'gemini:current_key_index',
        USAGE_COUNT_PREFIX: 'gemini:usage_count:',
    };

    const resetMocks = () => {
        mockStore.clear();
        mockExpires.clear();
        vi.clearAllMocks();
    };

    return { mockStore, mockExpires, mockRedis, MOCK_REDIS_KEYS, resetMocks };
});

// Mock Redis module - this is hoisted to the top
vi.mock('../redis', () => ({
    redis: mockRedis,
    REDIS_KEYS: MOCK_REDIS_KEYS,
}));

// Import the module under test AFTER setting up mocks
import {
    getApiKeyForRequest,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    extractErrorCode,
    is503OrOverloadError,
    isModelCircuitOpen,
    tripModelCircuit,
    recordModelFailure,
    resetModelCircuit,
    getRotationStatus,
    ROTATION_ERROR_CODES,
} from './key-rotation';

describe('Key Rotation System', () => {
    // Setup environment variables before each test
    beforeEach(() => {
        vi.stubEnv('GEMINI_KEY_1', 'test-key-1');
        vi.stubEnv('GEMINI_KEY_2', 'test-key-2');
        vi.stubEnv('GEMINI_KEY_3', 'test-key-3');
        vi.stubEnv('GEMINI_REQUESTS_PER_KEY', '20');
        resetMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('getApiKeyForRequest', () => {
        it('should return the first key when starting fresh', async () => {
            const result = await getApiKeyForRequest();

            expect(result.key).toBe('test-key-1');
            expect(result.index).toBe(0);
        });

        it('should NOT increment counter when getting key for request', async () => {
            await getApiKeyForRequest();

            expect(mockRedis.incr).not.toHaveBeenCalled();
        });

        it('should rotate to next key when current key reaches limit (20)', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 20);
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            const result = await getApiKeyForRequest();

            expect(result.key).toBe('test-key-2');
            expect(result.index).toBe(1);
            expect(mockStore.get(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX)).toBe(1);
        });

        it('should set TTL on old counter when rotating after reaching limit', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 20);
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            await getApiKeyForRequest();

            expect(mockRedis.expire).toHaveBeenCalledWith(usageKey, 3600);
        });

        it('should wrap around to first key when reaching the end of key list', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}2`;
            mockStore.set(usageKey, 20);
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 2);

            const result = await getApiKeyForRequest();

            expect(result.key).toBe('test-key-1');
            expect(result.index).toBe(0);
        });

        it('should throw error when no API keys are configured', async () => {
            vi.stubEnv('GEMINI_KEY_1', '');
            vi.stubEnv('GEMINI_KEY_2', '');
            vi.stubEnv('GEMINI_KEY_3', '');

            await expect(getApiKeyForRequest()).rejects.toThrow('No Gemini API keys configured');
        });
    });

    describe('confirmApiKeyUsage', () => {
        it('should increment usage counter for the specified key', async () => {
            await confirmApiKeyUsage(0);

            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            expect(mockStore.get(usageKey)).toBe(1);
        });

        it('should set TTL when counter reaches limit (20)', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 19);

            await confirmApiKeyUsage(0);

            expect(mockStore.get(usageKey)).toBe(20);
            expect(mockRedis.expire).toHaveBeenCalledWith(usageKey, 3600);
        });

        it('should NOT set TTL when counter is below limit', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 10);

            await confirmApiKeyUsage(0);

            expect(mockRedis.expire).not.toHaveBeenCalled();
        });
    });

    describe('forceKeyRotationAndGetKey', () => {
        it('should rotate to next key immediately', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            const result = await forceKeyRotationAndGetKey();

            expect(result.key).toBe('test-key-2');
            expect(result.index).toBe(1);
        });

        it('should NOT set TTL on counter when force rotating (TTL only when reaching 20)', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 5);
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            await forceKeyRotationAndGetKey();

            expect(mockRedis.expire).not.toHaveBeenCalled();
        });

        it('should reset new key counter to 0', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            await forceKeyRotationAndGetKey();

            const newUsageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}1`;
            expect(mockStore.get(newUsageKey)).toBe(0);
        });

        it('should wrap around when at last key', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 2);

            const result = await forceKeyRotationAndGetKey();

            expect(result.key).toBe('test-key-1');
            expect(result.index).toBe(0);
        });
    });

    describe('Circuit Breaker (Distributed Model Failover)', () => {
        it('should report circuit closed by default', async () => {
            const isOpen = await isModelCircuitOpen('gemini-3.7-flash');
            expect(isOpen).toBe(false);
        });

        it('should trip model circuit in Redis for 1 hour', async () => {
            await tripModelCircuit('gemini-3.7-flash', 3600);

            const isOpen = await isModelCircuitOpen('gemini-3.7-flash');
            expect(isOpen).toBe(true);
            expect(mockRedis.expire).toHaveBeenCalledWith('gemini:circuit_breaker:gemini-3.7-flash', 3600);
        });

        it('should record model failure and trip circuit on consecutive 503s', async () => {
            await recordModelFailure('gemini-3.7-flash');
            expect(await isModelCircuitOpen('gemini-3.7-flash')).toBe(false);

            await recordModelFailure('gemini-3.7-flash'); // Second consecutive failure
            expect(await isModelCircuitOpen('gemini-3.7-flash')).toBe(true);
        });

        it('should reset model circuit in Redis', async () => {
            await tripModelCircuit('gemini-3.7-flash');
            expect(await isModelCircuitOpen('gemini-3.7-flash')).toBe(true);

            await resetModelCircuit('gemini-3.7-flash');
            expect(await isModelCircuitOpen('gemini-3.7-flash')).toBe(false);
        });

        it('should identify 503 and high demand overload errors', () => {
            expect(is503OrOverloadError(503)).toBe(true);
            expect(is503OrOverloadError(new Error('503 Service Unavailable'))).toBe(true);
            expect(is503OrOverloadError(new Error('This model is currently experiencing high demand.'))).toBe(true);
            expect(is503OrOverloadError(429)).toBe(false);
            expect(is503OrOverloadError(400)).toBe(false);
        });
    });

    describe('shouldRotateOnError', () => {
        it('should return true for 429 (rate limit)', () => {
            expect(shouldRotateOnError(429)).toBe(true);
        });

        it('should return true for 503 (service unavailable)', () => {
            expect(shouldRotateOnError(503)).toBe(true);
        });

        it('should return true for 500 (internal server error)', () => {
            expect(shouldRotateOnError(500)).toBe(true);
        });

        it('should return true for 400 (bad request)', () => {
            expect(shouldRotateOnError(400)).toBe(true);
        });

        it('should return true for 401 (unauthorized)', () => {
            expect(shouldRotateOnError(401)).toBe(true);
        });

        it('should return true for 403 (forbidden)', () => {
            expect(shouldRotateOnError(403)).toBe(true);
        });

        it('should return false for 200 (success)', () => {
            expect(shouldRotateOnError(200)).toBe(false);
        });

        it('should return false for 404 (not found)', () => {
            expect(shouldRotateOnError(404)).toBe(false);
        });
    });

    describe('extractErrorCode', () => {
        it('should extract status code from error message', () => {
            const error = new Error('API returned 429 Too Many Requests');
            expect(extractErrorCode(error)).toBe(429);
        });

        it('should extract first 3-digit number from message', () => {
            const error = new Error('Error 503: Service Unavailable');
            expect(extractErrorCode(error)).toBe(503);
        });

        it('should return 0 when no status code found', () => {
            const error = new Error('Unknown error occurred');
            expect(extractErrorCode(error)).toBe(0);
        });

        it('should handle string errors', () => {
            expect(extractErrorCode('Error 400 Bad Request')).toBe(400);
        });

        it('should handle null/undefined', () => {
            expect(extractErrorCode(null)).toBe(0);
            expect(extractErrorCode(undefined)).toBe(0);
        });
    });

    describe('getRotationStatus', () => {
        it('should return current status', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 1);
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}1`;
            mockStore.set(usageKey, 5);

            const status = await getRotationStatus();

            expect(status.currentKeyIndex).toBe(1);
            expect(status.totalKeys).toBe(3);
            expect(status.usageCount).toBe(5);
            expect(status.requestsPerKey).toBe(20);
        });

        it('should return defaults when no data in Redis', async () => {
            const status = await getRotationStatus();

            expect(status.currentKeyIndex).toBe(0);
            expect(status.usageCount).toBe(0);
        });
    });

    describe('Counter never exceeds 20', () => {
        it('should rotate before counter can exceed limit', async () => {
            const usageKey = `${MOCK_REDIS_KEYS.USAGE_COUNT_PREFIX}0`;
            mockStore.set(usageKey, 20);
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            const result = await getApiKeyForRequest();

            expect(result.index).toBe(1);
            expect(result.key).toBe('test-key-2');
        });

        it('should not allow 21st request on same key', async () => {
            mockStore.set(MOCK_REDIS_KEYS.CURRENT_KEY_INDEX, 0);

            for (let i = 0; i < 20; i++) {
                const keyInfo = await getApiKeyForRequest();
                if (keyInfo.index === 0) {
                    await confirmApiKeyUsage(keyInfo.index);
                }
            }

            const result = await getApiKeyForRequest();
            expect(result.index).toBe(1);
        });
    });

    describe('ROTATION_ERROR_CODES constant', () => {
        it('should include all expected error codes', () => {
            expect(ROTATION_ERROR_CODES).toContain(400);
            expect(ROTATION_ERROR_CODES).toContain(401);
            expect(ROTATION_ERROR_CODES).toContain(403);
            expect(ROTATION_ERROR_CODES).toContain(429);
            expect(ROTATION_ERROR_CODES).toContain(500);
            expect(ROTATION_ERROR_CODES).toContain(502);
            expect(ROTATION_ERROR_CODES).toContain(503);
            expect(ROTATION_ERROR_CODES).toContain(504);
        });
    });
});
