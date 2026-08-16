/**
 * Server-only smart HTML conversion for the import pipeline.
 *
 * Wraps the client-safe converters (text/markdown, escapeHtml-hardened)
 * with a DOMPurify chokepoint for raw HTML input. This module is imported
 * ONLY by server actions (import-file.ts); the editor client component
 * uses ./text-to-html.ts directly, which has zero DOMPurify/jsdom bytes.
 */
import {
    convertTextToHTML,
    convertMarkdownToHTML,
    isHTML,
} from "@/lib/parsers/text-to-html";
import { sanitizeHtml } from "@/lib/sanitize.server";

export function smartConvertToHTML(
    text: string,
    fileType: "md" | "txt" | "pdf"
): string {
    // Security chokepoint (SERVER ONLY):
    // ANY HTML that enters TipTap from an import is sanitized through
    // DOMPurify against the TipTap allow-list. This neutralizes stored XSS
    // from imported files regardless of which branch produced the HTML.
    let html: string;

    if (isHTML(text)) {
        html = sanitizeHtml(text);
    } else {
        // Plain-text/markdown paths are already escapeHtml-hardened in
        // the converters below.
        html =
            fileType === "md"
                ? convertMarkdownToHTML(text)
                : convertTextToHTML(text);
    }

    return sanitizeHtml(html);
}
