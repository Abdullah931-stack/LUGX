import { redis, isRedisConfigured } from "@/lib/redis";

/**
 * Result handle returned when attempting to acquire a cron distributed lock.
 */
export interface CronLockResult {
    /** True if the lock was acquired and the job may proceed */
    acquired: boolean;
    /** The Redis / memory lock key */
    lockKey: string;
    /** The unique run token assigned to this holder */
    lockId: string;
    /** Release callback to free the lock upon completion */
    release: () => Promise<void>;
}

/**
 * In-memory fallback lock store for unconfigured environments, isolated unit tests,
 * and single-node development runs.
 */
const inMemoryLocks = new Map<string, { lockId: string; expiresAt: number }>();

/**
 * Clean up expired in-memory locks periodically.
 */
function sweepExpiredInMemoryLocks(): void {
    const now = Date.now();
    for (const [key, lock] of inMemoryLocks.entries()) {
        if (lock.expiresAt <= now) {
            inMemoryLocks.delete(key);
        }
    }
}

/**
 * Acquire an exclusive distributed lock for a scheduled cron task.
 *
 * Prevents overlapping runs (LUGX-096, Group 7) across multiple serverless instances
 * or concurrent scheduler triggers using atomic Redis `SET ... NX EX` with fallback
 * to an in-memory TTL lock.
 *
 * @param jobName - Unique task identifier (e.g. 'expire-reservations', 'purge-deleted')
 * @param ttlSeconds - Lock time-to-live in seconds before automatic release (default: 300)
 */
export async function acquireCronLock(
    jobName: string,
    ttlSeconds: number = 300
): Promise<CronLockResult> {
    const lockKey = `cron:lock:${jobName}`;
    const lockId = `cron_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const now = Date.now();

    // 1. Primary Distributed Lock via Upstash Redis
    if (isRedisConfigured()) {
        try {
            // SET key value NX EX ttl
            const result = await redis.set(lockKey, lockId, { nx: true, ex: ttlSeconds });

            if (result === null) {
                // Key already exists — another runner holds the lock
                return {
                    acquired: false,
                    lockKey,
                    lockId,
                    release: async () => {},
                };
            }

            return {
                acquired: true,
                lockKey,
                lockId,
                release: async () => {
                    try {
                        const current = await redis.get<string>(lockKey);
                        if (current === lockId) {
                            await redis.del(lockKey);
                        }
                    } catch (err) {
                        console.error(`[CronLock] Error releasing Redis lock ${lockKey}:`, err);
                    }
                },
            };
        } catch (redisErr) {
            console.warn(`[CronLock] Redis error acquiring lock ${lockKey}, falling back to in-memory:`, redisErr);
        }
    }

    // 2. In-Memory Fallback Guard
    sweepExpiredInMemoryLocks();
    const existing = inMemoryLocks.get(lockKey);
    if (existing && existing.expiresAt > now) {
        return {
            acquired: false,
            lockKey,
            lockId,
            release: async () => {},
        };
    }

    inMemoryLocks.set(lockKey, { lockId, expiresAt: now + ttlSeconds * 1000 });

    return {
        acquired: true,
        lockKey,
        lockId,
        release: async () => {
            const current = inMemoryLocks.get(lockKey);
            if (current && current.lockId === lockId) {
                inMemoryLocks.delete(lockKey);
            }
        },
    };
}
