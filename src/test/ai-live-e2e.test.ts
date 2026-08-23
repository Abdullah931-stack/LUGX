import { describe, it, expect } from "vitest";
import { streamWithAI, processWithAI } from "@/lib/ai/client";
import { getRotationStatus } from "@/lib/ai/key-rotation";
import dotenv from "dotenv";

// Load actual local environment keys for live testing
dotenv.config({ path: ".env.local" });

describe("AI Live Integration & Key Rotation", () => {
    it("should successfully stream translation chunks using live keys", async () => {
        const stream = await streamWithAI(
            "translate",
            "Artificial intelligence in LUGX is resilient and scalable.",
            "free"
        );

        expect(stream).toBeInstanceOf(ReadableStream);

        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullOutput = "";
        let chunks = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks++;
            fullOutput += decoder.decode(value);
        }

        expect(chunks).toBeGreaterThan(0);
        expect(fullOutput.trim().length).toBeGreaterThan(0);
        console.log(`[E2E Stream Output] ${fullOutput.trim()}`);
    }, 30000);

    it("should successfully process text with improve operation", async () => {
        const result = await processWithAI(
            "improve",
            "This application have very good code architecture.",
            "free"
        );

        expect(typeof result).toBe("string");
        expect(result.trim().length).toBeGreaterThan(0);
        console.log(`[E2E Improve Output] ${result.trim()}`);
    }, 30000);

    it("should inspect live rotation status in Upstash Redis", async () => {
        const status = await getRotationStatus();
        expect(status).toBeDefined();
        expect(typeof status.currentKeyIndex).toBe("number");
        expect(status.totalKeys).toBeGreaterThanOrEqual(1);
        console.log(`[E2E Rotation Status]`, status);
    });
});
