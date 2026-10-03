/**
 * Phase 15 Acceptance Tests: User-Scoped Cross-Tab Synchronization & Channel Isolation
 * 
 * Verifies:
 * 1. Channel names are derived strictly as `lugx_sync_${userId}`.
 * 2. Active sync user ID configuration works for ambient context.
 * 3. Strict tenant isolation: User A's channel messages never bleed into User B's channel.
 * 4. Sibling tabs with the same user ID receive broadcast events.
 * 5. Messages originating from the same tab ID are ignored (anti-echo).
 * 6. `createUserTabSync` returns properly scoped tab controller.
 * 
 * Remediates: LUGX-109
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    getSyncChannelName,
    setActiveSyncUserId,
    getActiveSyncUserId,
    subscribeCrossTabSync,
    currentTabId,
    CrossTabSyncEvent,
} from '@/lib/sync/cross-tab-sync';
import { createUserTabSync } from '@/lib/sync/tab-sync';

describe('Phase 15: User-Scoped Cross-Tab Synchronization (LUGX-109)', () => {
    beforeEach(() => {
        setActiveSyncUserId(null);
    });

    afterEach(() => {
        setActiveSyncUserId(null);
    });

    describe('Channel Name Scoping', () => {
        it('should format channel name as lugx_sync_${userId}', () => {
            expect(getSyncChannelName('user_12345')).toBe('lugx_sync_user_12345');
            expect(getSyncChannelName('alice@example.com')).toBe('lugx_sync_alice@example.com');
        });

        it('should trim whitespace around userId', () => {
            expect(getSyncChannelName('  user_trimmed  ')).toBe('lugx_sync_user_trimmed');
        });

        it('should fall back to activeSyncUserId if userId parameter is omitted', () => {
            setActiveSyncUserId('user_ambient_99');
            expect(getActiveSyncUserId()).toBe('user_ambient_99');
            expect(getSyncChannelName()).toBe('lugx_sync_user_ambient_99');
        });

        it('should fall back to textai_cross_tab_sync if no userId and no activeSyncUserId', () => {
            expect(getSyncChannelName()).toBe('textai_cross_tab_sync');
        });
    });

    describe('Multi-Tenant BroadcastChannel Isolation', () => {
        it('should isolate events between different user IDs (no cross-tenant leakage)', async () => {
            const userA = 'tenant_user_alpha';
            const userB = 'tenant_user_beta';

            const eventsUserA: CrossTabSyncEvent[] = [];
            const eventsUserB: CrossTabSyncEvent[] = [];

            // User A subscriber
            const unsubA = subscribeCrossTabSync((event) => {
                eventsUserA.push(event);
            }, userA);

            // User B subscriber
            const unsubB = subscribeCrossTabSync((event) => {
                eventsUserB.push(event);
            }, userB);

            // Sibling tab for user A sends an event
            const siblingChannelA = new BroadcastChannel(`lugx_sync_${userA}`);
            siblingChannelA.postMessage({
                type: 'file_saved',
                fileId: 'file_alpha_1',
                version: 1,
                senderTabId: 'sibling_tab_for_alpha',
                timestamp: Date.now(),
            });

            // Wait for dispatch
            await new Promise((resolve) => setTimeout(resolve, 60));

            // User A received the event
            expect(eventsUserA).toHaveLength(1);
            expect(eventsUserA[0].fileId).toBe('file_alpha_1');

            // User B received NOTHING - strict tenant boundary preserved!
            expect(eventsUserB).toHaveLength(0);

            // Now sibling tab for user B sends an event
            const siblingChannelB = new BroadcastChannel(`lugx_sync_${userB}`);
            siblingChannelB.postMessage({
                type: 'file_deleted',
                fileId: 'file_beta_9',
                senderTabId: 'sibling_tab_for_beta',
                timestamp: Date.now(),
            });

            await new Promise((resolve) => setTimeout(resolve, 60));

            expect(eventsUserA).toHaveLength(1); // Still 1, did not receive B's event
            expect(eventsUserB).toHaveLength(1);
            expect(eventsUserB[0].fileId).toBe('file_beta_9');

            unsubA();
            unsubB();
            siblingChannelA.close();
            siblingChannelB.close();
        });

        it('should filter out echo events originating from the current tab ID', async () => {
            const userId = 'user_echo_test';
            const receivedEvents: CrossTabSyncEvent[] = [];

            const unsub = subscribeCrossTabSync((event) => {
                receivedEvents.push(event);
            }, userId);

            // Sibling tab sends event with currentTabId as sender (simulating echo)
            const channel = new BroadcastChannel(`lugx_sync_${userId}`);
            channel.postMessage({
                type: 'file_saved',
                fileId: 'file_echo',
                senderTabId: currentTabId, // SAME TAB ID!
                timestamp: Date.now(),
            });

            await new Promise((resolve) => setTimeout(resolve, 60));

            // Should be filtered out because senderTabId === currentTabId
            expect(receivedEvents).toHaveLength(0);

            // Sibling tab sends event with different tab ID
            channel.postMessage({
                type: 'file_saved',
                fileId: 'file_valid',
                senderTabId: 'different_tab_xyz',
                timestamp: Date.now(),
            });

            await new Promise((resolve) => setTimeout(resolve, 60));

            expect(receivedEvents).toHaveLength(1);
            expect(receivedEvents[0].fileId).toBe('file_valid');

            unsub();
            channel.close();
        });

        it('createUserTabSync should provide a bound, user-scoped controller', async () => {
            const userId = 'controller_user_42';
            const controller = createUserTabSync(userId);

            expect(controller.userId).toBe(userId);
            expect(controller.channelName).toBe(`lugx_sync_${userId}`);
            expect(controller.currentTabId).toBe(currentTabId);

            const received: CrossTabSyncEvent[] = [];
            const unsub = controller.subscribe((e) => {
                received.push(e);
            });

            const externalChannel = new BroadcastChannel(`lugx_sync_${userId}`);
            externalChannel.postMessage({
                type: 'conflict_resolved',
                fileId: 'file_resolved_via_ctrl',
                senderTabId: 'external_sibling',
                timestamp: Date.now(),
            });

            await new Promise((resolve) => setTimeout(resolve, 60));

            expect(received).toHaveLength(1);
            expect(received[0].type).toBe('conflict_resolved');
            expect(received[0].fileId).toBe('file_resolved_via_ctrl');

            unsub();
            externalChannel.close();
        });
    });
});
