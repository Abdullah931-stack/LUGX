import { sanitizeHtml } from "@/lib/sanitize-client";
import { convertMarkdownToHTML } from "@/lib/parsers/text-to-html";

/**
 * Stream Markdown Parser and Sanitizer
 *
 * Provides safe transformation of streaming AI text into sanitized HTML:
 * 1. Sanitizes partial and final AI text to prevent script injection (XSS).
 * 2. Handles open Markdown fences / unclosed formatting gracefully during streaming.
 * 3. Prepares pristine HTML output for the single atomic TipTap commit.
 */

/**
 * Sanitize text chunk for live ephemeral preview display
 */
export function sanitizePreviewChunk(rawText: string): string {
    if (!rawText) return "";
    // Basic text escaping for safe ephemeral rendering
    return rawText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

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

/**
 * Convert completed streaming AI text into validated, sanitized HTML (for ephemeral preview display only)
 */
export function formatStreamOutputToHTML(rawText: string): {
    html: string;
    isEmpty: boolean;
} {
    const trimmed = rawText.trim();
    if (!trimmed) {
        return { html: "", isEmpty: true };
    }

    // Convert raw Markdown text to structured HTML
    const converted = convertMarkdownToHTML(trimmed);

    // Apply strict DOMPurify sanitization
    const safeHtml = sanitizeHtml(converted);

    return {
        html: safeHtml,
        isEmpty: safeHtml.trim().length === 0,
    };
}
