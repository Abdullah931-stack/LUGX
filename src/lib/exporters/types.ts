/**
 * Data Export Module - Type Definitions
 * Defines all types, interfaces, and error classes for the export system
 */

/**
 * Supported export formats (Markdown and Plain Text only)
 */
export type ExportFormat = 'md' | 'txt';

/**
 * Result of an export operation
 */
export interface ExportResult {
    success: boolean;
    filepath?: string;
    filename?: string;
    blob?: Blob;
    error?: string;
    errorCode?: ExportErrorCode;
}

/**
 * Error codes for export operations
 */
export type ExportErrorCode =
    | 'FILE_PERMISSION'
    | 'DISK_SPACE'
    | 'ENCODING_ERROR'
    | 'INVALID_CONTENT'
    | 'UNKNOWN';

/**
 * Export error class with specific error codes
 */
export class ExportError extends Error {
    code: ExportErrorCode;

    constructor(message: string, code: ExportErrorCode = 'UNKNOWN') {
        super(message);
        this.name = 'ExportError';
        this.code = code;

        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ExportError);
        }
    }
}

/**
 * Core interface that all exporters must implement
 * This enforces the Strategy Pattern
 */
export interface IExporter {
    /**
     * Export content to the specified format
     * @param content - The content to export (HTML format from TipTap editor)
     * @param filename - Desired filename (without extension)
     * @returns Promise with export result
     */
    export(content: string, filename: string): Promise<ExportResult>;
}

/**
 * Options for export operations
 */
export interface ExportOptions {
    /** Whether to include metadata in the export */
    includeMetadata?: boolean;
    /** Custom encoding (default: UTF-8) */
    encoding?: string;
    /** Custom MIME type override */
    mimeType?: string;
}
