/**
 * Isolated PDF Web Worker for LUGX
 *
 * Executes PDF parsing and text extraction off the main UI thread using pdfjs-dist.
 * Enforces per-page memory cleanup (page.cleanup()), document destruction (pdfDoc.destroy()),
 * progress reporting, and user cancellation via AbortSignal.
 */

// Worker-safe DOM polyfills for pdfjs-dist display layer compatibility (scoped strictly to Worker context)
if (typeof document === 'undefined' && typeof self !== 'undefined' && (typeof (self as unknown as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined' || typeof (self as unknown as { importScripts?: unknown }).importScripts === 'function')) {
    const workerHref = (typeof self !== 'undefined' && 'location' in self && (self as unknown as { location?: { href?: string } }).location?.href) || '';
    (globalThis as unknown as { document: unknown }).document = {
        baseURI: workerHref,
        documentElement: null,
        head: null,
        body: null,
        createElement: () => ({ append: () => {}, appendChild: () => {}, setAttribute: () => {} }),
        getElementsByTagName: () => [],
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
    };
}

export interface PdfWorkerExtractRequest {
    id: string;
    type: 'EXTRACT_TEXT';
    data: ArrayBuffer;
    disableTableExtraction?: boolean;
}

export interface PdfWorkerAbortRequest {
    id: string;
    type: 'ABORT';
}

export type PdfWorkerRequest = PdfWorkerExtractRequest | PdfWorkerAbortRequest;

export interface PdfProgressInfo {
    currentPage: number;
    totalPages: number;
    percent: number;
}

export interface PdfWorkerProgressMessage {
    id: string;
    type: 'PROGRESS';
    currentPage: number;
    totalPages: number;
    percent: number;
}

export interface PdfWorkerSuccessMessage {
    id: string;
    type: 'SUCCESS';
    text: string;
    numPages: number;
    wordCount: number;
}

export interface PdfWorkerErrorMessage {
    id: string;
    type: 'ERROR';
    error: string;
    isPasswordProtected?: boolean;
    isScannedOrEmpty?: boolean;
    isAborted?: boolean;
}

export type PdfWorkerResponse =
    | PdfWorkerProgressMessage
    | PdfWorkerSuccessMessage
    | PdfWorkerErrorMessage;

export interface ExtractPdfOptions {
    onProgress?: (progress: PdfProgressInfo) => void;
    signal?: AbortSignal;
    disableTableExtraction?: boolean;
}

export interface ExtractPdfResult {
    text: string;
    numPages: number;
    wordCount: number;
}

interface PDFPageProxy {
    getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
    cleanup: () => void;
}

interface PDFDocumentProxy {
    numPages: number;
    getPage: (pageNum: number) => Promise<PDFPageProxy>;
    destroy: () => Promise<void>;
}

interface PDFDocumentLoadingTask {
    promise: Promise<PDFDocumentProxy>;
    destroy: () => Promise<void>;
}

/**
 * Normalizes extracted PDF text into clean, linear Markdown paragraphs.
 */
export function normalizeExtractedText(rawText: string): string {
    return rawText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

/**
 * Pure, environment-agnostic PDF text extraction core engine.
 * Used both inside the Web Worker and as the direct runner in Node.js / Vitest test environments.
 */
export async function extractPdfTextDirect(
    data: ArrayBuffer | Uint8Array,
    options?: ExtractPdfOptions
): Promise<ExtractPdfResult> {
    const { onProgress, signal, disableTableExtraction } = options || {};

    if (signal?.aborted) {
        throw new DOMException('Extraction aborted by user', 'AbortError');
    }

    // Dynamic import of pdfjs-dist legacy worker and build for full Node.js / Vitest / Browser compatibility
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Ensure workerSrc fallback for browser environments
    if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
        if (typeof window !== 'undefined') {
            pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
        } else if (typeof self !== 'undefined' && 'location' in self && (self as unknown as { location?: { origin?: string } }).location?.origin) {
            pdfjs.GlobalWorkerOptions.workerSrc = `${(self as unknown as { location: { origin: string } }).location.origin}/pdf.worker.min.mjs`;
        }
    }

    const uint8Data = data instanceof Uint8Array ? data : new Uint8Array(data);

    let loadingTask: PDFDocumentLoadingTask | null = null;
    let pdfDoc: PDFDocumentProxy | null = null;

    try {
        const cMapBase = typeof self !== 'undefined' && 'location' in self && (self as unknown as { location?: { origin?: string } }).location?.origin
            ? `${(self as unknown as { location: { origin: string } }).location.origin}/cmaps/`
            : '/cmaps/';
        const standardFontBase = typeof self !== 'undefined' && 'location' in self && (self as unknown as { location?: { origin?: string } }).location?.origin
            ? `${(self as unknown as { location: { origin: string } }).location.origin}/standard_fonts/`
            : '/standard_fonts/';

        loadingTask = pdfjs.getDocument({
            data: uint8Data,
            cMapUrl: cMapBase,
            cMapPacked: true,
            standardFontDataUrl: standardFontBase,
            useWorkerFetch: true,
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            verbosity: 0,
        }) as unknown as PDFDocumentLoadingTask;

        if (signal) {
            signal.addEventListener(
                'abort',
                () => {
                    try {
                        void loadingTask?.destroy();
                    } catch {}
                },
                { once: true }
            );
        }

        pdfDoc = await loadingTask.promise;
    } catch (loadError: unknown) {
        if (signal?.aborted) {
            throw new DOMException('Extraction aborted by user', 'AbortError');
        }
        const errorName = (loadError as { name?: string })?.name;
        if (errorName === 'PasswordException') {
            const err = new Error('PDF is password-protected. Please remove password protection before importing.');
            Object.assign(err, { isPasswordProtected: true });
            throw err;
        }
        const errorMsg = loadError instanceof Error ? loadError.message : 'Invalid or corrupted PDF file';
        throw new Error(`Failed to load PDF: ${errorMsg}`);
    }

    if (signal?.aborted) {
        try {
            await pdfDoc?.destroy();
        } catch {}
        throw new DOMException('Extraction aborted by user', 'AbortError');
    }

    const totalPages = pdfDoc.numPages;
    const pageTextChunks: string[] = [];

    // Dynamically import table extractor to avoid circular dependencies
    const { extractSpatialPdfTableContent } = await import('../parsers/pdf-table-extractor');

    try {
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (signal?.aborted) {
                throw new DOMException('Extraction aborted by user', 'AbortError');
            }

            const page = await pdfDoc.getPage(pageNum);
            try {
                const content = await page.getTextContent();
                const spatialItems: Array<{ str: string; x: number; y: number; width?: number; height?: number; hasEOL?: boolean }> = [];

                for (const item of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }>) {
                    if (typeof item.str === 'string' && item.str.length > 0) {
                        const x = item.transform && item.transform.length >= 6 ? item.transform[4] : 0;
                        const y = item.transform && item.transform.length >= 6 ? item.transform[5] : 0;
                        spatialItems.push({
                            str: item.str,
                            x,
                            y,
                            width: item.width,
                            height: item.height,
                            hasEOL: item.hasEOL,
                        });
                    }
                }

                const pageMarkdown = extractSpatialPdfTableContent(spatialItems, {
                    disableTables: disableTableExtraction,
                });
                if (pageMarkdown) {
                    pageTextChunks.push(pageMarkdown);
                }
            } finally {
                // Defensive per-page memory cleanup
                try {
                    page.cleanup();
                } catch {}
            }

            if (onProgress) {
                const percent = Math.round((pageNum / totalPages) * 100);
                onProgress({ currentPage: pageNum, totalPages, percent });
            }
        }
    } finally {
        // Guarantee document resources are destroyed
        try {
            await pdfDoc.destroy();
        } catch {}
    }

    const joinedText = pageTextChunks.join('\n\n');
    const normalizedText = normalizeExtractedText(joinedText);

    if (!normalizedText) {
        const emptyErr = new Error('PDF contains no extractable text (Scanned or image-only PDF)');
        Object.assign(emptyErr, { isScannedOrEmpty: true });
        throw emptyErr;
    }

    const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;

    return {
        text: normalizedText,
        numPages: totalPages,
        wordCount,
    };
}

