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

    if (!extension || !(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
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

export interface DisguisedBinaryResult {
    isBinary: boolean;
    type?: string;
}

/**
 * Check if binary byte stream starts with known executable or compressed archive magic bytes
 */
export function isDisguisedBinary(bytes: Uint8Array): DisguisedBinaryResult {
    if (!bytes || bytes.length < 2) {
        return { isBinary: false };
    }

    // Windows PE Executable (MZ with binary DOS header markers)
    if (bytes[0] === 0x4d && bytes[1] === 0x5a && bytes.length >= 4) {
        const hasBinaryHeader = Array.from(bytes.slice(2, 16)).some((b) => b === 0x00 || b === 0x90);
        if (hasBinaryHeader) {
            return { isBinary: true, type: 'Windows Executable (PE)' };
        }
    }

    // Linux ELF Executable (\x7fELF)
    if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
        return { isBinary: true, type: 'Linux Executable (ELF)' };
    }

    // macOS Mach-O binaries (32-bit, 64-bit, and Universal binary FAT)
    if (bytes.length >= 4) {
        const isMachO =
            (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && (bytes[3] === 0xce || bytes[3] === 0xcf)) ||
            (bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
            (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
            (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe);
        if (isMachO) {
            return { isBinary: true, type: 'macOS Binary (Mach-O)' };
        }
    }

    // ZIP / JAR / Office Archives (PK\x03\x04, PK\x05\x06, PK\x07\x08)
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
        return { isBinary: true, type: 'ZIP Archive' };
    }

    // 7-Zip Archive (7z\xbc\xaf\x27\x1c)
    if (bytes.length >= 6 && bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf && bytes[4] === 0x27 && bytes[5] === 0x1c) {
        return { isBinary: true, type: '7-Zip Archive' };
    }

    // RAR Archive (Rar!\x1a\x07)
    if (bytes.length >= 7 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 && bytes[4] === 0x1a && bytes[5] === 0x07) {
        return { isBinary: true, type: 'RAR Archive' };
    }

    return { isBinary: false };
}

/**
 * Validate an in-memory buffer or Uint8Array payload for security, magic bytes, and valid encoding
 */
export function validateFileBuffer(bytes: Uint8Array, fileName: string): ValidationResult {
    // 1. Size ceiling
    if (!bytes || bytes.byteLength > MAX_FILE_SIZE) {
        return {
            isValid: false,
            error: `File size exceeds 10MB limit`,
        };
    }

    // 2. Extension validation
    const extension = fileName.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!extension || !(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
        return {
            isValid: false,
            error: `Invalid file type. Only PDF, MD, and TXT files are allowed.`,
        };
    }

    const fileType: 'pdf' | 'md' | 'txt' = extension === '.pdf' ? 'pdf' : extension === '.md' ? 'md' : 'txt';

    // 3. PDF specific magic bytes
    if (fileType === 'pdf') {
        if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) {
            return {
                isValid: false,
                error: 'Invalid PDF format: missing %PDF header',
            };
        }
        return { isValid: true, fileType };
    }

    // 4. MD / TXT files: ensure NOT a disguised executable or binary archive
    const binaryCheck = isDisguisedBinary(bytes);
    if (binaryCheck.isBinary) {
        return {
            isValid: false,
            error: `Invalid file format: disguised binary detected (${binaryCheck.type})`,
        };
    }

    // 5. Verify UTF-8 decoding integrity
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        decoder.decode(bytes);
    } catch {
        return {
            isValid: false,
            error: 'Invalid file encoding: content is not valid UTF-8',
        };
    }

    return {
        isValid: true,
        fileType,
    };
}


