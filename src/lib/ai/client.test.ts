import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ===========================================
// Mock Setup using vi.hoisted for all mocks
// ===========================================
const mocks = vi.hoisted(() => {
    // Key rotation & Circuit Breaker mocks
    const getApiKeyForRequest = vi.fn();
    const confirmApiKeyUsage = vi.fn();
    const forceKeyRotationAndGetKey = vi.fn();
    const shouldRotateOnError = vi.fn();
    const extractErrorCode = vi.fn();
    const is503OrOverloadError = vi.fn();
    const isModelCircuitOpen = vi.fn();
    const recordModelFailure = vi.fn();
    const tripModelCircuit = vi.fn();
    const resetModelCircuit = vi.fn();

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
        confirmApiKeyUsage,
        forceKeyRotationAndGetKey,
        shouldRotateOnError,
        extractErrorCode,
        is503OrOverloadError,
        isModelCircuitOpen,
        recordModelFailure,
        tripModelCircuit,
        resetModelCircuit,
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
    confirmApiKeyUsage: mocks.confirmApiKeyUsage,
    forceKeyRotationAndGetKey: mocks.forceKeyRotationAndGetKey,
    shouldRotateOnError: mocks.shouldRotateOnError,
    extractErrorCode: mocks.extractErrorCode,
    is503OrOverloadError: mocks.is503OrOverloadError,
    isModelCircuitOpen: mocks.isModelCircuitOpen,
    recordModelFailure: mocks.recordModelFailure,
    tripModelCircuit: mocks.tripModelCircuit,
    resetModelCircuit: mocks.resetModelCircuit,
    ROTATION_ERROR_CODES: [400, 401, 403, 429, 500, 502, 503, 504],
}));

// Import after mocks are set up
import { processWithAI, streamWithAI, getModelPair, MODEL_CONFIG, ROTATION_ERROR_CODES } from './client';
import type { AIOperation } from './prompts';

