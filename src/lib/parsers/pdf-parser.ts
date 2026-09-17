/**
 * PDF Text Extraction Utility (Legacy Facade)
 *
 * Delegates to the isolated pdfjs-dist engine (extractPdfTextDirect).
 * Server-side extraction is deprecated in favor of client-side Web Worker extraction (pdfWorkerBridge).
 */

import { extractPdfTextDirect, ExtractPdfResult } from '../workers/pdf.worker';

export type { ExtractPdfResult as PDFParseResult };

/**
 * Extract text content from PDF buffer using the pure pdfjs-dist engine.
 * @param buffer - PDF file buffer or ArrayBuffer
 * @returns Parsed text content with metadata
 */
export async function extractPdfText(buffer: ArrayBuffer | Uint8Array | Buffer): Promise<ExtractPdfResult> {
    return extractPdfTextDirect(buffer);
}

/**
 * Validate PDF file magic bytes (%PDF)
 * @param buffer - File buffer to validate
 * @returns true if valid PDF header
 */
export function isValidPDF(buffer: ArrayBuffer | Uint8Array | Buffer): boolean {
    if (!buffer) return false;
    const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (view.length < 4) return false;
    // %PDF is 0x25, 0x50, 0x44, 0x46
    return view[0] === 0x25 && view[1] === 0x50 && view[2] === 0x44 && view[3] === 0x46;
}
