/**
 * XSS defense tests for the sanitization chokepoint.
 *
 * Uses DOMPurify's own (well-known) XSS corpus vectors to prove that the
 * sanitizeHtml() chokepoint neutralizes stored-XSS payloads before they
 * reach TipTap, and that the text/markdown converters' output is likewise safe.
 */
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "@/lib/sanitize.server";
import { convertTextToHTML, convertMarkdownToHTML } from "@/lib/parsers/text-to-html";

// Minimal set of DOMPurify's official XSS corpus vectors — the canonical
// proof inputs for HTML sanitizers.
const XSS_VECTORS: [string, string][] = [
    ["<img src=x onerror=alert(1)>", "event handler stripped"],
    ["<script>alert(1)</script>", "script stripped"],
    ["<svg onload=alert(1)>", "svg handler stripped"],
    ["<body onload=alert(1)>", "body handler stripped"],
    ["<div style=\"background:url(javascript:alert(1))\">", "javascript URI stripped"],
    ["<a href=\"javascript:alert(1)\">x</a>", "javascript href stripped"],
    ["<img src=\"x\" onerror=\"alert(document.cookie)\">", "cookie theft blocked"],
    ["<details open ontoggle=alert(1)>", "ontoggle stripped"],
    ["<math><mtext><table><mglyph><svg><mtext><textarea><path id=\"</textarea><img onerror=alert(1)>\">", "nested mutation blocked"],
];

describe("sanitizeHtml chokepoint", () => {
    it("neutralizes every known XSS vector", () => {
        for (const [vector, label] of XSS_VECTORS) {
            const clean = sanitizeHtml(vector);
            expect(clean.toLowerCase()).not.toContain("onerror");
            expect(clean.toLowerCase()).not.toContain("onload");
            expect(clean.toLowerCase()).not.toContain("ontoggle");
            expect(clean.toLowerCase()).not.toContain("<script");
            expect(clean).not.toContain("javascript:");
            expect(clean).not.toContain("alert(");
        }
    });

    it("fails closed for non-string input", () => {
        expect(sanitizeHtml(null as unknown as string)).toBe("");
        expect(sanitizeHtml(undefined as unknown as string)).toBe("");
        expect(sanitizeHtml(42 as unknown as string)).toBe("");
        expect(sanitizeHtml("<script>alert(1)</script>")).not.toContain("script");
    });

    it("preserves legitimate TipTap formatting", () => {
        const input = "<p>Hello <strong>world</strong></p><ul><li>one</li></ul>";
        const clean = sanitizeHtml(input);
        expect(clean).toContain("<strong>world</strong>");
        expect(clean).toContain("<li>one</li>");
    });
});

describe("converter output is safe (stored-XSS via imports)", () => {
    it("convertTextToHTML output is XSS-proof (already escaped, re-sanitized)", () => {
        const out = convertTextToHTML("Line 1\nLine 2<script>x</script>");
        expect(out).not.toContain("<script>");
        expect(sanitizeHtml(out)).toBe(out); // idempotent
    });

    it("convertMarkdownToHTML output is XSS-proof", () => {
        const out = convertMarkdownToHTML("# Title\n<script>alert(1)</script>\n**bold**");
        expect(out).toContain("<h1>Title</h1>");
        expect(out).not.toContain("<script>");
        expect(sanitizeHtml(out)).toBe(out); // idempotent
    });
});
