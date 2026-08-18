import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    getApiKeyForRequest,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    is503OrOverloadError,
    isModelCircuitOpen,
    recordModelFailure,
    extractErrorCode,
    ROTATION_ERROR_CODES,
    KeyInfo,
} from "./key-rotation";
import { AI_PROMPTS, AIOperation } from "./prompts";

import modelsConfig from "@/config/models.config.json";

// Model configurations per operation and tier loaded from central JSON
export const MODEL_CONFIG = modelsConfig;

export type Tier = "free" | "pro" | "ultra";

// Maximum retry attempts for key rotation
const MAX_RETRY_ATTEMPTS = 6;

/**
 * Resolve primary and fallback model names for an operation and subscription tier.
 * Declarations are strictly sourced from models.config.json.
 */
export function getModelPair(
    operation: AIOperation,
    tier: Tier
): { primary: string | null; fallback: string | null } {
    const config = MODEL_CONFIG[operation];
    if (!config) {
        return { primary: null, fallback: null };
    }

    const primary = (config as any)[tier] ?? null;
    let fallback: string | null = null;

    if (config.fallback && typeof config.fallback === "object") {
        fallback = (config.fallback as any)[tier] ?? null;
    } else if (typeof (config as any).fallback === "string") {
        fallback = (config as any).fallback;
    }

    return { primary, fallback };
}

/**
 * Build generation config for a specific operation and tier.
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
 * Process text with AI (synchronous complete generation).
 * 
 * Features:
 * - Distributed Circuit Breaker: Automatically routes to fallback model if primary is overloaded in Redis
 * - Immediate 503 Failover: If primary model returns 503, seamlessly retries with fallback model in same call
 * - Automatic Key Rotation: Rotates API key upon 429 quota exhaustion or technical errors
 * - Upstash Redis Synchronization: Increments usage only on verified success
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
    const { primary, fallback } = getModelPair(operation, tier);

    if (!primary && !fallback) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Fast-path: Check if primary model's circuit breaker is currently OPEN in Redis
    let targetModel = primary;
    if (primary && fallback && (await isModelCircuitOpen(primary))) {
        console.log(`[Circuit Breaker] Fast-path active: Primary model '${primary}' is overloaded. Using fallback '${fallback}'`);
        targetModel = fallback;
    }

    let retries = MAX_RETRY_ATTEMPTS;
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;
    let triedFallbackInRequest = targetModel === fallback;

    while (retries > 0) {
        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        try {
            // Get active API key from Redis pool
            keyInfo = keyInfo || await getApiKeyForRequest();

            // Initialize Gemini client
            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Generate content
            const result = await model.generateContent([
                { text: systemPrompt },
                { text: text },
            ]);

            const response = result.response;
            const processedText = response.text();

            // SUCCESS: Increment the usage counter in Redis
            await confirmApiKeyUsage(keyInfo.index);

            return processedText;

        } catch (error: unknown) {
            lastError = error as Error;

            // Model Overload / 503 Handling -> Switch to fallback model immediately
            if (is503OrOverloadError(error) && primary && fallback && !triedFallbackInRequest) {
                console.warn(`[AI Client] Model '${primary}' returned 503/Overload. Failing over immediately to fallback '${fallback}' in same request...`);

                // Record failure and trip circuit breaker in Redis
                recordModelFailure(primary).catch(() => {});

                targetModel = fallback;
                triedFallbackInRequest = true;
                continue; // Retry immediately with fallback model
            }

            const statusCode = extractErrorCode(error);
            if (shouldRotateOnError(statusCode) || shouldRotateOnError(error)) {
                console.warn(`[AI Client] Request failed on key index ${keyInfo?.index ?? "unknown"}, rotating key and retrying... (${(error as Error)?.message || error})`);

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey();
                retries--;
                continue;
            }

            // Non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to process text after maximum retries");
}

/**
 * Process text with AI and return an active ReadableStream of text chunks.
 * 
 * Features:
 * - Distributed Circuit Breaker: Auto-bypasses overloaded primary models via Redis fast-path
 * - In-flight 503 Failover: Immediate transparent fallback to secondary model on 503 encounters
 * - Unhandled Rejection Prevention: Attaches rejection catchers to stream response promises
 * - Upstash Redis Integration: Confirms usage and updates rotation counters on successful stream start
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @param signal - Client abort signal for cancellation
 * @returns ReadableStream of encoded UTF-8 text chunks
 */
