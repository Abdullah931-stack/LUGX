import { describe, it, expect } from "vitest";
import { getApiKeys, getRequestsPerKey, getRotationStatus, maskApiKey, classifyGeminiError } from "@/lib/ai/key-rotation";
import { getModelPair, MODEL_CONFIG } from "@/lib/ai/client";

/**
 * AI Provider Smoke Test:
 * Validates real configuration contracts, model pair mappings, error classifier structures,
 * and key masking without relying on unauthenticated live remote endpoints or mocking entire subsystems.
 */
describe("AI Provider Client Smoke Verification", () => {
    it("should correctly resolve model pairs across all operations and tiers", () => {
        const operations = ["correct", "improve", "summarize", "toPrompt", "translate"] as const;
        const tiers = ["free", "pro", "ultra"] as const;

        for (const op of operations) {
            for (const tier of tiers) {
                const pair = getModelPair(op, tier);
                if (op === "toPrompt" && tier === "free") {
                    expect(pair.primary).toBeNull();
                } else {
                    expect(pair.primary).toBeDefined();
                    expect(typeof pair.primary).toBe("string");
                }
            }
        }
    });

    it("should mask API keys without leaking characters", () => {
        const masked = maskApiKey("AIzaSyD-1234567890abcdef");
        expect(masked).toBe("AIza...cdef");
        expect(masked).not.toContain("1234567890");
    });

    it("should strictly classify non-rotatable errors", () => {
        const badRequestErr = new Error("400 Bad Request: Invalid input format");
        const classification = classifyGeminiError(badRequestErr);

        expect(classification.category).toBe("invalid_request");
        expect(classification.retryableWithKey).toBe(false);
        expect(classification.retryableWithModel).toBe(false);
    });

    it("should strictly classify quota errors as rotatable", () => {
        const quotaErr = new Error("429 Too Many Requests: quota exceeded");
        const classification = classifyGeminiError(quotaErr);

        expect(classification.category).toBe("quota");
        expect(classification.retryableWithKey).toBe(true);
    });
});
