import { describe, it, expect } from "vitest";
import { classifyGeminiError } from "@/lib/ai/key-rotation";

describe("Phase 11: Gemini HTTP 400 Key-Failure Error Classification", () => {
    it("classifies HTTP 400 with 'API key not valid' as authentication and retryable with key", () => {
        const error = new Error("API key not valid. Please pass a valid API key. [400 Bad Request]");
        (error as unknown as { status: number }).status = 400;

        const classification = classifyGeminiError(error);

        expect(classification.category).toBe("authentication");
        expect(classification.statusCode).toBe(400);
        expect(classification.retryableWithKey).toBe(true);
        expect(classification.retryableWithModel).toBe(false);
    });

    it("classifies HTTP 400 with 'SERVICE_DISABLED' as authentication and retryable with key", () => {
        const error = {
            message: "Generative Language API has not been used in project 123456 before or it is disabled. Enable it by visiting...",
            status: 400,
        };

        const classification = classifyGeminiError(error);

        expect(classification.category).toBe("authentication");
        expect(classification.statusCode).toBe(400);
        expect(classification.retryableWithKey).toBe(true);
    });

    it("classifies HTTP 400 with 'API_KEY_INVALID' as authentication and retryable with key", () => {
        const error = {
            message: "Request failed with error: API_KEY_INVALID",
            status: 400,
        };

        const classification = classifyGeminiError(error);

        expect(classification.category).toBe("authentication");
        expect(classification.retryableWithKey).toBe(true);
    });

    it("classifies HTTP 400 with 'consumer_suspended' as authentication and retryable with key", () => {
        const error = {
            message: "Consumer suspended. The project or API key is suspended.",
            status: 400,
        };

        const classification = classifyGeminiError(error);

        expect(classification.category).toBe("authentication");
        expect(classification.retryableWithKey).toBe(true);
    });

    it("preserves non-auth HTTP 400 (e.g., 'invalid argument') as invalid_request and NOT retryable with key", () => {
        const error = new Error("Invalid argument: prompt exceeds maximum tokens or malformed payload [400 Bad Request]");
        (error as unknown as { status: number }).status = 400;

        const classification = classifyGeminiError(error);

        expect(classification.category).toBe("invalid_request");
        expect(classification.statusCode).toBe(400);
        expect(classification.retryableWithKey).toBe(false);
        expect(classification.retryableWithModel).toBe(false);
    });
});
