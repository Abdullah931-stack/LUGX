/**
 * Utility functions for file naming, copy title resolution, and restored title resolution.
 */

/**
 * Generate a non-colliding restored title by appending `(Restored)` or `(Restored N)`
 * before the file extension if present.
 */
export function generateRestoredTitle(originalTitle: string, counter = 1): string {
    const suffix = counter === 1 ? " (Restored)" : ` (Restored ${counter})`;
    const lastDot = originalTitle.lastIndexOf(".");

    if (lastDot > 0) {
        const base = originalTitle.substring(0, lastDot);
        const ext = originalTitle.substring(lastDot);
        return `${base}${suffix}${ext}`;
    }

    return `${originalTitle}${suffix}`;
}

/**
 * Generate a non-colliding copy title by appending `(Copy)` or `(Copy N)`
 * before the file extension if present.
 */
export function generateCopyTitle(originalTitle: string, counter = 1): string {
    const suffix = counter === 1 ? " (Copy)" : ` (Copy ${counter})`;
    const lastDot = originalTitle.lastIndexOf(".");

    if (lastDot > 0) {
        const base = originalTitle.substring(0, lastDot);
        const ext = originalTitle.substring(lastDot);
        return `${base}${suffix}${ext}`;
    }

    return `${originalTitle}${suffix}`;
}
