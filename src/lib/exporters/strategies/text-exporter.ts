/**
 * Plain Text Exporter Strategy
 * Exports content as clean plain text with all Markdown syntax stripped
 */

import type { IExporter, ExportResult } from '../types';
import { ExportError } from '../types';
import { validateContent, createSafeFilename } from '../utils/validator';
import { htmlToPlainText, stripMarkdownSyntax } from '../utils/markdown-stripper';

/**
 * Text Exporter
 * Strips all Markdown formatting to produce clean plain text
 */
export class TextExporter implements IExporter {
    async export(content: string, filename: string): Promise<ExportResult> {
        try {
            // Validate inputs
            validateContent(content);

            // Convert HTML to plain text first
            let plainText = htmlToPlainText(content);

            // Strip all Markdown syntax to get clean text
            const cleanText = stripMarkdownSyntax(plainText);

            // Create safe filename
            const safeFilename = createSafeFilename(filename, 'txt');

            // Create blob with UTF-8 encoding
            const blob = new Blob([cleanText], {
                type: 'text/plain;charset=utf-8',
            });

            return {
                success: true,
                filename: safeFilename,
                blob,
            };
        } catch (error) {
            if (error instanceof ExportError) {
                return {
                    success: false,
                    error: error.message,
                    errorCode: error.code,
                };
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred',
                errorCode: 'UNKNOWN',
            };
        }
    }
}
