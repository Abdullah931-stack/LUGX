/**
 * Typed RPC Bridge for Isolated PDF Worker
 *
 * Provides a Promise-based asynchronous facade for PDF text extraction.
 * Supports dual-mode execution (Web Worker in browser, Direct execution in Node.js/Vitest)
 * ensuring responsive UI on client and real, mock-free verification in test runners.
 */

import {
    PdfWorkerRequest,
    PdfWorkerResponse,
    ExtractPdfOptions,
    ExtractPdfResult,
    PdfProgressInfo,
    extractPdfTextDirect,
} from '../workers/pdf.worker';

export type { ExtractPdfOptions, ExtractPdfResult, PdfProgressInfo };

interface PendingRequest {
    resolve: (result: ExtractPdfResult) => void;
    reject: (reason: Error) => void;
    onProgress?: (progress: PdfProgressInfo) => void;
    timer?: ReturnType<typeof setTimeout>;
    abortCleanup?: () => void;
}

export class PdfWorkerBridge {
    private worker: Worker | null = null;
    private pendingRequests = new Map<string, PendingRequest>();
    private requestCounter = 0;
    private isInitialized = false;
    private isTerminated = false;

    constructor(private readonly defaultTimeoutMs: number = 120000) {}

    /**
     * Initializes the Web Worker instance if running in a browser environment.
     */
    public initialize(): void {
        if (this.isInitialized) return;
        this.isInitialized = true;

        if (typeof window !== 'undefined' && typeof Worker !== 'undefined' && !this.isTerminated) {
            try {
                this.worker = new Worker(
                    new URL('../workers/pdf.worker.ts', import.meta.url),
                    { type: 'module' }
                );

                this.worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
                    this.handleWorkerMessage(event.data);
                };

                this.worker.onerror = (errorEvent: ErrorEvent) => {
                    this.handleWorkerError(errorEvent);
                };
            } catch (_err) {
                // Fallback to direct execution runner if Web Worker instantiation is unavailable
                this.worker = null;
                this.isTerminated = true;
            }
        }
    }

    /**
     * Extract plain text from PDF data with progress feedback and cancellation.
     */
    public async extractText(
        data: ArrayBuffer | Uint8Array,
        options?: ExtractPdfOptions
    ): Promise<ExtractPdfResult> {
        const { onProgress, signal } = options || {};

        if (signal?.aborted) {
            throw new DOMException('Extraction aborted by user', 'AbortError');
        }

        this.initialize();

        // Node.js / Vitest test environment or Worker unavailable: execute direct engine
        if (!this.worker || this.isTerminated) {
            return extractPdfTextDirect(data, options);
        }

        const requestId = `pdf_req_${++this.requestCounter}_${Date.now()}`;
        const arrayBufferData = data instanceof Uint8Array
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;

        return new Promise<ExtractPdfResult>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;

            if (this.defaultTimeoutMs > 0) {
                timer = setTimeout(() => {
                    this.abortRequest(requestId);
                    reject(new Error(`PDF extraction timed out after ${this.defaultTimeoutMs}ms`));
                }, this.defaultTimeoutMs);
            }

            let abortCleanup: (() => void) | undefined;
            if (signal) {
                const onAbort = () => {
                    this.abortRequest(requestId);
                    if (timer) clearTimeout(timer);
                    reject(new DOMException('Extraction aborted by user', 'AbortError'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }

            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                onProgress,
                timer,
                abortCleanup,
            });

            try {
                // Send request and transfer ArrayBuffer ownership for zero-copy efficiency
                const request: PdfWorkerRequest = {
                    id: requestId,
                    type: 'EXTRACT_TEXT',
                    data: arrayBufferData as ArrayBuffer,
                    disableTableExtraction: options?.disableTableExtraction,
                };
                this.worker!.postMessage(request, [arrayBufferData as ArrayBuffer]);
            } catch (postErr) {
                if (timer) clearTimeout(timer);
                abortCleanup?.();
                this.pendingRequests.delete(requestId);
                reject(postErr instanceof Error ? postErr : new Error('Failed to post message to PDF worker'));
            }
        });
    }

    private handleWorkerMessage(message: PdfWorkerResponse): void {
        if (!message || !message.id) return;
        const pending = this.pendingRequests.get(message.id);
        if (!pending) return;

        if (message.type === 'PROGRESS') {
            // Watchdog: reset inactivity timer on each progress heartbeat
            if (pending.timer && this.defaultTimeoutMs > 0) {
                clearTimeout(pending.timer);
                pending.timer = setTimeout(() => {
                    this.abortRequest(message.id);
                    pending.reject(new Error(`PDF extraction timed out after ${this.defaultTimeoutMs}ms of inactivity`));
                }, this.defaultTimeoutMs);
            }

            pending.onProgress?.({
                currentPage: message.currentPage,
                totalPages: message.totalPages,
                percent: message.percent,
            });
            return;
        }

        // Terminal response (SUCCESS or ERROR)
        if (pending.timer) clearTimeout(pending.timer);
        pending.abortCleanup?.();
        this.pendingRequests.delete(message.id);

        if (message.type === 'SUCCESS') {
            pending.resolve({
                text: message.text,
                numPages: message.numPages,
                wordCount: message.wordCount,
            });
        } else if (message.type === 'ERROR') {
            const err = message.isAborted
                ? new DOMException('Extraction aborted by user', 'AbortError')
                : new Error(message.error);
            if (message.isPasswordProtected) Object.assign(err, { isPasswordProtected: true });
            if (message.isScannedOrEmpty) Object.assign(err, { isScannedOrEmpty: true });
            pending.reject(err);
        }
    }

    private handleWorkerError(errorEvent: ErrorEvent): void {
        const error = new Error(`PDF Web Worker encountered an unexpected error: ${errorEvent.message}`);
        for (const [, pending] of this.pendingRequests.entries()) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.abortCleanup?.();
            pending.reject(error);
        }
        this.pendingRequests.clear();
        this.resetWorker();
    }

    private abortRequest(requestId: string): void {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
            if (pending.timer) clearTimeout(pending.timer);
            pending.abortCleanup?.();
            this.pendingRequests.delete(requestId);
        }

        if (this.worker && !this.isTerminated) {
            try {
                const abortMsg: PdfWorkerRequest = {
                    id: requestId,
                    type: 'ABORT',
                };
                this.worker.postMessage(abortMsg);
            } catch {}
        }
    }

    public resetWorker(): void {
        if (this.worker) {
            try {
                this.worker.terminate();
            } catch {}
            this.worker = null;
        }
        this.isInitialized = false;
        this.isTerminated = false;
    }
}

export const pdfWorkerBridge = new PdfWorkerBridge();
