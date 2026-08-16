/**
 * File Type Validation Utilities
 * Validates file types for LUGX import system
 * Allowed: .pdf, .md, .txt ONLY
 */

export const ALLOWED_FILE_TYPES = {
    PDF: 'application/pdf',
    MARKDOWN: 'text/markdown',
    TEXT: 'text/plain',
} as const;

export const ALLOWED_EXTENSIONS = ['.pdf', '.md', '.txt'] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface ValidationResult {
    isValid: boolean;
    error?: string;
    fileType?: 'pdf' | 'md' | 'txt';
}

/**
 * Validate file type and extension
 */
export function validateFile(file: File): ValidationResult {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
        return {
            isValid: false,
            error: `File size exceeds 10MB limit (${(file.size / 1024 / 1024).toFixed(2)}MB)`,
        };
    }

    // Get file extension
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];

    if (!extension || !ALLOWED_EXTENSIONS.includes(extension as any)) {
        return {
            isValid: false,
            error: `Invalid file type. Only PDF, MD, and TXT files are allowed.`,
        };
    }

    // Determine file type
    let fileType: 'pdf' | 'md' | 'txt';
    if (extension === '.pdf') {
        fileType = 'pdf';
    } else if (extension === '.md') {
        fileType = 'md';
    } else {
        fileType = 'txt';
    }

    // Validate MIME type
    const validMimeTypes = [
        ALLOWED_FILE_TYPES.PDF,
        ALLOWED_FILE_TYPES.MARKDOWN,
        ALLOWED_FILE_TYPES.TEXT,
        'text/x-markdown', // Alternative markdown MIME
    ];

    if (file.type && !validMimeTypes.includes(file.type)) {
        return {
            isValid: false,
            error: `Invalid MIME type: ${file.type}`,
        };
    }

    return {
        isValid: true,
        fileType,
    };
}

/**
 * Validate multiple files
 */
export function validateFiles(files: File[]): {
    valid: File[];
    invalid: Array<{ file: File; error: string }>;
} {
    const valid: File[] = [];
    const invalid: Array<{ file: File; error: string }> = [];

    for (const file of files) {
        const result = validateFile(file);
        if (result.isValid) {
            valid.push(file);
        } else {
            invalid.push({ file, error: result.error || 'Unknown error' });
        }
    }

    return { valid, invalid };
}
