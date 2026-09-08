/**
 * ETag Generator for Sync System
 * 
 * Generates Strong ETags using SHA-256 hash for reliable change detection.
 * Used both client-side and server-side for consistency.
 */

/**
 * Normalizes Markdown source text to LF line endings and Unicode NFC format.
 * This ensures deterministic ETag calculation and prevents spurious 412 conflicts
 * across different operating systems (Windows CRLF vs macOS/Linux LF).
 */
export function normalizeMarkdownSource(content: string | null | undefined): string {
    if (!content) return '';
    return content
        .replace(/\0/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .normalize('NFC');
}

import type { EncryptedEnvelope } from './types/vault';

/**
 * Deterministic canonical property order for EncryptedEnvelope serialization.
 * Guarantees identical JSON representation across different runtimes and key insertion orders.
 */
const CANONICAL_ENVELOPE_KEYS: (keyof EncryptedEnvelope)[] = [
    'version',
    'algorithm',
    'keyId',
    'salt',
    'iv',
    'kdfIterations',
    'ciphertext',
];

/**
 * Serializes an EncryptedEnvelope with deterministic canonical key ordering.
 */
export function serializeEncryptedEnvelope(envelope: EncryptedEnvelope | string): string {
    if (typeof envelope === 'string') {
        try {
            const parsed = JSON.parse(envelope);
            if (parsed && typeof parsed === 'object') {
                return JSON.stringify(parsed, CANONICAL_ENVELOPE_KEYS);
            }
        } catch {
            // Fall back to returning string as-is if not valid JSON
        }
        return envelope;
    }
    return JSON.stringify(envelope, CANONICAL_ENVELOPE_KEYS);
}

/**
 * Generate a Strong ETag for a serialized EncryptedEnvelope JSON.
 * Formula: ETag = SHA-256(Serialized EncryptedEnvelope JSON)[0..32]
 */
export function generateEncryptedETagSync(envelope: EncryptedEnvelope | string): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    const serialized = serializeEncryptedEnvelope(envelope);
    return crypto.createHash('sha256').update(serialized).digest('hex').substring(0, 32);
}

/**
 * Generate a Strong ETag for a serialized EncryptedEnvelope JSON asynchronously.
 */
export async function generateEncryptedETag(envelope: EncryptedEnvelope | string): Promise<string> {
    const serialized = serializeEncryptedEnvelope(envelope);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(serialized);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
    }
    return generateEncryptedETagSync(envelope);
}

/**
 * Generate a Strong ETag from file content
 * Uses SHA-256 hash, truncated to 32 characters for storage efficiency
 * 
 * @param content - Object containing file data for hashing
 * @returns 32-character hex string ETag
 */
export async function generateETag(content: {
    id: string;
    content: string;
    updatedAt: Date | number;
    isEncrypted?: boolean;
    envelope?: EncryptedEnvelope | string;
}): Promise<string> {
    if (content.isEncrypted && (content.envelope || content.content)) {
        return generateEncryptedETag(content.envelope || content.content);
    }

    const updatedAtStr = content.updatedAt instanceof Date
        ? content.updatedAt.toISOString()
        : new Date(content.updatedAt).toISOString();

    const normalizedContent = normalizeMarkdownSource(content.content);
    const dataToHash = `${content.id}${normalizedContent}${updatedAtStr}`;

    // Use Web Crypto API for browser environment
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const encoder = new TextEncoder();
        const data = encoder.encode(dataToHash);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex.substring(0, 32);
    }

    // Fallback for Node.js environment (server-side)
    return generateETagSync(content);
}

/**
 * Generate ETag synchronously (for server-side use with Node.js crypto)
 */
export function generateETagSync(content: {
    id: string;
    content: string;
    updatedAt: Date | number;
    isEncrypted?: boolean;
    envelope?: EncryptedEnvelope | string;
}): string {
    if (content.isEncrypted && (content.envelope || content.content)) {
        return generateEncryptedETagSync(content.envelope || content.content);
    }

    // Dynamic import to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');

    const updatedAtStr = content.updatedAt instanceof Date
        ? content.updatedAt.toISOString()
        : new Date(content.updatedAt).toISOString();

    const normalizedContent = normalizeMarkdownSource(content.content);
    const dataToHash = `${content.id}${normalizedContent}${updatedAtStr}`;

    const hash = crypto
        .createHash('sha256')
        .update(dataToHash)
        .digest('hex');

    return hash.substring(0, 32);
}


/**
 * Validate ETag format
 */
export function isValidETag(etag: string | null | undefined): boolean {
    if (!etag) return false;
    return /^[a-f0-9]{32}$/i.test(etag);
}

/**
 * Compare two ETags for equality
 * Normalizes ETags by stripping W/ prefix and quotes before comparison
 */
export function compareETags(
    localEtag: string | null | undefined,
    serverEtag: string | null | undefined
): boolean {
    if (!localEtag || !serverEtag) return false;

    // Normalize both ETags before comparison
    const normalizedLocal = normalizeETag(localEtag);
    const normalizedServer = normalizeETag(serverEtag);

    if (!normalizedLocal || !normalizedServer) return false;

    return normalizedLocal.toLowerCase() === normalizedServer.toLowerCase();
}

/**
 * Normalize an ETag by stripping W/ prefix and surrounding quotes
 */
function normalizeETag(etag: string): string {
    let normalized = etag.trim();

    // Strip weak indicator (W/)
    if (normalized.startsWith('W/')) {
        normalized = normalized.substring(2);
    }

    // Strip surrounding quotes
    if (normalized.startsWith('"') && normalized.endsWith('"')) {
        normalized = normalized.slice(1, -1);
    }

    return normalized;
}

/**
 * Parse ETag from HTTP header
 */
export function parseETagHeader(header: string | null): string | null {
    if (!header) return null;

    let etag = header.trim();
    if (etag.startsWith('W/')) {
        etag = etag.substring(2);
    }

    if (etag.startsWith('"') && etag.endsWith('"')) {
        etag = etag.slice(1, -1);
    }

    return etag;
}

/**
 * Format ETag for HTTP header
 */
export function formatETagHeader(etag: string): string {
    return `"${etag}"`;
}
