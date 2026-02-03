/**
 * PDF Text Extraction Utility
 * Extracts plain text from PDF files WITHOUT images
 * Uses pdf-parse for server-side processing
 */


export interface PDFParseResult {
    text: string;
    numPages: number;
    wordCount: number;
}

/**
 * Extract text content from PDF buffer
 * @param buffer - PDF file buffer
 * @returns Parsed text content with metadata
 */
export async function extractPdfText(buffer: Buffer): Promise<PDFParseResult> {
    try {
        // Dynamic import to handle pdf-parse module
        const pdfParseModule = await import('pdf-parse');
        const parse = (pdfParseModule as any).default || pdfParseModule;

        // Call the parser function
        const data: any = await parse(buffer);

        // Extract plain text while preserving line breaks and formatting
        let text = data.text || '';

        // Normalize line breaks (ensure consistent \n)
        text = text.replace(/\r\n/g, '\n');

        // Preserve paragraph breaks (double line breaks)
        // Remove excessive whitespace but keep intentional spacing
        text = text.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines

        const wordCount = text.split(/\s+/).filter(Boolean).length;

        return {
            text,
            numPages: data.numpages || 0,
            wordCount,
        };
    } catch (error) {
        throw new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Validate PDF file before parsing
 * @param buffer - File buffer to validate
 * @returns true if valid PDF
 */
export function isValidPDF(buffer: Buffer): boolean {
    // Check PDF magic number (first 4 bytes should be %PDF)
    const header = buffer.slice(0, 4).toString();
    return header === '%PDF';
}
