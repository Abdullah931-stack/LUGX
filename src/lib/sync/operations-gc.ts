/**
 * Operations Garbage Collector
 * 
 * Manages the size of the IndexedDB operations store by periodically
 * cleaning up old synced operations and compacting operation logs.
 */

import { indexedDBManager } from './indexeddb';
import { IDB_CONFIG, IDBOperation } from './idb-types';

/**
 * GC Configuration
 */
export interface GCConfig {
    /** Maximum age for synced operations in milliseconds */
    maxOperationAgeMs: number;
    /** Maximum operations per file before compaction */
    maxOperationsPerFile: number;
    /** Minimum interval between GC runs in milliseconds */
    minGCIntervalMs: number;
    /** Storage usage threshold to trigger aggressive GC (0-1) */
    aggressiveGCThreshold: number;
}

/**
 * GC Result
 */
export interface GCResult {
    /** Number of operations deleted */
    operationsDeleted: number;
    /** Number of files compacted */
    filesCompacted: number;
    /** Duration of GC run in milliseconds */
    durationMs: number;
    /** Whether aggressive GC was triggered */
    wasAggressive: boolean;
}

/**
 * Default GC configuration
 */
const DEFAULT_CONFIG: GCConfig = {
    maxOperationAgeMs: IDB_CONFIG.MAX_OPERATION_AGE_MS,
    maxOperationsPerFile: IDB_CONFIG.MAX_OPERATIONS_PER_FILE,
    minGCIntervalMs: 5 * 60 * 1000, // 5 minutes
    aggressiveGCThreshold: 0.8, // 80% storage usage
};

/**
 * Operations Garbage Collector Class
 */
export class OperationsGarbageCollector {
    private config: GCConfig;
    private lastGCTime = 0;
    private isRunning = false;

    constructor(config: Partial<GCConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Run garbage collection
     * Returns early if minimum interval hasn't passed
     */
    async run(force = false): Promise<GCResult> {
        const now = Date.now();

        // Check minimum interval
        if (!force && now - this.lastGCTime < this.config.minGCIntervalMs) {
            return {
                operationsDeleted: 0,
                filesCompacted: 0,
                durationMs: 0,
                wasAggressive: false,
            };
        }

        // Prevent concurrent runs
        if (this.isRunning) {
            return {
                operationsDeleted: 0,
                filesCompacted: 0,
                durationMs: 0,
                wasAggressive: false,
            };
        }

        this.isRunning = true;
        const startTime = performance.now();

        try {
            // Check if we need aggressive GC
            const storageInfo = await indexedDBManager.getStorageEstimate();
            const wasAggressive = storageInfo.percentage / 100 > this.config.aggressiveGCThreshold;

            // Adjust max age for aggressive GC (reduce to 1 day)
            const maxAge = wasAggressive
                ? Math.min(this.config.maxOperationAgeMs, 24 * 60 * 60 * 1000)
                : this.config.maxOperationAgeMs;

            // Delete old operations
            const operationsDeleted = await indexedDBManager.deleteOldOperations(maxAge);

            // Compact files with too many operations
            const filesCompacted = await this.compactOperations();

            this.lastGCTime = now;

            const durationMs = performance.now() - startTime;

            const result: GCResult = {
                operationsDeleted,
                filesCompacted,
                durationMs,
                wasAggressive,
            };

            console.log('[GC] Completed:', result);
            return result;

        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Compact operations for files with too many entries
     */
    private async compactOperations(): Promise<number> {
        const allFiles = await indexedDBManager.getAllFiles();
        let compactedCount = 0;

        for (const file of allFiles) {
            const operations = await indexedDBManager.getOperations(file.id);

            if (operations.length > this.config.maxOperationsPerFile) {
                // Keep only the most recent operations
                const toKeep = this.selectOperationsToKeep(operations);
                await indexedDBManager.replaceOperations(file.id, toKeep);
                compactedCount++;

                console.log(`[GC] Compacted ${file.id}: ${operations.length} -> ${toKeep.length} operations`);
            }
        }

        return compactedCount;
    }

    /**
     * Select which operations to keep after compaction
     * Keeps recent and unsynced operations
     */
    private selectOperationsToKeep(operations: IDBOperation[]): IDBOperation[] {
        // Sort by timestamp descending
        const sorted = [...operations].sort((a, b) => b.timestamp - a.timestamp);

        // Always keep unsynced operations
        const unsynced = sorted.filter(op => !op.synced);

        // Keep recent synced operations up to half the max
        const syncedLimit = Math.floor(this.config.maxOperationsPerFile / 2);
        const recentSynced = sorted
            .filter(op => op.synced)
            .slice(0, syncedLimit);

        return [...unsynced, ...recentSynced];
    }

    /**
     * Schedule periodic garbage collection
     * Returns cleanup function
     */
    schedule(intervalMs = 10 * 60 * 1000): () => void {
        const timer = setInterval(() => {
            this.run().catch(err => {
                console.error('[GC] Scheduled run failed:', err);
            });
        }, intervalMs);

        return () => clearInterval(timer);
    }

    /**
     * Get time until next GC is allowed
     */
    getTimeUntilNextGC(): number {
        const elapsed = Date.now() - this.lastGCTime;
        return Math.max(0, this.config.minGCIntervalMs - elapsed);
    }

    /**
     * Check if GC is currently running
     */
    isGCRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<GCConfig>): void {
        this.config = { ...this.config, ...config };
    }
}

// Export singleton instance
export const operationsGC = new OperationsGarbageCollector();
