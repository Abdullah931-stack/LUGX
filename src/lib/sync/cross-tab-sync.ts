/**
 * Cross-Tab Sync Channel
 * 
 * Provides instantaneous, lightweight event notifications between browser tabs/windows
 * sharing the same workspace session without requiring server polling.
 * Scoped by userId (lugx_sync_${userId}) to isolate multi-tenant tab sessions.
 * 
 * Remediates: LUGX-109
 */

import type { FileEncryptionMetadata } from '@/server/db';

export interface CrossTabSyncEvent {
    type: 'file_saved' | 'conflict_resolved' | 'file_deleted' | 'file_encrypted' | 'file_decrypted' | 'vault_unlocked' | 'vault_locked';
    fileId?: string;
    version?: number;
    etag?: string;
    metadata?: FileEncryptionMetadata | Record<string, unknown> | null;
    timestamp: number;
    senderTabId: string;
}

let activeSyncUserId: string | null = null;

/**
 * Configure active user ID for cross-tab broadcast channels.
 */
export function setActiveSyncUserId(userId: string | null): void {
    activeSyncUserId = userId ? userId.trim() : null;
}

/**
 * Get active user ID currently configured for cross-tab broadcast channels.
 */
export function getActiveSyncUserId(): string | null {
    return activeSyncUserId;
}

/**
 * Derive user-scoped channel name (lugx_sync_${userId}).
 * Falls back to textai_cross_tab_sync if no userId is provided or active.
 */
export function getSyncChannelName(userId?: string): string {
    const uid = userId?.trim() || activeSyncUserId;
    if (uid) {
        return `lugx_sync_${uid}`;
    }
    return 'textai_cross_tab_sync';
}

// Generate unique ID for this browser tab instance
export const currentTabId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Broadcast an event to all other open tabs in the browser for the current user session
 */
export function broadcastCrossTabEvent(
    event: Omit<CrossTabSyncEvent, 'senderTabId' | 'timestamp'>,
    userId?: string
): void {
    if (typeof BroadcastChannel === 'undefined') return;

    const payload: CrossTabSyncEvent = {
        ...event,
        senderTabId: currentTabId,
        timestamp: Date.now(),
    };

    try {
        const channelName = getSyncChannelName(userId);
        const channel = new BroadcastChannel(channelName);
        channel.postMessage(payload);
        channel.close();
    } catch {
        // Silently ignore BroadcastChannel errors in restricted contexts
    }
}

/**
 * Subscribe to cross-tab file sync events scoped to the current user session
 */
export function subscribeCrossTabSync(
    callback: (event: CrossTabSyncEvent) => void,
    userId?: string
): () => void {
    if (typeof BroadcastChannel === 'undefined') return () => {};

    try {
        const channelName = getSyncChannelName(userId);
        const channel = new BroadcastChannel(channelName);

        const handleMessage = (e: MessageEvent) => {
            const data = e.data as CrossTabSyncEvent;
            // Ignore events originating from this exact tab or missing valid sender
            if (data && typeof data.senderTabId === 'string' && data.senderTabId !== currentTabId) {
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
