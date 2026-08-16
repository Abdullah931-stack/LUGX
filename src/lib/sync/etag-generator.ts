/**
 * ETag Generator for Sync System
 * 
 * Generates Strong ETags using SHA-256 hash for reliable change detection.
 * Used both client-side and server-side for consistency.
 */

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
}): Promise<string> {
    const updatedAtStr = content.updatedAt instanceof Date
        ? content.updatedAt.toISOString()
        : new Date(content.updatedAt).toISOString();

    const dataToHash = `${content.id}${content.content || ''}${updatedAtStr}`;

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
    throw new Error('Crypto API not available');
}

/**
 * Generate ETag synchronously (for server-side use with Node.js crypto)
 */
export function generateETagSync(content: {
    id: string;
    content: string;
    updatedAt: Date | number;
}): string {
    // Dynamic import to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');

    const updatedAtStr = content.updatedAt instanceof Date
        ? content.updatedAt.toISOString()
        : new Date(content.updatedAt).toISOString();

    const dataToHash = `${content.id}${content.content || ''}${updatedAtStr}`;

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