export async function streamWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier,
    signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
    const { primary, fallback } = getModelPair(operation, tier);

    if (!primary && !fallback) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    if (signal?.aborted) {
        throw new Error("Stream aborted before initialization");
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Fast-path: Check if primary model is marked as overloaded in Redis
    let targetModel = primary;
    if (primary && fallback && (await isModelCircuitOpen(primary))) {
        console.log(`[Circuit Breaker] Fast-path active: Primary model '${primary}' circuit is OPEN. Using fallback '${fallback}'`);
        targetModel = fallback;
    }

    let retries = MAX_RETRY_ATTEMPTS;
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;
    let triedFallbackInRequest = targetModel === fallback;

    while (retries > 0) {
        if (signal?.aborted) {
            throw new Error("Stream aborted during key acquisition");
        }

        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        try {
            // Get active API key from Redis pool
            keyInfo = keyInfo || await getApiKeyForRequest();

            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Start stream generation
            const result = await model.generateContentStream([
                { text: systemPrompt },
                { text: text },
            ]);

            // Prevent unhandled promise rejection on SDK response promise
            if (result && result.response && typeof result.response.catch === "function") {
                result.response.catch(() => {});
            }

            // Stream started successfully, confirm usage in Redis
            await confirmApiKeyUsage(keyInfo.index);

            const currentKeyInfo = keyInfo;
            const activeModel = currentModel;

            return new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder();

                    try {
                        for await (const chunk of result.stream) {
                            if (signal?.aborted) {
                                controller.close();
                                return;
                            }

                            const chunkText = chunk.text();
                            if (chunkText) {
                                controller.enqueue(encoder.encode(chunkText));
                            }
                        }

                        controller.close();

                    } catch (streamErr) {
                        console.error(`[AI Client] Mid-stream exception on model '${activeModel}' (key ${currentKeyInfo.index}):`, (streamErr as Error)?.message || streamErr);

                        if (is503OrOverloadError(streamErr)) {
                            // Trip circuit breaker in Redis for overloaded model
                            recordModelFailure(activeModel).catch(() => {});
                        } else if (shouldRotateOnError(streamErr)) {
                            // Rotate key in Redis for subsequent requests
                            forceKeyRotationAndGetKey().catch(() => {});
                        }

                        controller.error(streamErr);
                    }
                },
                cancel() {
                    // Downstream cancel handler
                }
            });

        } catch (error: unknown) {
            lastError = error as Error;

            // In-flight 503 / Overload -> Immediately failover to fallback model in the same call
            if (is503OrOverloadError(error) && primary && fallback && !triedFallbackInRequest) {
                console.warn(`[AI Client] Stream initiation on '${primary}' returned 503/Overload. Failing over immediately to fallback model '${fallback}' in same request...`);

                // Record failure and trip circuit in Redis
                recordModelFailure(primary).catch(() => {});

                targetModel = fallback;
                triedFallbackInRequest = true;
                continue; // Retry with fallback model
            }

            const statusCode = extractErrorCode(error);
            if (shouldRotateOnError(statusCode) || shouldRotateOnError(error)) {
                console.warn(`[AI Client] Stream API error ${statusCode || (error as Error)?.message}, rotating key and retrying...`);

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey();
                retries--;
                continue;
            }

            // Non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to start stream after maximum retries");
}

// Re-export ROTATION_ERROR_CODES for external use
export { ROTATION_ERROR_CODES };
