/**
 * Tab Sync Management Module
 * 
 * Provides user-scoped cross-tab synchronization and channel isolation.
 * Formats channel names as lugx_sync_${userId} to prevent multi-tenant event bleeding.
 * 
 * Remediates: LUGX-109
 */

export * from './cross-tab-sync';

import {
    broadcastCrossTabEvent,
    subscribeCrossTabSync,
    getSyncChannelName,
    currentTabId,
    CrossTabSyncEvent,
} from './cross-tab-sync';

/**
 * Creates a scoped tab sync controller for a specific user ID
 */
export function createUserTabSync(userId: string) {
    const channelName = getSyncChannelName(userId);

    return {
        userId,
        channelName,
        currentTabId,
        broadcast: (event: Omit<CrossTabSyncEvent, 'senderTabId' | 'timestamp'>) => {
            broadcastCrossTabEvent(event, userId);
        },
        subscribe: (callback: (event: CrossTabSyncEvent) => void) => {
            return subscribeCrossTabSync(callback, userId);
        },
    };
}
