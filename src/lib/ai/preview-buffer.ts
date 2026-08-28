import { FEATURES } from "@/config/features.config";

/**
 * Ephemeral Preview Buffer
 *
 * In-memory buffer keyed by session ID for storing streaming chunks safely.
 *
 * Guarantees:
 * 1. Isolated from CodeMirror document model and IndexedDB storage.
 * 2. Bounded by PREVIEW_BUFFER_MAX_CHARS to protect memory.
 * 3. Deterministic teardown and memory reclamation.
 */
export class EphemeralPreviewBuffer {
    private buffers: Map<string, string[]> = new Map();
    private totalLengths: Map<string, number> = new Map();
    private maxChars: number;

    constructor(maxChars: number = FEATURES.PREVIEW_BUFFER_MAX_CHARS) {
        this.maxChars = maxChars;
    }

    /**
     * Open/initialize buffer for a new streaming session
     */
    open(sessionId: string): void {
        this.buffers.set(sessionId, []);
        this.totalLengths.set(sessionId, 0);
    }

    /**
     * Append text chunk to session buffer with memory boundary guard
     */
    append(sessionId: string, chunk: string): { appended: boolean; text: string; truncated: boolean } {
        if (!this.buffers.has(sessionId)) {
            this.open(sessionId);
        }

        const currentLength = this.totalLengths.get(sessionId) || 0;
        const availableSpace = Math.max(0, this.maxChars - currentLength);

        if (availableSpace <= 0) {
            return {
                appended: false,
                text: this.getText(sessionId),
                truncated: true,
            };
        }

        const chunkToAppend = chunk.slice(0, availableSpace);
        const isTruncated = chunk.length > availableSpace;

        const chunks = this.buffers.get(sessionId)!;
        chunks.push(chunkToAppend);
        this.totalLengths.set(sessionId, currentLength + chunkToAppend.length);

        return {
            appended: true,
            text: chunks.join(""),
            truncated: isTruncated,
        };
    }

    /**
     * Retrieve accumulated text for a session
     */
    getText(sessionId: string): string {
        const chunks = this.buffers.get(sessionId);
        return chunks ? chunks.join("") : "";
    }

    /**
     * Retrieve current character length for a session
     */
    getLength(sessionId: string): number {
        return this.totalLengths.get(sessionId) || 0;
    }

    /**
     * Clear and delete buffer for a session
     */
    close(sessionId: string): void {
        this.buffers.delete(sessionId);
        this.totalLengths.delete(sessionId);
    }

    /**
     * Check if a session buffer is active
     */
    has(sessionId: string): boolean {
        return this.buffers.has(sessionId);
    }
}

// Singleton preview buffer instance
export const previewBuffer = new EphemeralPreviewBuffer();
