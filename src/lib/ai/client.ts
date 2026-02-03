import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    getApiKeyForRequest,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    extractErrorCode,
    ROTATION_ERROR_CODES,
    KeyInfo,
} from "./key-rotation";
import { AI_PROMPTS, AIOperation } from "./prompts";

// Model configurations per operation and tier
// Based on AI Key Document.md specifications
export const MODEL_CONFIG = {
    correct: {
        // Correct: gemini-2.0-flash-lite (Free), gemini-flash-lite-latest (Pro/Ultra)
        free: "gemini-flash-lite-latest",
        pro: "gemini-flash-lite-latest",
        ultra: "gemini-flash-lite-latest",
        temperature: 0.1,
        topP: 0.75,
    },
    improve: {
        // Improve: gemini-2.5-flash-lite (Free), gemini-3-flash-preview (Pro/Ultra)
        free: "gemini-3-flash-preview",
        pro: "gemini-3-flash-preview",
        ultra: "gemini-3-flash-preview",
        temperature: 0.7,
        topP: 0.95,
        frequencyPenalty: 0.2,
        presencePenalty: 0.5,
    },
    summarize: {
        // Summarize: gemini-2.5-flash-lite for all tiers
        free: "gemini-2.5-flash-lite",
        pro: "gemini-2.5-flash-lite",
        ultra: "gemini-2.5-flash-lite",
        temperature: 0.2,
        topP: 0.80,
        frequencyPenalty: 0.6,
        presencePenalty: 0.3,
    },
    toPrompt: {
        // ToPrompt: Disabled for Free, gemini-3-flash-preview (Pro/Ultra)
        free: null, // Not available for free tier
        pro: "gemini-3-flash-preview",
        ultra: "gemini-3-flash-preview",
        temperature: 0.4,
        topP: 0.90,
        frequencyPenalty: 0.5,
        presencePenalty: 0.4,
        // Thinking level: high for Ultra tier (as per AI Key Document)
        thinkingLevel: {
            pro: "medium",
            ultra: "high",
        },
    },
    translate: {
        // Translate: gemini-2.5-flash-lite (Free), gemini-3-flash-preview (Pro/Ultra)
        free: "gemini-3-flash-preview",
        pro: "gemini-3-flash-preview",
        ultra: "gemini-3-flash-preview",
        temperature: 0.3,
        topP: 0.85,
        frequencyPenalty: 0.3,
        presencePenalty: 0.2,
    },
} as const;

export type Tier = "free" | "pro" | "ultra";

// Maximum retry attempts for key rotation
const MAX_RETRY_ATTEMPTS = 6;

/**
 * Build generation config for a specific operation and tier
 */
function buildGenerationConfig(
    operation: AIOperation,
    tier: Tier
): Record<string, unknown> {
    const config = MODEL_CONFIG[operation];

    const generationConfig: Record<string, unknown> = {
        temperature: config.temperature,
        topP: config.topP,
    };

    // Add thinking level for ToPrompt operation if applicable
    if (operation === "toPrompt" && "thinkingLevel" in config) {
        const thinkingConfig = config.thinkingLevel as Record<string, string>;
        if (thinkingConfig[tier]) {
            generationConfig.thinkingConfig = {
                thinkingBudget: thinkingConfig[tier] === "high" ? 8192 : 4096,
            };
        }
    }

    return generationConfig;
}

/**
 * Process text with AI
 * 
 * Features:
 * - Automatic key rotation on technical errors (429, 503, etc.)
 * - Counter only increments on successful requests
 * - Automatic retry with different key on failure
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @returns Processed text
 */
export async function processWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier
): Promise<string> {
    const config = MODEL_CONFIG[operation];
    const modelName = config[tier];

    // Check if operation is available for this tier
    if (!modelName) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    let retries = MAX_RETRY_ATTEMPTS;
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        try {
            // Get API key for this request (does NOT increment counter)
            keyInfo = keyInfo || await getApiKeyForRequest();

            // Initialize Gemini client
            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig,
            });

            // Generate content
            const result = await model.generateContent([
                { text: systemPrompt },
                { text: text },
            ]);

            const response = result.response;
            const processedText = response.text();

            // SUCCESS: Now increment the counter
            await confirmApiKeyUsage(keyInfo.index);

            return processedText;

        } catch (error: unknown) {
            lastError = error as Error;

            // Extract error code from the error message
            const statusCode = extractErrorCode(error);

            // Check if this is a technical error that should trigger rotation
            if (shouldRotateOnError(statusCode)) {
                console.warn(`[AI Client] API error ${statusCode}, rotating key and retrying...`);

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey();
                retries--;
                continue;
            }

            // For non-technical errors (e.g., invalid input), throw immediately
            // DO NOT increment counter for failed requests
            throw error;
        }
    }

    throw lastError || new Error("Failed to process text after maximum retries");
}

/**
 * Process text with AI and return a stream
 * 
 * Features:
 * - Automatic key rotation on technical errors
 * - Counter only increments on successful stream start
 * - Automatic retry with different key on failure
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @returns ReadableStream of text chunks
 */
export async function streamWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier
): Promise<ReadableStream<Uint8Array>> {
    const config = MODEL_CONFIG[operation];
    const modelName = config[tier];

    if (!modelName) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    let retries = MAX_RETRY_ATTEMPTS;
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        try {
            // Get API key for this request (does NOT increment counter)
            keyInfo = keyInfo || await getApiKeyForRequest();

            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: modelName,
                generationConfig,
            });

            // Try to start the stream - this is where errors typically occur
            const result = await model.generateContentStream([
                { text: systemPrompt },
                { text: text },
            ]);

            // Stream started successfully, confirm usage
            await confirmApiKeyUsage(keyInfo.index);

            // Capture keyInfo for error handling within stream
            const currentKeyInfo = keyInfo;

            return new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    try {
                        for await (const chunk of result.stream) {
                            const chunkText = chunk.text();
                            controller.enqueue(encoder.encode(chunkText));
                        }
                        controller.close();
                    } catch (err) {
                        // If streaming fails mid-way, check if it's a rotatable error
                        const streamErrorCode = extractErrorCode(err);
                        if (shouldRotateOnError(streamErrorCode)) {
                            console.warn(`[AI Client] Stream error ${streamErrorCode}, key ${currentKeyInfo.index} may be exhausted`);
                            // Note: We can't retry mid-stream, but we log for debugging
                        }
                        controller.error(err);
                    }
                }
            });

        } catch (error: unknown) {
            lastError = error as Error;

            // Extract error code from the error message
            const statusCode = extractErrorCode(error);

            // Check if this is a technical error that should trigger rotation
            if (shouldRotateOnError(statusCode)) {
                console.warn(`[AI Client] Stream API error ${statusCode}, rotating key and retrying...`);

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey();
                retries--;
                continue;
            }

            // For non-technical errors, throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to start stream after maximum retries");
}

// Re-export ROTATION_ERROR_CODES for external use
export { ROTATION_ERROR_CODES };
