/**
 * Utility functions for file naming, copy title resolution, and restored title resolution.
 * Remediates LUGX-138 by enforcing that generated titles never exceed PostgreSQL varchar(500) limits.
 */

export const MAX_TITLE_LENGTH = 500;

/**
 * Generate a non-colliding restored title by appending `(Restored)` or `(Restored N)`
 * before the file extension if present, truncating base to guarantee length <= 500.
 */
export function generateRestoredTitle(originalTitle: string, counter = 1): string {
    const suffix = counter === 1 ? " (Restored)" : ` (Restored ${counter})`;
    const lastDot = originalTitle.lastIndexOf(".");

    if (lastDot > 0) {
        const ext = originalTitle.substring(lastDot);
        const maxBaseLength = Math.max(0, MAX_TITLE_LENGTH - suffix.length - ext.length);
        const base = originalTitle.substring(0, lastDot).slice(0, maxBaseLength);
        return `${base}${suffix}${ext}`;
    }

    const maxBaseLength = Math.max(0, MAX_TITLE_LENGTH - suffix.length);
    const base = originalTitle.slice(0, maxBaseLength);
    return `${base}${suffix}`;
}

/**
 * Generate a non-colliding copy title by appending `(Copy)` or `(Copy N)`
 * before the file extension if present, truncating base to guarantee length <= 500.
 */
export function generateCopyTitle(originalTitle: string, counter = 1): string {
    const suffix = counter === 1 ? " (Copy)" : ` (Copy ${counter})`;
    const lastDot = originalTitle.lastIndexOf(".");

    if (lastDot > 0) {
        const ext = originalTitle.substring(lastDot);
        const maxBaseLength = Math.max(0, MAX_TITLE_LENGTH - suffix.length - ext.length);
        const base = originalTitle.substring(0, lastDot).slice(0, maxBaseLength);
        return `${base}${suffix}${ext}`;
    }

    const maxBaseLength = Math.max(0, MAX_TITLE_LENGTH - suffix.length);
    const base = originalTitle.slice(0, maxBaseLength);
    return `${base}${suffix}`;
}