describe('AI Client', () => {
    const mockKeyInfo = { key: 'test-api-key', index: 0 };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getApiKeyForRequest.mockResolvedValue(mockKeyInfo);
        mocks.confirmApiKeyUsage.mockResolvedValue(undefined);
        mocks.forceKeyRotationAndGetKey.mockResolvedValue({ key: 'new-api-key', index: 1 });
        mocks.shouldRotateOnError.mockReturnValue(false);
        mocks.extractErrorCode.mockReturnValue(0);
        mocks.is503OrOverloadError.mockReturnValue(false);
        mocks.isModelCircuitOpen.mockResolvedValue(false);
        mocks.recordModelFailure.mockResolvedValue(undefined);
        mocks.tripModelCircuit.mockResolvedValue(undefined);
        mocks.resetModelCircuit.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    // =========================================
    // MODEL_CONFIG Tests
    // =========================================
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

        it('should have thinking level config for toPrompt', () => {
            expect(MODEL_CONFIG.toPrompt.thinkingLevel).toBeDefined();
            expect(MODEL_CONFIG.toPrompt.thinkingLevel.pro).toBe('medium');
            expect(MODEL_CONFIG.toPrompt.thinkingLevel.ultra).toBe('high');
        });
    });

    // =========================================
    // getModelPair Tests
    // =========================================
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

    // =========================================
    // processWithAI Tests
    // =========================================
    describe('processWithAI', () => {
        it('should process text successfully and confirm usage', async () => {
            const mockResponse = { text: () => 'Processed text' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Processed text');
            expect(mocks.getApiKeyForRequest).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(0);
        });

        it('should use fallback model when circuit is OPEN in Redis (Fast-Path)', async () => {
            mocks.isModelCircuitOpen.mockResolvedValue(true);
            const mockResponse = { text: () => 'Fallback text' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Fallback text');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should immediately failover to fallback model on 503 error in same request', async () => {
            const error503 = new Error('503 Service Unavailable');
            mocks.is503OrOverloadError.mockReturnValueOnce(true);
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

        it('should NOT increment counter on failed requests', async () => {
            mocks.generateContent.mockRejectedValue(new Error('API Error'));

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('API Error');

            expect(mocks.confirmApiKeyUsage).not.toHaveBeenCalled();
        });

        it('should throw error for unavailable operations', async () => {
            await expect(processWithAI('toPrompt', 'Test input', 'free')).rejects.toThrow(
                "Operation 'toPrompt' is not available for free tier"
            );

            expect(mocks.getApiKeyForRequest).not.toHaveBeenCalled();
        });

        it('should retry with new key on rotatable errors', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.generateContent
                .mockRejectedValueOnce(error429)
                .mockResolvedValueOnce({ response: { text: () => 'Success' } });

            mocks.extractErrorCode.mockReturnValue(429);
            mocks.shouldRotateOnError.mockReturnValue(true);

            const result = await processWithAI('correct', 'Test input', 'free');

            expect(result).toBe('Success');
            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(1); // New key
        });

        it('should fail after max retries', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.generateContent.mockRejectedValue(error429);
            mocks.extractErrorCode.mockReturnValue(429);
            mocks.shouldRotateOnError.mockReturnValue(true);

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('429 Too Many Requests');

            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(6);
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

        it('should immediately failover stream to fallback model on 503 error in same request', async () => {
            const error503 = new Error('503 Service Unavailable');
            mocks.is503OrOverloadError.mockReturnValueOnce(true);
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

        it('should use fallback model when circuit is OPEN in Redis for streaming (Fast-Path)', async () => {
            mocks.isModelCircuitOpen.mockResolvedValue(true);
            mocks.generateContentStream.mockResolvedValue(createMockStream(['Stream from fallback']));

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.correct.fallback.free })
            );
        });

        it('should NOT increment counter on stream start failure', async () => {
            mocks.generateContentStream.mockRejectedValue(new Error('Stream init failed'));

            await expect(streamWithAI('correct', 'Test input', 'free')).rejects.toThrow('Stream init failed');

            expect(mocks.confirmApiKeyUsage).not.toHaveBeenCalled();
        });

        it('should throw error for unavailable operations', async () => {
            await expect(streamWithAI('toPrompt', 'Test input', 'free')).rejects.toThrow(
                "Operation 'toPrompt' is not available for free tier"
            );
        });

        it('should retry with new key on rotatable errors during stream init', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.generateContentStream
                .mockRejectedValueOnce(error429)
                .mockResolvedValueOnce(createMockStream(['Success']));

            mocks.extractErrorCode.mockReturnValue(429);
            mocks.shouldRotateOnError.mockReturnValue(true);

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(1); // New key
        });

        it('should fail after max retries when stream init fails repeatedly', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.generateContentStream.mockRejectedValue(error429);
            mocks.extractErrorCode.mockReturnValue(429);
            mocks.shouldRotateOnError.mockReturnValue(true);

            await expect(streamWithAI('correct', 'Test input', 'free')).rejects.toThrow('429 Too Many Requests');

            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(6);
        });

        it('should handle mid-stream errors gracefully', async () => {
            const mockStreamWithError = {
                stream: (async function* () {
                    yield { text: () => 'First chunk' };
                    throw new Error('Mid-stream error');
                })(),
                response: Promise.reject(new Error('Mid-stream error')).catch(() => {}),
            };
            mocks.generateContentStream.mockResolvedValue(mockStreamWithError);

            const stream = await streamWithAI('correct', 'Test input', 'free');
            const reader = stream.getReader();

            const first = await reader.read();
            expect(new TextDecoder().decode(first.value)).toBe('First chunk');

            await expect(reader.read()).rejects.toThrow('Mid-stream error');
        });

        it('should work with Pro tier for toPrompt operation', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream(['Prompt result']));

            const stream = await streamWithAI('toPrompt', 'Test input', 'pro');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: MODEL_CONFIG.toPrompt.pro })
            );
        });
    });

    // =========================================
    // ROTATION_ERROR_CODES Tests  
    // =========================================
    describe('ROTATION_ERROR_CODES', () => {
        it('should re-export ROTATION_ERROR_CODES', () => {
            expect(ROTATION_ERROR_CODES).toBeDefined();
            expect(Array.isArray(ROTATION_ERROR_CODES)).toBe(true);
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
                            thinkingBudget: 8192 // High for ultra
                        })
                    })
                })
            );
        });

        it('should include medium thinking config for toPrompt Pro tier', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream());

            await streamWithAI('toPrompt', 'Test', 'pro');

            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({
                    generationConfig: expect.objectContaining({
                        thinkingConfig: expect.objectContaining({
                            thinkingBudget: 4096 // Medium for pro
                        })
                    })
                })
            );
        });

        it('should use correct temperature and topP for each operation', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream());

            await streamWithAI('correct', 'Test', 'free');

            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({
                    generationConfig: expect.objectContaining({
                        temperature: MODEL_CONFIG.correct.temperature,
                        topP: MODEL_CONFIG.correct.topP
                    })
                })
            );
        });
    });
});
