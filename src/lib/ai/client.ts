import { GoogleGenerativeAI } from "@google/generative-ai";
import {
    getApiKeyForRequest,
    getApiKeys,
    confirmApiKeyUsage,
    forceKeyRotationAndGetKey,
    shouldRotateOnError,
    is503OrOverloadError,
    getModelCircuitState,
    tryAcquireHalfOpenProbe,
    releaseProbeLock,
    recordModelSuccess,
    recordModelFailure,
    classifyGeminiError,
    maskApiKey,
    sanitizeErrorMessage,
    ROTATION_ERROR_CODES,
    KeyInfo,
    CircuitBreakerOpenError,
} from "./key-rotation";
import { AI_PROMPTS, AIOperation } from "./prompts";

import modelsConfig from "@/config/models.config.json";

// Model configurations per operation and tier loaded from central JSON
export const MODEL_CONFIG = modelsConfig;

export type Tier = "free" | "pro" | "ultra";

/**
 * Dynamically resolve maximum retry attempts based on the configured key pool size.
 * Allows larger key pools (e.g. 10-20 keys) to rotate through healthy keys without early abortion.
 */
function getMaxRetryAttempts(): number {
    const keyCount = getApiKeys().length;
    return Math.min(Math.max(6, keyCount), 10);
}

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

    // Typed projection of the JSON entry: per-tier model ids plus an optional
    // fallback that is either a per-tier map or a bare model identifier.
    type ModelEntry = Partial<Record<Tier, string | null>> & {
        fallback?: Partial<Record<Tier, string | null>> | string;
    };
    const entry = config as unknown as ModelEntry;

    const primary = entry[tier] ?? null;
    let fallback: string | null = null;

    if (entry.fallback && typeof entry.fallback === "object") {
        fallback = entry.fallback[tier] ?? null;
    } else if (typeof entry.fallback === "string") {
        fallback = entry.fallback;
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
 * Determine the active model to use, factoring in the distributed 3-state Circuit Breaker:
 * - CLOSED: Use primary model.
 * - OPEN: Bypass primary model and use fallback model (Fast-Path).
 * - HALF-OPEN: Only one single probe request is permitted to test primary; others use fallback.
 */
async function selectModelWithCircuitBreaker(
    primary: string | null,
    fallback: string | null
): Promise<{ selectedModel: string; isProbe: boolean }> {
    if (!primary && !fallback) {
        throw new Error("No model configured for this operation and tier");
    }

    if (!primary) {
        return { selectedModel: fallback!, isProbe: false };
    }

    if (!fallback) {
        // Only primary available - check circuit state
        const circuitState = await getModelCircuitState(primary);
        if (circuitState === "open") {
            throw new CircuitBreakerOpenError(primary);
        }
        return { selectedModel: primary, isProbe: circuitState === "half-open" };
    }

    const circuitState = await getModelCircuitState(primary);

    if (circuitState === "open") {
        console.log(`[Circuit Breaker] Fast-path active: Primary model '${primary}' is OPEN. Using fallback '${fallback}'`);
        return { selectedModel: fallback, isProbe: false };
    }

    if (circuitState === "half-open") {
        const wonProbe = await tryAcquireHalfOpenProbe(primary);
        if (wonProbe) {
            console.log(`[Circuit Breaker] Half-Open Single Probe acquired for primary model '${primary}'`);
            return { selectedModel: primary, isProbe: true };
        } else {
            console.log(`[Circuit Breaker] Half-Open probe in flight: Routing concurrent request to fallback '${fallback}'`);
            return { selectedModel: fallback, isProbe: false };
        }
    }

    // Default CLOSED state
    return { selectedModel: primary, isProbe: false };
}

/**
 * Process text with AI (synchronous complete generation).
 * 
 * Features:
 * - 3-State Distributed Circuit Breaker (Closed, Open, Half-Open Single Probe)
 * - Immediate 503 Failover to secondary fallback model
 * - Automatic Concurrency-Safe Key Rotation & Quota Cooldown in Redis
 * - Strict Data Sanitization (Masked credentials, zero sensitive text logging)
 * - Native AbortSignal Support
 * - Structured Error Classification & Fast-Fail on 400 Bad Request
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @param signal - Optional AbortSignal for request cancellation
 * @returns Processed text
 */
export async function processWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier,
    signal?: AbortSignal
): Promise<string> {
    if (signal?.aborted) {
        const abortErr = new Error("The operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const { primary, fallback } = getModelPair(operation, tier);

    if (!primary && !fallback) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Initial model selection via Circuit Breaker state
    const { selectedModel: initialModel, isProbe: initialIsProbe } =
        await selectModelWithCircuitBreaker(primary, fallback);

    let targetModel = initialModel;
    let isProbe = initialIsProbe;
    let triedFallbackInRequest = targetModel === fallback;
    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (signal?.aborted) {
            if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
            const abortErr = new Error("The operation was aborted");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        try {
            // Get active healthy API key from Redis pool
            keyInfo = keyInfo || (await getApiKeyForRequest());

            // Initialize Gemini client
            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Generate content — propagate the downstream abort signal to the provider
            // HTTP request so cancellation terminates the upstream socket immediately.
            const result = await model.generateContent(
                [
                    { text: systemPrompt },
                    { text: text },
                ],
                { signal }
            );

            if (signal?.aborted) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            const response = result.response;
            const processedText = response.text();

            // SUCCESS: Increment the usage counter in Redis
            await confirmApiKeyUsage(keyInfo.index);

            // Record success for the model to reset / close circuit if probing
            if (currentModel === primary) {
                await recordModelSuccess(primary);
            }

            return processedText;

        } catch (error: unknown) {
            lastError = error as Error;

            // Classify error
            const classification = classifyGeminiError(error);

            // 1. Cancellation -> Fail fast without retrying
            if (classification.category === "cancelled" || signal?.aborted) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("The operation was aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            // 2. Non-rotatable Client Error (400 Bad Request, Safety Filter) -> Fail fast
            if (classification.category === "invalid_request") {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                console.warn(`[AI Client] Non-rotatable request error on operation '${operation}':`, classification.reason);
                throw error;
            }

            // 3. Model Overload / 503 -> Failover immediately to fallback model
            if (
                (classification.category === "overload" || is503OrOverloadError(error)) &&
                primary &&
                fallback &&
                !triedFallbackInRequest
            ) {
                console.warn(
                    `[AI Client] Model '${primary}' returned 503/Overload. Failing over to fallback '${fallback}' in same request...`
                );

                // Record failure and trip circuit breaker in Redis
                recordModelFailure(primary).catch(() => {});

                targetModel = fallback;
                triedFallbackInRequest = true;
                isProbe = false;
                continue; // Retry immediately with fallback model
            }

            // If probe failed on a non-overload error, release lock
            if (isProbe && primary) {
                releaseProbeLock(primary).catch(() => {});
                isProbe = false;
            }

            // 4. Rotatable technical errors (429 Quota, 401 Auth, 500/502/504 Transient)
            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Client] Request failed on key index ${keyInfo?.index ?? "unknown"} (${maskApiKey(keyInfo?.key)}): ${classification.reason}. Rotating key and retrying...`
                );

                // Force rotation and get next healthy key
                keyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            // Unclassified or non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to process text after maximum retries");
}

/**
 * Process text with AI and return an active ReadableStream of text chunks.
 * 
 * Features:
 * - 3-State Distributed Circuit Breaker (Closed, Open, Half-Open Single Probe)
 * - In-flight 503 Failover to secondary model on initiation
 * - Native AbortSignal support with stream cleanup and downstream cancel handling
 * - Unhandled Rejection Prevention
 * - Strict Credential & Content Sanitization
 * - Upstash Redis Concurrency-Safe Usage Updates
 * 
 * @param operation - The AI operation to perform
 * @param text - The input text to process
 * @param tier - User's subscription tier
 * @param signal - Optional Client abort signal for cancellation
 * @returns ReadableStream of encoded UTF-8 text chunks
 */
export async function streamWithAI(
    operation: AIOperation,
    text: string,
    tier: Tier,
    signal?: AbortSignal
): Promise<ReadableStream<Uint8Array>> {
    if (signal?.aborted) {
        const abortErr = new Error("Stream aborted before initialization");
        abortErr.name = "AbortError";
        throw abortErr;
    }

    const { primary, fallback } = getModelPair(operation, tier);

    if (!primary && !fallback) {
        throw new Error(`Operation '${operation}' is not available for ${tier} tier`);
    }

    const systemPrompt = AI_PROMPTS[operation];
    const generationConfig = buildGenerationConfig(operation, tier);

    // Initial model selection via Circuit Breaker
    const { selectedModel: initialModel, isProbe: initialIsProbe } =
        await selectModelWithCircuitBreaker(primary, fallback);

    let targetModel = initialModel;
    let isProbe = initialIsProbe;
    let triedFallbackInRequest = targetModel === fallback;
    let retries = getMaxRetryAttempts();
    let lastError: Error | null = null;
    let keyInfo: KeyInfo | null = null;

    while (retries > 0) {
        if (signal?.aborted) {
            if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
            const abortErr = new Error("Stream aborted during key acquisition");
            abortErr.name = "AbortError";
            throw abortErr;
        }

        const currentModel = targetModel || fallback;
        if (!currentModel) {
            throw new Error(`No available model configured for operation '${operation}' in ${tier} tier`);
        }

        try {
            // Get active healthy API key from Redis pool
            keyInfo = keyInfo || (await getApiKeyForRequest());

            const genAI = new GoogleGenerativeAI(keyInfo.key);

            const model = genAI.getGenerativeModel({
                model: currentModel,
                generationConfig,
            });

            // Start stream generation — propagate the downstream abort signal to the
            // provider HTTP request. Without this, client disconnects and user aborts
            // never cancel the upstream Gemini socket and the server stays pinned
            // (reader.read() blocks) until the model finishes generating on its own.
            const result = await model.generateContentStream(
                [
                    { text: systemPrompt },
                    { text: text },
                ],
                { signal }
            );

            // Prevent unhandled promise rejection on SDK response promise
            if (result && result.response && typeof result.response.catch === "function") {
                result.response.catch(() => {});
            }

            // Stream started successfully, confirm usage in Redis
            await confirmApiKeyUsage(keyInfo.index);

            // Record success for model in circuit breaker
            if (currentModel === primary) {
                recordModelSuccess(primary).catch(() => {});
            }

            const currentKeyInfo = keyInfo;
            const activeModel = currentModel;
            let isStreamCancelled = false;

            return new ReadableStream<Uint8Array>({
                async start(controller) {
                    const encoder = new TextEncoder();

                    try {
                        for await (const chunk of result.stream) {
                            if (signal?.aborted || isStreamCancelled) {
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
                        if (signal?.aborted || isStreamCancelled) {
                            return; // Suppress downstream error if cancelled
                        }

                        console.error(
                            `[AI Client] Mid-stream exception on model '${activeModel}' (key index ${currentKeyInfo.index}):`,
                            sanitizeErrorMessage((streamErr as Error)?.message || String(streamErr))
                        );

                        if (is503OrOverloadError(streamErr)) {
                            // Trip circuit breaker in Redis for overloaded model
                            recordModelFailure(activeModel).catch(() => {});
                        } else if (shouldRotateOnError(streamErr)) {
                            // Rotate key in Redis for subsequent requests
                            forceKeyRotationAndGetKey(streamErr).catch(() => {});
                        }

                        controller.error(streamErr);
                    }
                },
                cancel() {
                    // Downstream cancel handler: immediately break generator loop
                    isStreamCancelled = true;
                },
            });

        } catch (error: unknown) {
            lastError = error as Error;

            const classification = classifyGeminiError(error);

            // 1. Cancellation -> Fail fast
            if (classification.category === "cancelled" || signal?.aborted) {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                const abortErr = new Error("Stream aborted");
                abortErr.name = "AbortError";
                throw abortErr;
            }

            // 2. Non-rotatable Client Error (400 Bad Request, Safety Filter) -> Fail fast
            if (classification.category === "invalid_request") {
                if (isProbe && primary) releaseProbeLock(primary).catch(() => {});
                console.warn(`[AI Client] Non-rotatable stream initialization error on '${operation}':`, classification.reason);
                throw error;
            }

            // 3. In-flight 503 / Overload -> Immediately failover to fallback model
            if (
                (classification.category === "overload" || is503OrOverloadError(error)) &&
                primary &&
                fallback &&
                !triedFallbackInRequest
            ) {
                console.warn(
                    `[AI Client] Stream initiation on '${primary}' returned 503/Overload. Failing over to fallback model '${fallback}' in same request...`
                );

                // Record failure and trip circuit in Redis
                recordModelFailure(primary).catch(() => {});

                targetModel = fallback;
                triedFallbackInRequest = true;
                isProbe = false;
                continue; // Retry with fallback model
            }

            if (isProbe && primary) {
                releaseProbeLock(primary).catch(() => {});
                isProbe = false;
            }

            // 4. Rotatable technical errors (429, 401, 500, etc.)
            if (classification.retryableWithKey || shouldRotateOnError(error)) {
                console.warn(
                    `[AI Client] Stream initialization failed on key index ${keyInfo?.index ?? "unknown"} (${classification.reason}), rotating key and retrying...`
                );

                // Force rotation and get new key for immediate retry
                keyInfo = await forceKeyRotationAndGetKey(error);
                retries--;
                continue;
            }

            // Non-rotatable errors throw immediately
            throw error;
        }
    }

    throw lastError || new Error("Failed to start stream after maximum retries");
}

// Re-export ROTATION_ERROR_CODES & CircuitBreakerOpenError for external use
export { ROTATION_ERROR_CODES, CircuitBreakerOpenError };
