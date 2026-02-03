/**
 * Concurrency Manager - Prevents concurrent sync operations on the same file
 */

export interface LockStatus {
    isLocked: boolean;
    lockedAt?: number;
    holderId?: string;
}

export class ConcurrencyManager {
    private locks = new Map<string, Promise<void>>();
    private lockResolvers = new Map<string, () => void>();
    private lockTimestamps = new Map<string, number>();
    private readonly holderId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    async acquireLock(fileId: string): Promise<() => void> {
        while (this.locks.has(fileId)) {
            try { await this.locks.get(fileId); } catch { /* released */ }
        }

        let releaseLock: () => void;
        const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });

        this.locks.set(fileId, lockPromise);
        this.lockResolvers.set(fileId, releaseLock!);
        this.lockTimestamps.set(fileId, Date.now());

        return () => this.releaseLock(fileId);
    }

    private releaseLock(fileId: string): void {
        const resolver = this.lockResolvers.get(fileId);
        if (resolver) {
            resolver();
            this.locks.delete(fileId);
            this.lockResolvers.delete(fileId);
            this.lockTimestamps.delete(fileId);
        }
    }

    async withLock<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
        const release = await this.acquireLock(fileId);
        try { return await fn(); } finally { release(); }
    }

    isLocked(fileId: string): boolean { return this.locks.has(fileId); }

    getLockStatus(fileId: string): LockStatus {
        const isLocked = this.locks.has(fileId);
        return {
            isLocked,
            lockedAt: isLocked ? this.lockTimestamps.get(fileId) : undefined,
            holderId: isLocked ? this.holderId : undefined,
        };
    }

    tryAcquireLock(fileId: string): (() => void) | null {
        if (this.locks.has(fileId)) return null;

        let releaseLock: () => void;
        const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });

        this.locks.set(fileId, lockPromise);
        this.lockResolvers.set(fileId, releaseLock!);
        this.lockTimestamps.set(fileId, Date.now());

        return () => this.releaseLock(fileId);
    }

    releaseAll(): void {
        for (const resolver of this.lockResolvers.values()) resolver();
        this.locks.clear();
        this.lockResolvers.clear();
        this.lockTimestamps.clear();
    }

    getActiveLockCount(): number { return this.locks.size; }
    getLockedFiles(): string[] { return Array.from(this.locks.keys()); }
}

export const concurrencyManager = new ConcurrencyManager();
