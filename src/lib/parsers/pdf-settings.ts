/**
 * PDF Processing & Extraction User Settings
 *
 * Manages client-side preferences for PDF text parsing and spatial table generation.
 * Settings are persisted in localStorage with defensive fallbacks for SSR and privacy modes.
 */

export const TABLE_EXTRACTION_STORAGE_KEY = 'lugx_pdf_table_extraction_enabled';

/**
 * Checks whether spatial 2D table extraction is enabled.
 * Defaults to true if no preference has been stored.
 */
export function isTableExtractionEnabled(): boolean {
    if (typeof window === 'undefined') return true;
    try {
        const stored = localStorage.getItem(TABLE_EXTRACTION_STORAGE_KEY);
        if (stored === null) return true;
        return stored === 'true';
    } catch {
        return true;
    }
}

/**
 * Persists the table extraction preference.
 */
export function setTableExtractionEnabled(enabled: boolean): void {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(TABLE_EXTRACTION_STORAGE_KEY, String(enabled));
    } catch {
        // Ignore storage quota / private browsing exceptions
    }
}
