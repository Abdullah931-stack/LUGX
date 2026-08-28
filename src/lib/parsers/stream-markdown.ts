/**
 * Stream Markdown Parser & Validator
 *
 * Markdown is the single source of truth - no HTML conversion enters storage or preview.
 */

/**
 * Validate and prepare raw streaming Markdown output
 * Markdown is the single source of truth - no HTML conversion enters storage.
 */
export function validateStreamMarkdownOutput(rawText: string): {
    markdown: string;
    isEmpty: boolean;
    isValid: boolean;
} {
    if (!rawText || typeof rawText !== "string") {
        return { markdown: "", isEmpty: true, isValid: false };
    }

    const trimmed = rawText.trim();
    if (!trimmed) {
        return { markdown: "", isEmpty: true, isValid: false };
    }

    return {
        markdown: trimmed,
        isEmpty: false,
        isValid: true,
    };
}

