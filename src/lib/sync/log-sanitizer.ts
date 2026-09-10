/**
 * Log Sanitizer for Sync & Vault Subsystems
 *
 * Zero-Knowledge log hygiene: guarantees that document plaintext, ciphertext
 * envelopes, master keys, passwords, seeds, PINs, and raw key bytes never reach
 * console output, error logs, or performance metric stores.
 *
 * Design:
 * - Denylist-based key redaction (case-insensitive, substring match on
 *   normalized key names) with recursive traversal, depth limiting, and
 *   circular-reference protection.
 * - Inline message scrubbing for serialized `key: value` / `key=value` /
 *   `"key": "value"` patterns that may embed secrets inside free-form strings.
 * - Binary buffers (Uint8Array / ArrayBuffer) are replaced by a length-only
 *   placeholder so byte contents never serialize into logs.
 * - Benign operational keys (fileId, userId, url, etag, operationId, ...) pass
 *   through untouched so diagnostics remain useful.
 */

export const REDACTED = '[REDACTED]';

/**
 * Normalized sensitive key fragments. Any metadata key whose lowercased
 * alphanumeric-only form contains one of these fragments is redacted.
 */
const SENSITIVE_KEY_FRAGMENTS = [
    'content',
    'plaintext',
    'markdown',
    'ciphertext',
    'cipher',
    'wrappedkey',
    'encryptedmasterkey',
    'recoveryencryptedmasterkey',
    'masterkey',
    'localdevicekey',
    'devicekey',
    'kek',
    'mnemonic',
    'seed',
    'recoveryphrase',
    'password',
    'passwd',
    'pwd',
    'secret',
    'pin',
    'entropy',
    'iv',
    'salt',
    'aad',
] as const;

const SHORT_SENSITIVE_KEYS = new Set(['iv', 'pin', 'aad', 'kek', 'pwd']);

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveLogKey(key: string): boolean {
    const normalized = normalizeKey(key);
    if (!normalized) return false;

    // Split key into tokens supporting camelCase, snake_case, and kebab-case
    const tokens = key
        .split(/[^a-zA-Z0-9]+|(?<=[a-z])(?=[A-Z])/)
        .map((t) => t.toLowerCase())
        .filter(Boolean);

    return SENSITIVE_KEY_FRAGMENTS.some((fragment) => {
        if (SHORT_SENSITIVE_KEYS.has(fragment)) {
            return normalized === fragment || tokens.includes(fragment);
        }
        return normalized.includes(fragment);
    });
}

/**
 * Scrubs inline `key: value` occurrences inside a free-form message string.
 * Handles `key: value`, `key=value`, and `"key": "value"` spellings.
 */
export function sanitizeLogMessage(message: string): string {
    if (typeof message !== 'string' || message.length === 0) return message;
    let scrubbed = message;
    for (const fragment of SENSITIVE_KEY_FRAGMENTS) {
        // JSON style: "content": "secret..." or 'content': 'secret...'
        const jsonPattern = new RegExp(
            `(["'])${fragment}\\1\\s*:\\s*(["'])[^"']*\\2`,
            'gi'
        );
        scrubbed = scrubbed.replace(jsonPattern, `$1${fragment}$1: $2${REDACTED}$2`);

        const isShort = SHORT_SENSITIVE_KEYS.has(fragment);
        const keyRegexPart = isShort ? `\\b(?:\\w+_)?${fragment}\\b` : `\\b\\w*${fragment}\\w*\\b`;

        // Assignment style with '=' (delimited by whitespace, ampersand, or delimiters)
        const eqPattern = new RegExp(`${keyRegexPart}\\s*=\\s*[^\\s,;&]+`, 'gi');
        scrubbed = scrubbed.replace(eqPattern, (match) => {
            const sepIndex = match.indexOf('=');
            if (sepIndex === -1) return REDACTED;
            return `${match.slice(0, sepIndex + 1)} ${REDACTED}`;
        });

        // Colon style with ':' (can be multi-word until delimiter or end of line)
        const colonPattern = new RegExp(`${keyRegexPart}\\s*:\\s*[^,;\\n}\\]]+`, 'gi');
        scrubbed = scrubbed.replace(colonPattern, (match) => {
            const sepIndex = match.indexOf(':');
            if (sepIndex === -1) return REDACTED;
            return `${match.slice(0, sepIndex + 1)} ${REDACTED}`;
        });
    }
    return scrubbed;
}

function sanitizeBinaryPlaceholder(value: Uint8Array | ArrayBuffer): string {
    const length = value instanceof Uint8Array ? value.byteLength : value.byteLength;
    return `${REDACTED}:binary(${length}B)`;
}

export function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (depth > 6) return REDACTED;

    if (typeof value === 'string') return sanitizeLogMessage(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Uint8Array) return sanitizeBinaryPlaceholder(value);
    if (value instanceof ArrayBuffer) return sanitizeBinaryPlaceholder(value);
    if (value instanceof Error) {
        return {
            name: value.name,
            message: sanitizeLogMessage(value.message),
            stack: value.stack ? sanitizeLogMessage(value.stack) : undefined,
        };
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) return REDACTED;
        seen.add(value);
        try {
            return value.map((entry) => sanitizeLogValue(entry, depth + 1, seen));
        } finally {
            seen.delete(value);
        }
    }
    if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (seen.has(obj)) return REDACTED;
        seen.add(obj);
        try {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(obj)) {
                if (isSensitiveLogKey(key)) {
                    out[key] = REDACTED;
                } else {
                    out[key] = sanitizeLogValue(obj[key], depth + 1, seen);
                }
            }
            return out;
        } finally {
            seen.delete(obj);
        }
    }
    return value;
}

/**
 * Returns a sanitized deep copy of an arbitrary metadata record.
 * Never mutates the input.
 */
export function sanitizeMetadata<T>(metadata: T): T {
    if (metadata === null || metadata === undefined) return metadata;
    if (typeof metadata !== 'object') {
        return sanitizeLogValue(metadata) as T;
    }
    return sanitizeLogValue(metadata) as T;
}

/**
 * Test helper: asserts that a serialized haystack carries no trace of secret.
 */
export function serializedLogContainsSecret(haystack: unknown, secret: string): boolean {
    if (!secret) return false;
    try {
        return JSON.stringify(haystack)?.includes(secret) ?? false;
    } catch {
        return String(haystack).includes(secret);
    }
}
