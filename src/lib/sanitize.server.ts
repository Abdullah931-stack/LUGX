/**
 * Server-side content sanitization (XSS defense in depth).
 *
 * TipTap renders editor content as HTML, so any HTML that enters the system
 * (file content, AI output, import payloads) must be sanitized before it is
 * stored or rendered. Plain-text escapeHtml() is not enough for HTML input:
 * tags like <script>, <img onerror>, or javascript: URIs pass through it.
 *
 * This is the SERVER chokepoint (jsdom backend) used by the server action
 * pipeline. Browser callers use ./sanitize-client instead (native window,
 * no jsdom in the client bundle — see package.json "exports" which maps
 * "@/lib/sanitize" to sanitize-client in the browser).
 *
 * Allowed tags are the TipTap-default set used by the editor plus extras
 * needed by imported content. Dangerous elements (script, iframe, style,
 * object, embed, form, input, meta, link, svg/on* handlers) are stripped
 * by DOMPurify defaults.
 */
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export const SANITIZE_ALLOWED_TAGS = [
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "em", "u", "s", "strike",
    "ul", "ol", "li",
    "blockquote", "code", "pre", "hr",
    "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
    "div", "span",
];

// NOTE: `style` is deliberately excluded — inline styles can carry
// javascript: URIs (e.g. background:url(javascript:...)) which DOMPurify
// does not reliably strip. TipTap formatting relies on classes/tags, not
// inline styles; any inline styling from imports is discarded (fail safe).
export const SANITIZE_ALLOWED_ATTR = [
    "href", "src", "alt", "title",
    "class", "id",
    "target", "rel",
];

const purify = DOMPurify(new JSDOM("").window as never);

/**
 * Sanitize an HTML string so it is safe to render inside TipTap.
 * Returns "" for non-string/nullish input (fail closed).
 */
export function sanitizeHtml(input: unknown): string {
    if (typeof input !== "string") return "";
    return purify.sanitize(input, {
        ALLOWED_TAGS: SANITIZE_ALLOWED_TAGS,
        ALLOWED_ATTR: SANITIZE_ALLOWED_ATTR,
        // Convert relative javascript:-ish URIs; keep ftp/https only.
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
}
