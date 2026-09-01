/**
 * In-Memory Webhook Deduplication and Test Reset Utilities (Phase 13)
 *
 * Provides fast-path deduplication for Stripe webhook events and isolated test reset helper.
 * Extracted from route.ts to strictly adhere to Next.js App Router route module export rules.
 */

const processedEventIds = new Set<string>();

/**
 * Checks whether the webhook event ID is already in the in-memory fast-path set.
 */
export function isEventProcessedInMemory(eventId: string): boolean {
    return processedEventIds.has(eventId);
}

/**
 * Marks a webhook event ID as processed in the in-memory set and performs FIFO eviction if size > 10,000.
 */
export function markEventProcessedInMemory(eventId: string): void {
    processedEventIds.add(eventId);

    if (processedEventIds.size > 10_000) {
        let count = 0;
        for (const id of processedEventIds) {
            processedEventIds.delete(id);
            if (++count >= 5_000) break;
        }
    }
}

/**
 * Test-only helper that empties the in-memory dedupe set between test runs.
 * Named with a leading underscore so no production caller can mistake it for
 * runtime API — it exists solely so regression tests can simulate server restarts.
 * @internal
 */
export function __resetProcessedEventIds(): void {
    processedEventIds.clear();
}

/**
 * Generic handler result interface for internal webhook processors.
 */
export interface HandlerResult {
    success: boolean;
    userId?: string;
    subscriptionId?: string;
    error?: string;
}
