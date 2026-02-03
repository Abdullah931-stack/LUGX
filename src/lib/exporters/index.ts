/**
 * Data Export Module - Main Entry Point
 * Implements Factory Pattern for creating format-specific exporters
 * Supports: Markdown (.md) and Plain Text (.txt)
 */

import type { ExportFormat, ExportResult, IExporter } from './types';
import { MarkdownExporter } from './strategies/markdown-exporter';
import { TextExporter } from './strategies/text-exporter';

/**
 * Factory class for creating exporters
 * Implements Factory Pattern to maintain Open/Closed Principle
 */
export class ExporterFactory {
    /**
     * Create an exporter instance based on format
     * @param format - The export format (md or txt)
     * @returns Exporter instance implementing IExporter
     */
    static create(format: ExportFormat): IExporter {
        switch (format) {
            case 'md':
                return new MarkdownExporter();
            case 'txt':
                return new TextExporter();
            default:
                // TypeScript ensures this never happens with proper typing
                throw new Error(`Unsupported format: ${format}`);
        }
    }
}

/**
 * Main export function - Facade for the export system
 * This is the primary API that client code should use
 * 
 * @param content - Content to export (HTML from TipTap editor)
 * @param filename - Desired filename (without extension)
 * @param format - Export format (md or txt)
 * @returns Promise with export result including blob
 */
export async function exportContent(
    content: string,
    filename: string,
    format: ExportFormat
): Promise<ExportResult> {
    // Create appropriate exporter using factory
    const exporter = ExporterFactory.create(format);

    // Delegate to specific exporter
    return await exporter.export(content, filename);
}

/**
 * Trigger browser download of exported content
 * @param blob - Blob to download
 * @param filename - Filename for download
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Export types for external use
export type { ExportFormat, ExportResult, IExporter } from './types';
export { ExportError } from './types';
