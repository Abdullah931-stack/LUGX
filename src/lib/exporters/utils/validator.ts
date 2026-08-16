/**
 * Export Validator Utility
 * Handles validation and error checking for export operations
 */

import { ExportError } from '../types';

/**
 * Validate content before export
 * @param content - Content to validate
 * @throws ExportError if content is invalid
 */
export function validateContent(content: string): void {
    if (!content || content.trim().length === 0) {
        throw new ExportError('Content is empty or invalid', 'INVALID_CONTENT');
    }
}

/**
 * Validate filename
 * @param filename - Filename to validate
 * @throws ExportError if filename is invalid
 */
export function validateFilename(filename: string): void {
    if (!filename || filename.trim().length === 0) {
        throw new ExportError('Filename is empty or invalid', 'INVALID_CONTENT');
    }

    // Check for invalid characters in filename
    const invalidChars = /[<>:"/\\|?*]/g;
    if (invalidChars.test(filename)) {
        throw new ExportError(
            'Filename contains invalid characters',
            'INVALID_CONTENT'
        );
    }
}

/**
 * Sanitize filename by removing invalid characters
 * @param filename - Filename to sanitize
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
    // Remove invalid characters
    let sanitized = filename.replace(/[<>:"/\\|?*]/g, '');

    // Replace multiple spaces with single space
    sanitized = sanitized.replace(/\s+/g, ' ');

    // Trim
    sanitized = sanitized.trim();

    // If empty after sanitization, use default
    if (sanitized.length === 0) {
        sanitized = 'document';
    }

    return sanitized;
}

/**
 * Create a safe filename with extension
 * @param filename - Base filename
 * @param extension - File extension (without dot)
 * @returns Safe filename with extension
 */
export function createSafeFilename(filename: string, extension: string): string {
    const sanitized = sanitizeFilename(filename);
    return `${sanitized}.${extension}`;
}
