/**
 * Lazy, On-Demand Bilingual OCR Engine (Arabic + English)
 *
 * Uses tesseract.js with a unified 'ara+eng' model.
 * Completely isolated from the main application bundle via dynamic import.
 * Supports manual installation, progress tracking, and spatial table reconstruction.
 */

import { extractSpatialPdfTableContent, SpatialTextItem } from './pdf-table-extractor';
import { normalizeArabicText } from './arabic-normalizer';

const OCR_INSTALLED_KEY = 'lugx_ocr_bilingual_installed';
const CACHE_NAME = 'lugx-ocr-v1';

export interface OcrProgressInfo {
    page: number;
    total: number;
    percent: number;
    statusText?: string;
}

export interface OcrRunOptions {
    onProgress?: (progress: OcrProgressInfo) => void;
    signal?: AbortSignal;
    disableTableExtraction?: boolean;
}

/**
 * Checks if the bilingual OCR package is marked as installed in the local browser.
 */
export async function isOcrPackageInstalled(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
        const isFlagged = localStorage.getItem(OCR_INSTALLED_KEY) === 'true';
        if (!isFlagged) return false;

        // Verify cache storage if available
        if ('caches' in window) {
            const hasCache = await caches.has(CACHE_NAME);
            return hasCache || isFlagged;
        }
        return isFlagged;
    } catch {
        return false;
    }
}

/**
 * Downloads and pre-caches the bilingual OCR engine (ara + eng + WASM).
 * Tracks real download progress (0% - 100%).
 */
export async function downloadBilingualOcrPackage(
    onProgress?: (percent: number) => void
): Promise<boolean> {
    if (typeof window === 'undefined') return false;

    try {
        onProgress?.(5);

        // Dynamic import ensures zero bundle bloat until explicitly invoked
        const { createWorker } = await import('tesseract.js');

        onProgress?.(15);

        // Create an isolated worker and load both Arabic and English language packs
        const worker = await createWorker('ara+eng', 1, {
            logger: (m: { status?: string; progress?: number }) => {
                if (typeof m.progress === 'number' && m.progress > 0) {
                    // Map Tesseract download/initialization progress (15% - 90%)
                    const mapped = Math.min(95, Math.max(15, Math.round(15 + m.progress * 75)));
                    onProgress?.(mapped);
                }
            },
            cachePath: CACHE_NAME,
        });

        // In Tesseract.js v5, createWorker('ara+eng', ...) automatically loads and initializes languages.
        // Cleanup worker instance after successful download and verification
        await worker.terminate();

        // Mark package as installed
        localStorage.setItem(OCR_INSTALLED_KEY, 'true');
        onProgress?.(100);

        return true;
    } catch (error) {
        console.error('[OCR Engine] Failed to download bilingual OCR package:', error);
        throw error;
    }
}

/**
 * Deletes the cached OCR package to free up browser storage.
 */
export async function deleteOcrPackage(): Promise<void> {
    if (typeof window === 'undefined') return;

    try {
        localStorage.removeItem(OCR_INSTALLED_KEY);

        if ('caches' in window) {
            await caches.delete(CACHE_NAME);
        }

        // Also clean Tesseract IndexedDB cache if present
        if ('indexedDB' in window) {
            try {
                indexedDB.deleteDatabase('tesseract');
            } catch {}
        }
    } catch (err) {
        console.warn('[OCR Engine] Error during package deletion:', err);
    }
}

/**
 * Executes bilingual OCR on a PDF document buffer, routing spatial word coordinates
 * into the table extractor for clean Markdown generation.
 */
export async function runBilingualOcr(
    pdfData: ArrayBuffer,
    options?: OcrRunOptions
): Promise<string> {
    const { onProgress, signal, disableTableExtraction } = options || {};

    if (signal?.aborted) {
        throw new DOMException('OCR aborted by user', 'AbortError');
    }

    // Dynamic imports
    const { createWorker } = await import('tesseract.js');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Ensure worker environment is active
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
        if (typeof window !== 'undefined') {
            pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        }
    }

    const uint8Data = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
    const pdfDoc = await pdfjs.getDocument({
        data: uint8Data,
        cMapUrl: '/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/standard_fonts/',
        useWorkerFetch: true,
        isEvalSupported: false,
        useSystemFonts: true,
        verbosity: 0,
    }).promise;

    const totalPages = pdfDoc.numPages;
    const worker = await createWorker('ara+eng', 1, {
        cachePath: CACHE_NAME,
    });

    const pageResults: string[] = [];

    try {
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (signal?.aborted) {
                throw new DOMException('OCR aborted by user', 'AbortError');
            }

            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 }); // 2x scale for sharp OCR recognition

            // Render PDF page to in-memory HTML5 canvas
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
                throw new Error('Canvas 2D context unavailable for OCR rendering');
            }

            await (page.render({
                canvasContext: ctx,
                viewport,
            }) as unknown as { promise: Promise<void> }).promise;

            if (signal?.aborted) {
                throw new DOMException('OCR aborted by user', 'AbortError');
            }

            // Perform OCR on rendered canvas with explicit blocks & text outputs
            const ocrResult = await worker.recognize(
                canvas,
                {},
                { text: true, blocks: true }
            );

            // Convert Tesseract word bounding boxes into SpatialTextItem format
            const spatialItems: SpatialTextItem[] = [];
            if (ocrResult.data.blocks) {
                for (const block of ocrResult.data.blocks) {
                    for (const para of block.paragraphs) {
                        for (const line of para.lines) {
                            for (const word of line.words) {
                                if (word.text && word.text.trim()) {
                                    spatialItems.push({
                                        str: word.text.trim(),
                                        x: word.bbox.x0 / 2.0, // Scale back to PDF 1x point scale
                                        y: (viewport.height - word.bbox.y1) / 2.0, // Invert Y to match PDF bottom-up coordinates
                                        width: (word.bbox.x1 - word.bbox.x0) / 2.0,
                                        height: (word.bbox.y1 - word.bbox.y0) / 2.0,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            // Extract Markdown tables and normalized text
            let pageMarkdown = extractSpatialPdfTableContent(spatialItems, {
                disableTables: disableTableExtraction,
            });
            if (!pageMarkdown && ocrResult.data.text && ocrResult.data.text.trim()) {
                pageMarkdown = normalizeArabicText(ocrResult.data.text.trim());
            }

            if (pageMarkdown) {
                pageResults.push(pageMarkdown);
            }

            page.cleanup();

            onProgress?.({
                page: pageNum,
                total: totalPages,
                percent: Math.round((pageNum / totalPages) * 100),
                statusText: `تم فحص صفحة ${pageNum} من ${totalPages}`,
            });
        }
    } finally {
        await worker.terminate();
        await pdfDoc.destroy();
    }

    const finalContent = pageResults.join('\n\n').trim();
    if (!finalContent) {
        throw new Error('لم يتمكن محرك التعرف الضوئي من استخراج أي نص من المستند (Scanned or empty document)');
    }

    return finalContent;
}
