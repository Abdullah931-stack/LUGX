/**
 * Bounded parallel execution (W7).
 *
 * ENGINEERING UPGRADE: sync pushes previously ran strictly sequentially
 * (`for (const file of dirtyFiles) await pushFile(file)`), so 200 dirty
 * files meant 200 sequential round-trips. Pure `Promise.all` over all of
 * them is worse: it opens unbounded in-flight requests that hit server
 * rate limits and exhaust browser connection pools.
 *
 * This implements the standard bounded-concurrency pattern: keep exactly
 * `concurrency` workers busy, draining the work queue as each task settles.
 * No external dependency; one clean, testable unit.
 */

export interface ParallelResult<T> {
    /** Settled results in input order (undefined slots are rejections) */
    results: (T | undefined)[];
    /** Errors in input order, matching rejected slots */
    errors: (Error | undefined)[];
}

/**
 * Run `tasks` with at most `concurrency` in flight at any time.
 * Rejections are captured per-task (never thrown) so one bad item cannot
 * cancel the batch — the caller decides what to do with each error.
 */
export async function runWithConcurrency<T>(
    tasks: (() => Promise<T>)[],
    concurrency: number
): Promise<ParallelResult<T>> {
    const limit = Math.max(1, Math.floor(concurrency));
    const results: (T | undefined)[] = new Array(tasks.length).fill(undefined);
    const errors: (Error | undefined)[] = new Array(tasks.length).fill(undefined);
    let index = 0;

    const worker = async () => {
        while (index < tasks.length) {
            const taskIndex = index++;
            try {
                results[taskIndex] = await tasks[taskIndex]();
            } catch (err) {
                errors[taskIndex] =
                    err instanceof Error ? err : new Error(String(err));
            }
        }
    };

    const workers = Array.from({ length: limit }, () => worker());
    await Promise.all(workers);

    return { results, errors };
}

/**
 * Default concurrency for sync push: 4 in-flight requests balances
 * throughput against server rate limits and browser connection limits.
 */
export const DEFAULT_PUSH_CONCURRENCY = 4;
