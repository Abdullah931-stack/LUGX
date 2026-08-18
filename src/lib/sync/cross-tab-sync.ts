/**
 * Cross-Tab Sync Channel
 * 
 * Provides instantaneous, lightweight event notifications between browser tabs/windows
 * sharing the same workspace session without requiring server polling.
 */

export interface CrossTabSyncEvent {
    type: 'file_saved' | 'conflict_resolved' | 'file_deleted';
    fileId: string;
    version?: number;
    etag?: string;
    timestamp: number;
    senderTabId: string;
}

const CHANNEL_NAME = 'textai_cross_tab_sync';

// Generate unique ID for this browser tab instance
export const currentTabId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Broadcast an event to all other open tabs in the browser
 */
export function broadcastCrossTabEvent(
    event: Omit<CrossTabSyncEvent, 'senderTabId' | 'timestamp'>
): void {
    if (typeof window === 'undefined') return;

    const payload: CrossTabSyncEvent = {
        ...event,
        senderTabId: currentTabId,
        timestamp: Date.now(),
    };

    if ('BroadcastChannel' in window) {
        try {
            const channel = new BroadcastChannel(CHANNEL_NAME);
            channel.postMessage(payload);
            channel.close();
        } catch {
            // Silently ignore BroadcastChannel errors in restricted contexts
        }
    }
}

/**
 * Subscribe to cross-tab file sync events
 */
export function subscribeCrossTabSync(
    callback: (event: CrossTabSyncEvent) => void
): () => void {
    if (typeof window === 'undefined') return () => {};

    if ('BroadcastChannel' in window) {
        try {
            const channel = new BroadcastChannel(CHANNEL_NAME);

            const handleMessage = (e: MessageEvent) => {
                const data = e.data as CrossTabSyncEvent;
                // Ignore events originating from this exact tab
                if (data && data.senderTabId !== currentTabId) {
                    callback(data);
                }
            };

            channel.addEventListener('message', handleMessage);

            return () => {
                channel.removeEventListener('message', handleMessage);
                channel.close();
            };
        } catch {
            return () => {};
        }
    }

    return () => {};
}
