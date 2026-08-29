import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =========================================================================
// Mock Setup using vi.hoisted for all dependencies
// =========================================================================
const mocks = vi.hoisted(() => {
    // Key rotation & Circuit Breaker mocks
    const getApiKeyForRequest = vi.fn();
    const getApiKeys = vi.fn(() => ['test-api-key-1', 'test-api-key-2', 'test-api-key-3']);
    const confirmApiKeyUsage = vi.fn();
    const forceKeyRotationAndGetKey = vi.fn();
    const shouldRotateOnError = vi.fn();
    const extractErrorCode = vi.fn();
    const is503OrOverloadError = vi.fn();
    const getModelCircuitState = vi.fn();
    const isModelCircuitOpen = vi.fn();
    const tryAcquireHalfOpenProbe = vi.fn();
    const releaseProbeLock = vi.fn();
    const recordModelSuccess = vi.fn();
    const recordModelFailure = vi.fn();
    const tripModelCircuit = vi.fn();
    const resetModelCircuit = vi.fn();
    const maskApiKey = vi.fn((key?: string) => key ? 'masked_key' : 'unknown_key');
    const sanitizeErrorMessage = vi.fn((msg?: string) => msg || '');
    const classifyGeminiError = vi.fn();

    // Gemini SDK mocks
    const generateContent = vi.fn();
    const generateContentStream = vi.fn();
    const getGenerativeModel = vi.fn(() => ({
        generateContent,
        generateContentStream,
    }));

    // Mock class for GoogleGenerativeAI
    class MockGoogleGenerativeAI {
        constructor(_apiKey: string) { }
        getGenerativeModel = getGenerativeModel;
    }

    return {
        getApiKeyForRequest,
        getApiKeys,
        confirmApiKeyUsage,
        forceKeyRotationAndGetKey,
        shouldRotateOnError,
        extractErrorCode,
        is503OrOverloadError,
        getModelCircuitState,
        isModelCircuitOpen,
        tryAcquireHalfOpenProbe,
        releaseProbeLock,
        recordModelSuccess,
        recordModelFailure,
        tripModelCircuit,
        resetModelCircuit,
        maskApiKey,
        sanitizeErrorMessage,
        classifyGeminiError,
        generateContent,
        generateContentStream,
        getGenerativeModel,
        MockGoogleGenerativeAI,
    };
});

// Mock the Gemini SDK
vi.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: mocks.MockGoogleGenerativeAI,
}));

// Mock key-rotation module
vi.mock('./key-rotation', () => ({
    getApiKeyForRequest: mocks.getApiKeyForRequest,
    getApiKeys: mocks.getApiKeys,
    confirmApiKeyUsage: mocks.confirmApiKeyUsage,
    forceKeyRotationAndGetKey: mocks.forceKeyRotationAndGetKey,
    shouldRotateOnError: mocks.shouldRotateOnError,
    extractErrorCode: mocks.extractErrorCode,
    is503OrOverloadError: mocks.is503OrOverloadError,
    getModelCircuitState: mocks.getModelCircuitState,
    isModelCircuitOpen: mocks.isModelCircuitOpen,
    tryAcquireHalfOpenProbe: mocks.tryAcquireHalfOpenProbe,
    releaseProbeLock: mocks.releaseProbeLock,
    recordModelSuccess: mocks.recordModelSuccess,
    recordModelFailure: mocks.recordModelFailure,
    tripModelCircuit: mocks.tripModelCircuit,
    resetModelCircuit: mocks.resetModelCircuit,
    maskApiKey: mocks.maskApiKey,
    sanitizeErrorMessage: mocks.sanitizeErrorMessage,
    classifyGeminiError: mocks.classifyGeminiError,
    ROTATION_ERROR_CODES: [401, 403, 429, 500, 502, 503, 504],
    CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
        constructor(model: string) {
            super(`Circuit Breaker is OPEN for model '${model}'.`);
            this.name = 'CircuitBreakerOpenError';
        }
    },
}));

// Import client module after mocks are set up
import { processWithAI, streamWithAI, getModelPair, MODEL_CONFIG } from './client';
import type { AIOperation } from './prompts';

