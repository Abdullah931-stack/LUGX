/**
 * Safe Redirect Validation and Resolution
 *
 * Implements strict internal path validation to eliminate Open Redirect
 * and Host Header Injection vulnerabilities across authentication flows.
 *
 * Security Requirements:
 * 1. Must be a relative path beginning with exactly one leading slash ("/").
 * 2. Blocks protocol-relative URLs ("//evil.com", "/\\evil.com", "\\evil.com") and any backslashes.
 * 3. Enforces MAX_URL_LENGTH (2048 chars) to guard against ReDoS and memory exhaustion.
 * 4. Normalizes Unicode (NFKC) and rejects homograph bypasses (／, ＼, zero-width chars).
 * 5. Strips all ASCII and Unicode control characters (0x00-0x1F, 0x7F, line/paragraph separators).
 * 6. Iteratively decodes percent-encoded payloads to detect hidden protocols or slashes ("/%2F%2Fevil.com").
 * 7. Rejects explicit or obfuscated protocol schemes (javascript:, data:, vbscript:, http:, https:).
 * 8. Returns a deterministic safe fallback (defaulting to "/dashboard") when validation fails.
 */

const DEFAULT_SAFE_PATH = "/dashboard";
const MAX_URL_LENGTH = 2048;

/**
 * Validates and resolves a redirect path to ensure it is strictly internal and safe.
 *
 * @param target - The untrusted redirect path or URL provided by the user/query.
 * @param defaultPath - The fallback internal path to use if target is invalid (defaults to "/dashboard").
 * @returns A safe, sanitized relative path string starting with "/".
 */
export function resolveSafeRedirectPath(
    target: string | null | undefined,
    defaultPath: string = DEFAULT_SAFE_PATH
): string {
    // 1. Fallback sanity check
    const safeFallback = typeof defaultPath === "string" && defaultPath.startsWith("/") && !defaultPath.startsWith("//") && !defaultPath.includes("\\")
        ? defaultPath
        : DEFAULT_SAFE_PATH;

    if (!target || typeof target !== "string") {
        return safeFallback;
    }

    // 2. Length check: Reject overlong payloads to prevent ReDoS / CPU exhaustion
    if (target.length > MAX_URL_LENGTH) {
        return safeFallback;
    }

    // 3. Unicode normalization (NFKC decomposes full-width characters and homographs)
    let normalized = target;
    try {
        normalized = target.normalize("NFKC");
    } catch {
        return safeFallback;
    }

    // Reject backslashes in any position (standard web paths on HTTP/HTTPS do not use backslashes)
    if (normalized.includes("\\")) {
        return safeFallback;
    }

    // Reject Unicode slash / backslash homographs and zero-width bypass sequences explicitly
    // \uFF0F (Full-width solidus), \uFE68 (Small reverse solidus), \uFF3C (Full-width reverse solidus),
    // \u200B-\u200D (Zero-width spaces/joiners), \uFEFF (BOM), \u2028/\u2029 (Line/Paragraph separators)
    if (/[\uFF0F\uFE68\uFF3C\u200B-\u200D\uFEFF\u2028\u2029]/.test(normalized)) {
        return safeFallback;
    }

    // 4. Strip all ASCII control characters (0x00-0x1F, 0x7F) and trim whitespace
    // eslint-disable-next-line no-control-regex
    const cleanTarget = normalized.trim().replace(/[\x00-\x1F\x7F]/g, "");
    if (!cleanTarget || !cleanTarget.startsWith("/")) {
        return safeFallback;
    }

    // Reject protocol-relative starting sequences immediately
    if (cleanTarget.startsWith("//")) {
        return safeFallback;
    }

    // 5. Multi-pass URL decoding to guard against nested encoding attacks (e.g. /%252F%252Fevil.com)
    let decoded = cleanTarget;
    for (let pass = 0; pass < 3; pass++) {
        try {
            const nextDecoded = decodeURIComponent(decoded);
            if (nextDecoded === decoded) break;
            decoded = nextDecoded;
        } catch {
            // Malformed percent-encoding
            return safeFallback;
        }
    }

    // Re-check for backslashes, control characters or homographs in decoded payload
    // eslint-disable-next-line no-control-regex
    if (decoded.includes("\\") || /[\x00-\x1F\x7F\uFF0F\uFE68\uFF3C\u200B-\u200D\uFEFF\u2028\u2029]/.test(decoded)) {
        return safeFallback;
    }

    // 6. Validate the fully decoded representation
    if (!decoded.startsWith("/") || decoded.startsWith("//")) {
        return safeFallback;
    }

    // Reject embedded schemes, communication protocols or pseudo-protocols
    const strippedLeadingSlashes = decoded.replace(/^\/+/, "");
    if (
        /^(javascript|data|vbscript|file|blob|about|mailto|tel|sms|urn):/i.test(strippedLeadingSlashes) ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(decoded) ||
        decoded.includes("://")
    ) {
        return safeFallback;
    }

    // 7. Semantic URL parsing verification against a fixed local base
    try {
        const dummyBase = "http://localhost";
        const parsed = new URL(cleanTarget, dummyBase);

        // Ensure origin did not mutate or get hijacked
        if (parsed.origin !== dummyBase) {
            return safeFallback;
        }

        // Ensure pathname starts with a single '/' and not '//'
        if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) {
            return safeFallback;
        }

        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return safeFallback;
    }
}
