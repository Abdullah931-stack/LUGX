/**
 * Data Export Governance Service
 * 
 * Enforces Zero-Knowledge content governance across document export channels.
 * Prevents unintentional plaintext leakage of encrypted documents without explicit confirmation.
 * 
 * Remediates: LUGX-004, LUGX-017, LUGX-019, LUGX-085
 */

import { exportContent, downloadBlob, ExportFormat, ExportResult, ExportError } from '@/lib/exporters';

export interface ExportDocumentOptions {
    content: string;
    filename: string;
    format: ExportFormat;
    isEncrypted?: boolean;
    confirmedPlaintextExport?: boolean;
}

/**
 * Governed document export function.
 * Fails closed if attempting to export an encrypted document as unencrypted plaintext without explicit confirmation.
 */
export async function exportDocument(options: ExportDocumentOptions): Promise<ExportResult> {
    const {
        content,
        filename,
        format,
        isEncrypted = false,
        confirmedPlaintextExport = false,
    } = options;

    // Fail-Closed Encrypted Content Governance Barrier
    if (isEncrypted && !confirmedPlaintextExport) {
        return {
            success: false,
            error: "Export of encrypted document as unencrypted plaintext requires explicit user confirmation.",
            errorCode: "ENCRYPTED_EXPORT_UNCONFIRMED",
        };
    }

    return await exportContent(content, filename, format);
}

/**
 * Triggers safe browser download of exported blob.
 */
export function triggerBrowserDownload(blob: Blob, filename: string): void {
    downloadBlob(blob, filename);
}

export type { ExportFormat, ExportResult, ExportError };