describe('AI Client (Robust & Fault-Tolerant Execution)', () => {
    const mockKeyInfo = { key: 'test-api-key', index: 0 };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getApiKeyForRequest.mockResolvedValue(mockKeyInfo);
        mocks.getApiKeys.mockReturnValue(['test-api-key-1', 'test-api-key-2', 'test-api-key-3']);
        mocks.confirmApiKeyUsage.mockResolvedValue(undefined);
        mocks.forceKeyRotationAndGetKey.mockResolvedValue({ key: 'new-api-key', index: 1 });
        mocks.shouldRotateOnError.mockReturnValue(false);
        mocks.extractErrorCode.mockReturnValue(0);
        mocks.is503OrOverloadError.mockReturnValue(false);
        mocks.getModelCircuitState.mockResolvedValue('closed');
        mocks.isModelCircuitOpen.mockResolvedValue(false);
        mocks.tryAcquireHalfOpenProbe.mockResolvedValue(false);
        mocks.releaseProbeLock.mockResolvedValue(undefined);
        mocks.recordModelSuccess.mockResolvedValue(undefined);
        mocks.recordModelFailure.mockResolvedValue(undefined);
        mocks.tripModelCircuit.mockResolvedValue(undefined);
        mocks.resetModelCircuit.mockResolvedValue(undefined);
        mocks.sanitizeErrorMessage.mockImplementation((msg?: string) => msg || '');
        mocks.classifyGeminiError.mockReturnValue({
            category: 'unknown',
            statusCode: 0,
            retryableWithKey: false,
            retryableWithModel: false,
            reason: 'Unknown',
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // =========================================================================
    // MODEL_CONFIG Tests
    // =========================================================================
    describe('MODEL_CONFIG', () => {
        it('should have configuration for all operations', () => {
            const operations: AIOperation[] = ['correct', 'improve', 'summarize', 'toPrompt', 'translate'];

            operations.forEach(op => {
                expect(MODEL_CONFIG[op]).toBeDefined();
                expect(MODEL_CONFIG[op].temperature).toBeDefined();
                expect(MODEL_CONFIG[op].topP).toBeDefined();
            });
        });

        it('should have valid models configured per tier for operations', () => {
            expect(MODEL_CONFIG.correct.free).toBeDefined();
            expect(typeof MODEL_CONFIG.correct.free).toBe('string');
            expect(MODEL_CONFIG.correct.pro).toBeDefined();
            expect(typeof MODEL_CONFIG.correct.pro).toBe('string');
            expect(MODEL_CONFIG.correct.ultra).toBeDefined();
            expect(typeof MODEL_CONFIG.correct.ultra).toBe('string');
        });

        it('should have valid fallback models configured per operation', () => {
            expect(MODEL_CONFIG.correct.fallback).toBeDefined();
            expect(MODEL_CONFIG.correct.fallback.free).toBeDefined();
            expect(MODEL_CONFIG.translate.fallback.free).toBeDefined();
        });

        it('should disable toPrompt for free tier and configure paid tiers', () => {
            expect(MODEL_CONFIG.toPrompt.free).toBeNull();
            expect(MODEL_CONFIG.toPrompt.pro).toBeDefined();
            expect(typeof MODEL_CONFIG.toPrompt.pro).toBe('string');
            expect(MODEL_CONFIG.toPrompt.ultra).toBeDefined();
            expect(typeof MODEL_CONFIG.toPrompt.ultra).toBe('string');
        });
    });

    // =========================================================================
    // getModelPair Tests
    // =========================================================================
    describe('getModelPair', () => {
        it('should return primary and fallback for correct operation', () => {
            const pair = getModelPair('correct', 'free');
            expect(pair.primary).toBe(MODEL_CONFIG.correct.free);
            expect(pair.fallback).toBe(MODEL_CONFIG.correct.fallback.free);
        });

        it('should return null primary and fallback for toPrompt free tier', () => {
            const pair = getModelPair('toPrompt', 'free');
            expect(pair.primary).toBeNull();
            expect(pair.fallback).toBeNull();
        });
    });

    // =========================================================================
    // processWithAI Tests
    // =========================================================================
    describe('processWithAI', () => {
        it('should process text successfully and confirm usage', async () => {
            const mockResponse = { text: () => 'Processed text' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Processed text');
            expect(mocks.getApiKeyForRequest).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(0);
            expect(mocks.recordModelSuccess).toHaveBeenCalledWith(MODEL_CONFIG.correct.free);
        });

        it('should fast-path to fallback model when circuit is OPEN', async () => {
            mocks.getModelCircuitState.mockResolvedValue('open');
            const mockResponse = { text: () => 'Fallback text' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Fallback text');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should allow single probe on primary model during HALF-OPEN state', async () => {
            mocks.getModelCircuitState.mockResolvedValue('half-open');
            mocks.tryAcquireHalfOpenProbe.mockResolvedValue(true); // Won probe
            const mockResponse = { text: () => 'Primary probe success' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Primary probe success');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.free })
            );
            expect(mocks.recordModelSuccess).toHaveBeenCalledWith(MODEL_CONFIG.correct.free);
        });

        it('should route to fallback model during HALF-OPEN state when probe is already in flight', async () => {
            mocks.getModelCircuitState.mockResolvedValue('half-open');
            mocks.tryAcquireHalfOpenProbe.mockResolvedValue(false); // Lost probe race
            const mockResponse = { text: () => 'Fallback concurrent result' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Fallback concurrent result');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should immediately failover to fallback model on 503 overload in same call', async () => {
            const error503 = new Error('503 Service Unavailable');
            mocks.classifyGeminiError.mockReturnValueOnce({
                category: 'overload',
                statusCode: 503,
                retryableWithKey: false,
                retryableWithModel: true,
                reason: 'Overloaded',
            });
            mocks.generateContent
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce({ response: { text: () => 'Recovered via fallback' } });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Recovered via fallback');
            expect(mocks.recordModelFailure).toHaveBeenCalled();
            expect(mocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should fail fast on 400 Bad Request without rotating keys or retrying', async () => {
            const error400 = new Error('400 Bad Request: Invalid argument');
            mocks.classifyGeminiError.mockReturnValue({
                category: 'invalid_request',
                statusCode: 400,
                retryableWithKey: false,
                retryableWithModel: false,
                reason: 'Invalid client request',
            });
            mocks.generateContent.mockRejectedValue(error400);

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('400 Bad Request');

            expect(mocks.forceKeyRotationAndGetKey).not.toHaveBeenCalled();
            expect(mocks.confirmApiKeyUsage).not.toHaveBeenCalled();
        });

        it('should propagate AbortSignal cancellation cleanly', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(processWithAI('correct', 'Test input', 'free', controller.signal)).rejects.toThrow('The operation was aborted');
            expect(mocks.getApiKeyForRequest).not.toHaveBeenCalled();
        });

        it('should retry with new key on rotatable quota/auth errors', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.classifyGeminiError
                .mockReturnValueOnce({
                    category: 'quota',
                    statusCode: 429,
                    retryableWithKey: true,
                    retryableWithModel: false,
                    reason: 'Quota exceeded',
                })
                .mockReturnValueOnce({
                    category: 'unknown',
                    statusCode: 0,
                    retryableWithKey: false,
                    retryableWithModel: false,
                    reason: 'Success',
                });

            mocks.generateContent
                .mockRejectedValueOnce(error429)
                .mockResolvedValueOnce({ response: { text: () => 'Rotated Success' } });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Rotated Success');
            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(1);
        });
    });

    // =========================================
    // streamWithAI Tests
    // =========================================
    describe('streamWithAI', () => {
        function createMockStream(chunks: string[]) {
            return {
                stream: (async function* () {
                    for (const chunk of chunks) {
                        yield { text: () => chunk };
                    }
                })(),
                response: Promise.resolve({ candidates: [] }),
            };
        }

        it('should return a ReadableStream on success', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream(['Hello', ' World']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(0);
        });

        it('should stream text chunks correctly', async () => {
            const chunks = ['Hello', ' ', 'World', '!'];
            mocks.generateContentStream.mockResolvedValue(createMockStream(chunks));

            const stream = await streamWithAI('correct', 'Test input', 'free');
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            let result = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                result += decoder.decode(value);
            }

            expect(result).toBe('Hello World!');
        });

        it('should fail fast on 400 Bad Request during stream startup', async () => {
            const error400 = new Error('400 Bad Request');
            mocks.classifyGeminiError.mockReturnValue({
                category: 'invalid_request',
                statusCode: 400,
                retryableWithKey: false,
                retryableWithModel: false,
                reason: 'Invalid request',
            });
            mocks.generateContentStream.mockRejectedValue(error400);

            await expect(streamWithAI('correct', 'Test input', 'free')).rejects.toThrow('400 Bad Request');
            expect(mocks.forceKeyRotationAndGetKey).not.toHaveBeenCalled();
        });

        it('should failover stream immediately on 503 error in same request', async () => {
            const error503 = new Error('503 Service Unavailable');
            mocks.classifyGeminiError.mockReturnValueOnce({
                category: 'overload',
                statusCode: 503,
                retryableWithKey: false,
                retryableWithModel: true,
                reason: 'Model overloaded',
            });
            mocks.generateContentStream
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce(createMockStream(['Stream recovered']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.recordModelFailure).toHaveBeenCalled();
            expect(mocks.getGenerativeModel).toHaveBeenLastCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should abort stream cleanly if AbortSignal triggers before start', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(streamWithAI('correct', 'Test input', 'free', controller.signal)).rejects.toThrow('Stream aborted before initialization');
        });
    });

    // =========================================
    // Generation Config Tests
    // =========================================
    describe('Generation Config', () => {
        function createMockStream() {
            return {
                stream: (async function* () {
                    yield { text: () => 'Result' };
                })(),
                response: Promise.resolve({ candidates: [] }),
            };
        }

        it('should include thinking config for toPrompt Ultra tier', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream());

            await streamWithAI('toPrompt', 'Test', 'ultra');

            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({
                    generationConfig: expect.objectContaining({
                        thinkingConfig: expect.objectContaining({
                            thinkingBudget: 8192,
                        }),
                    }),
                })
            );
        });
    });
});
