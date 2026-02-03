/**
 * Markdown Exporter Strategy
 * Exports content preserving all Markdown syntax exactly as-is
 */

import type { IExporter, ExportResult } from '../types';
import { ExportError } from '../types';
import { validateContent, createSafeFilename } from '../utils/validator';
import { htmlToPlainText } from '../utils/markdown-stripper';

/**
 * Markdown Exporter
 * Preserves all Markdown formatting characters
 */
export class MarkdownExporter implements IExporter {
    async export(content: string, filename: string): Promise<ExportResult> {
        try {
            // Validate inputs
            validateContent(content);

            // Convert HTML to plain text (TipTap editor provides HTML)
            // For Markdown export, we want to preserve the raw text
            const plainText = htmlToPlainText(content);

            // Create safe filename
            const safeFilename = createSafeFilename(filename, 'md');

            // Create blob with UTF-8 encoding
            const blob = new Blob([plainText], {
                type: 'text/markdown;charset=utf-8',
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
