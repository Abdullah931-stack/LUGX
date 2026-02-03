import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ===========================================
// Mock Setup using vi.hoisted for all mocks
// ===========================================
const mocks = vi.hoisted(() => {
    // Key rotation mocks
    const getApiKeyForRequest = vi.fn();
    const confirmApiKeyUsage = vi.fn();
    const forceKeyRotationAndGetKey = vi.fn();
    const shouldRotateOnError = vi.fn();
    const extractErrorCode = vi.fn();

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
    ROTATION_ERROR_CODES: [400, 401, 403, 429, 500, 502, 503, 504],
}));

// Import after mocks are set up
import { processWithAI, streamWithAI, MODEL_CONFIG, ROTATION_ERROR_CODES } from './client';
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

        it('should have different models per tier for most operations', () => {
            expect(MODEL_CONFIG.correct.free).toBe('gemini-2.0-flash-lite');
            expect(MODEL_CONFIG.correct.pro).toBe('gemini-flash-lite-latest');
            expect(MODEL_CONFIG.correct.ultra).toBe('gemini-flash-lite-latest');
        });

        it('should disable toPrompt for free tier', () => {
            expect(MODEL_CONFIG.toPrompt.free).toBeNull();
            expect(MODEL_CONFIG.toPrompt.pro).toBe('gemini-3-flash-preview');
            expect(MODEL_CONFIG.toPrompt.ultra).toBe('gemini-3-flash-preview');
        });

        it('should have thinking level config for toPrompt', () => {
            expect(MODEL_CONFIG.toPrompt.thinkingLevel).toBeDefined();
            expect(MODEL_CONFIG.toPrompt.thinkingLevel.pro).toBe('medium');
            expect(MODEL_CONFIG.toPrompt.thinkingLevel.ultra).toBe('high');
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
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(1); // New key index
        });

        it('should throw immediately for non-rotatable errors', async () => {
            const error404 = new Error('404 Not Found');
            mocks.generateContent.mockRejectedValue(error404);
            mocks.extractErrorCode.mockReturnValue(404);
            mocks.shouldRotateOnError.mockReturnValue(false);

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('404 Not Found');

            expect(mocks.forceKeyRotationAndGetKey).not.toHaveBeenCalled();
        });

        it('should fail after max retries', async () => {
            const error429 = new Error('429 Too Many Requests');
            mocks.generateContent.mockRejectedValue(error429);
            mocks.extractErrorCode.mockReturnValue(429);
            mocks.shouldRotateOnError.mockReturnValue(true);

            await expect(processWithAI('correct', 'Test input', 'free')).rejects.toThrow('429 Too Many Requests');

            // Should have retried 6 times (MAX_RETRY_ATTEMPTS)
            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(6);
        });

        it('should use correct model for each tier', async () => {
            const mockResponse = { text: () => 'Result' };
            mocks.generateContent.mockResolvedValue({ response: mockResponse });

            // Test free tier
            await processWithAI('improve', 'Test', 'free');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'gemini-2.5-flash-lite' })
            );

            // Test pro tier
            await processWithAI('improve', 'Test', 'pro');
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'gemini-3-flash-preview' })
            );
        });
    });

    // =========================================
    // streamWithAI Tests
    // =========================================
    describe('streamWithAI', () => {
        // Helper to create mock async generator
        function createMockStream(chunks: string[]) {
            return {
                stream: (async function* () {
                    for (const chunk of chunks) {
                        yield { text: () => chunk };
                    }
                })()
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
            const error503 = new Error('503 Service Unavailable');
            mocks.generateContentStream
                .mockRejectedValueOnce(error503)
                .mockResolvedValueOnce(createMockStream(['Success']));

            mocks.extractErrorCode.mockReturnValue(503);
            mocks.shouldRotateOnError.mockReturnValue(true);

            const stream = await streamWithAI('correct', 'Test input', 'free');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(1);
            expect(mocks.confirmApiKeyUsage).toHaveBeenCalledWith(1); // New key
        });

        it('should fail after max retries when stream init fails repeatedly', async () => {
            const error503 = new Error('503 Service Unavailable');
            mocks.generateContentStream.mockRejectedValue(error503);
            mocks.extractErrorCode.mockReturnValue(503);
            mocks.shouldRotateOnError.mockReturnValue(true);

            await expect(streamWithAI('correct', 'Test input', 'free')).rejects.toThrow('503 Service Unavailable');

            expect(mocks.forceKeyRotationAndGetKey).toHaveBeenCalledTimes(6);
        });

        it('should handle mid-stream errors gracefully', async () => {
            // Create a stream that fails mid-way
            const mockStreamWithError = {
                stream: (async function* () {
                    yield { text: () => 'First chunk' };
                    throw new Error('Mid-stream error');
                })()
            };
            mocks.generateContentStream.mockResolvedValue(mockStreamWithError);

            const stream = await streamWithAI('correct', 'Test input', 'free');
            const reader = stream.getReader();

            // First chunk should work
            const first = await reader.read();
            expect(new TextDecoder().decode(first.value)).toBe('First chunk');

            // Second read should error
            await expect(reader.read()).rejects.toThrow('Mid-stream error');
        });

        it('should work with Pro tier for toPrompt operation', async () => {
            mocks.generateContentStream.mockResolvedValue(createMockStream(['Prompt result']));

            const stream = await streamWithAI('toPrompt', 'Test input', 'pro');

            expect(stream).toBeInstanceOf(ReadableStream);
            expect(mocks.getGenerativeModel).toHaveBeenCalledWith(
                expect.objectContaining({ model: 'gemini-3-flash-preview' })
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
                })()
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
                        temperature: 0.1,
                        topP: 0.75
                    })
                })
            );
        });
    });
});