// Global cancellation map for Web Worker requests
const activeWorkerAbortControllers = new Map<string, AbortController>();

interface WorkerPostScope {
    postMessage: (message: PdfWorkerResponse) => void;
    onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null;
}

/**
 * Web Worker Message Listener
 */
if (typeof self !== 'undefined' && 'postMessage' in self) {
    const workerScope = self as unknown as WorkerPostScope;
    workerScope.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
        const message = event.data;
        if (!message || !message.id) return;

        if (message.type === 'ABORT') {
            const controller = activeWorkerAbortControllers.get(message.id);
            if (controller) {
                controller.abort();
                activeWorkerAbortControllers.delete(message.id);
            }
            return;
        }

        if (message.type === 'EXTRACT_TEXT') {
            const abortController = new AbortController();
            activeWorkerAbortControllers.set(message.id, abortController);

            try {
                const result = await extractPdfTextDirect(message.data, {
                    signal: abortController.signal,
                    disableTableExtraction: message.disableTableExtraction,
                    onProgress: (progress) => {
                        const progressMsg: PdfWorkerProgressMessage = {
                            id: message.id,
                            type: 'PROGRESS',
                            currentPage: progress.currentPage,
                            totalPages: progress.totalPages,
                            percent: progress.percent,
                        };
                        workerScope.postMessage(progressMsg);
                    },
                });

                const successMsg: PdfWorkerSuccessMessage = {
                    id: message.id,
                    type: 'SUCCESS',
                    text: result.text,
                    numPages: result.numPages,
                    wordCount: result.wordCount,
                };
                workerScope.postMessage(successMsg);
            } catch (err: unknown) {
                const isAborted = (err as { name?: string })?.name === 'AbortError' || abortController.signal.aborted;
                const errObj = err as { message?: string; isPasswordProtected?: boolean; isScannedOrEmpty?: boolean } | null;
                const errorMsg: PdfWorkerErrorMessage = {
                    id: message.id,
                    type: 'ERROR',
                    error: errObj?.message || 'PDF extraction failed',
                    isPasswordProtected: Boolean(errObj?.isPasswordProtected),
                    isScannedOrEmpty: Boolean(errObj?.isScannedOrEmpty),
                    isAborted,
                };
                workerScope.postMessage(errorMsg);
            } finally {
                activeWorkerAbortControllers.delete(message.id);
            }
        }
    };
}
