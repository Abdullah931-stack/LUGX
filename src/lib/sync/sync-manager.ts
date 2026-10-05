/**
 * Sync Manager
 * 
 * Core synchronization orchestrator coordinating dirty pushes, queue processing,
 * and remote updates. Scoped strictly per user identity and workspace context.
 */

import { indexedDBManager, createIndexedDBManager, IndexedDBManager } from './indexeddb';
import { IDBFile, IDBOperation, SyncQueueItem } from './idb-types';
import { connectionDetector } from './connection-detector';
import { syncRollback, createSyncRollback, SyncRollback } from './rollback';
import { syncErrorHandler, SyncErrorType } from './error-handler';
import { sessionKeyStore } from './session-key-store';
import { sanitizeLogValue } from './log-sanitizer';
import { syncPerformanceMonitor } from './performance-monitor';
import { ConflictStore, conflictStore } from '../idb/conflict-store';
import type { PendingEncryptedConflict } from './types/vault';
import { SyncEncryptedConflictStore, type SyncEncryptedConflictStoreOptions } from './sync-encrypted-conflict-store';
import { SyncQueueWorker, type SyncQueueWorkerOptions } from './sync-queue-worker';
import { SyncPullEngine, type SyncPullEngineOptions } from './sync-pull-engine';
import type {
    QuarantineDiagnostics, SyncStatus, FileSyncResult, SyncResult, RemoteUpdateEvent,
    RemoteUpdateCallback, SyncStatusCallback, ConflictCallback, SyncManagerConfig,
} from './sync-manager.types';

export * from './sync-manager.types';
export {
    SyncEncryptedConflictStore, type SyncEncryptedConflictStoreOptions,
    SyncQueueWorker, type SyncQueueWorkerOptions,
    SyncPullEngine, type SyncPullEngineOptions,
};

class SyncManager {
    private status: SyncStatus = 'stopped';
    private statusCallbacks = new Set<SyncStatusCallback>();
    private remoteUpdateCallbacks = new Set<RemoteUpdateCallback>();
    private conflictCallback?: ConflictCallback;
    private syncQueue: SyncQueueItem[] = [];
    private autoSyncTimer?: ReturnType<typeof setInterval>;
    private config: SyncManagerConfig | null = null;
    private initialized = false; private isDestroyed = false; private ownsIdb = false;
    private isConsumerRunning = false; private hasPendingOnlineConsumer = false; private enableJitter = false;
    private maxRetries = 5; private baseBackoffMs = 1000; private maxBackoffMs = 30000;
    private idb: IndexedDBManager;
    private rollback: SyncRollback;
    private conflictStore: ConflictStore;
    private activeAbortController: AbortController | null = null;
    private unsubscribeConnection?: () => void;
    private unsubscribeKeyStore?: (() => void) | null;
    private encryptedConflictStore: SyncEncryptedConflictStore;
    private queueWorker: SyncQueueWorker;
    private pullEngine: SyncPullEngine;

    get isQueueProcessing(): boolean { return this.queueWorker.isQueueProcessing; }
    set isQueueProcessing(value: boolean) { this.queueWorker.isQueueProcessing = value; }
    private get pendingEncryptedConflicts(): Map<string, PendingEncryptedConflict> { return this.encryptedConflictStore.rawMap; }

    constructor(initialConfig?: SyncManagerConfig) {
        if (initialConfig?.userId?.trim()) this.config = { ...initialConfig, userId: initialConfig.userId.trim() };
        if (initialConfig?.idb) { this.idb = initialConfig.idb; this.ownsIdb = false; }
        else if (this.config?.userId) { this.idb = createIndexedDBManager(this.config.userId); this.ownsIdb = true; }
        else { this.idb = indexedDBManager; this.ownsIdb = false; }

        this.rollback = this.idb === indexedDBManager ? syncRollback : createSyncRollback(this.idb);
        this.conflictStore = this.idb === indexedDBManager ? conflictStore : new ConflictStore(this.idb);
        if (initialConfig?.maxRetries) this.maxRetries = initialConfig.maxRetries;
        if (initialConfig?.enableJitter !== undefined) this.enableJitter = initialConfig.enableJitter;

        this.encryptedConflictStore = new SyncEncryptedConflictStore({
            userId: this.config?.userId, idb: this.idb, conflictStore: this.conflictStore,
            rollback: this.rollback, conflictCallback: this.conflictCallback,
            pushResolved: (file) => this.queueWorker.pushFile(file),
        });
        this.queueWorker = new SyncQueueWorker({
            userId: this.config?.userId || 'anon', apiBaseUrl: initialConfig?.apiBaseUrl,
            maxRetries: this.maxRetries, baseBackoffMs: this.baseBackoffMs,
            maxBackoffMs: this.maxBackoffMs, enableJitter: this.enableJitter,
            idb: this.idb, rollback: this.rollback, conflictStore: this.conflictStore,
            encryptedConflictStore: this.encryptedConflictStore,
            getConflictCallback: () => this.conflictCallback,
        });
        this.pullEngine = new SyncPullEngine({
            userId: this.config?.userId || 'anon', apiBaseUrl: initialConfig?.apiBaseUrl,
            idb: this.idb, rollback: this.rollback, conflictStore: this.conflictStore,
            encryptedConflictStore: this.encryptedConflictStore,
            getConflictCallback: () => this.conflictCallback,
            onRemoteUpdate: (e) => this.notifyRemoteUpdate(e),
        });
    }

    private notifyRemoteUpdate(event: RemoteUpdateEvent): void {
        this.remoteUpdateCallbacks.forEach(cb => { try { cb(event); } catch (err) { console.error('[SyncManager] Remote cb error:', err); } });
    }

    private syncSubsystems(): void {
        const userId = this.config?.userId || 'anon';
        this.encryptedConflictStore.updateContext({
            userId: this.config?.userId, idb: this.idb, conflictStore: this.conflictStore,
            rollback: this.rollback, conflictCallback: this.conflictCallback,
            pushResolved: (file) => this.queueWorker.pushFile(file),
        });
        this.queueWorker.updateConfig({
            userId, apiBaseUrl: this.config?.apiBaseUrl,
            maxRetries: this.maxRetries, baseBackoffMs: this.baseBackoffMs,
            maxBackoffMs: this.maxBackoffMs, enableJitter: this.enableJitter,
            idb: this.idb, rollback: this.rollback, conflictStore: this.conflictStore,
            encryptedConflictStore: this.encryptedConflictStore,
            getConflictCallback: () => this.conflictCallback,
        });
        this.pullEngine.updateConfig({
            userId, apiBaseUrl: this.config?.apiBaseUrl,
            idb: this.idb, rollback: this.rollback, conflictStore: this.conflictStore,
            encryptedConflictStore: this.encryptedConflictStore,
            getConflictCallback: () => this.conflictCallback,
            onRemoteUpdate: (e) => this.notifyRemoteUpdate(e),
        });
    }

    getUserId(): string | null { return this.config?.userId || null; }
    getConflictStore(): ConflictStore { return this.conflictStore; }

    async init(config: SyncManagerConfig): Promise<void> {
        if (!config?.userId?.trim()) {
            this.setStatus('stopped');
            throw new Error('SyncManager requires a valid, non-empty userId');
        }
        const normalizedUserId = config.userId.trim();
        if (this.initialized && !this.isDestroyed && this.config?.userId === normalizedUserId) return;
        if (this.initialized && this.config?.userId !== normalizedUserId) this.destroy();
        if (this.ownsIdb && this.idb && this.idb !== config.idb && this.idb !== indexedDBManager) this.idb.close();

        this.isDestroyed = false;
        this.config = { ...config, userId: normalizedUserId };

        if (config.idb) { this.idb = config.idb; this.ownsIdb = false; }
        else if (!(this.ownsIdb && this.idb && this.idb !== indexedDBManager && this.idb.getUserId?.() === normalizedUserId)) {
            this.idb = createIndexedDBManager(this.config.userId); this.ownsIdb = true;
        }
        await this.idb.init(this.config.userId);
        this.rollback = createSyncRollback(this.idb);
        this.conflictStore = new ConflictStore(this.idb);
        if (config.maxRetries !== undefined) this.maxRetries = config.maxRetries;
        if (config.enableJitter !== undefined) this.enableJitter = config.enableJitter;

        this.syncSubsystems();
        await this.idb.resetSyncingOperations();
        connectionDetector.init();

        this.unsubscribeConnection = connectionDetector.onChange(async (state) => {
            if (this.isDestroyed) return;
            if (state === 'online') {
                if (this.status === 'offline') this.setStatus('idle');
                await this.triggerOnlineConsumer();
            } else if (state === 'offline') this.setStatus('offline');
        });

        this.setStatus(!connectionDetector.isOnline() ? 'offline' : 'idle');
        if (config.autoSyncInterval && config.autoSyncInterval > 0) this.startAutoSync(config.autoSyncInterval);

        this.unsubscribeKeyStore = sessionKeyStore.subscribe(async (isUnlocked) => {
            if (this.isDestroyed || !this.initialized || !isUnlocked || this.pendingEncryptedConflicts.size === 0) return;
            for (const fileId of Array.from(this.pendingEncryptedConflicts.keys())) {
                try { await this.resolvePendingEncryptedConflict(fileId); }
                catch (err) { console.error(`[SyncManager] Auto-resolution failed for ${fileId}:`, sanitizeLogValue(err)); }
            }
        });
        this.initialized = true;
    }

    destroy(): void {
        this.isDestroyed = true; this.initialized = false; this.stopAutoSync();
        try { this.activeAbortController?.abort(); } catch {}
        this.activeAbortController = null;
        if (this.unsubscribeConnection) { this.unsubscribeConnection(); this.unsubscribeConnection = undefined; }
        if (this.unsubscribeKeyStore) { this.unsubscribeKeyStore(); this.unsubscribeKeyStore = null; }
        this.idb?.close();
        this.statusCallbacks.clear(); this.remoteUpdateCallbacks.clear();
        this.syncQueue = []; this.conflictCallback = undefined;
        this.isConsumerRunning = this.hasPendingOnlineConsumer = false;
        this.queueWorker.destroy(); this.pullEngine.destroy();
        this.encryptedConflictStore.clear(); this.rollback?.clearAll();
        this.setStatus('stopped');
    }

    setConflictCallback(cb: ConflictCallback): void {
        this.conflictCallback = cb;
        this.encryptedConflictStore.setConflictCallback(cb);
        this.pullEngine.updateConfig({ getConflictCallback: () => this.conflictCallback });
    }

    onRemoteUpdate(cb: RemoteUpdateCallback): () => void {
        this.remoteUpdateCallbacks.add(cb);
        return () => this.remoteUpdateCallbacks.delete(cb);
    }

    getPendingEncryptedConflicts(): PendingEncryptedConflict[] { return this.encryptedConflictStore.getPendingEncryptedConflicts(); }
    getPendingEncryptedConflict(id: string) { return this.encryptedConflictStore.getPendingEncryptedConflict(id); }
    isEncryptedConflictLocked(id: string) { return this.encryptedConflictStore.isEncryptedConflictLocked(id); }
    onEncryptedConflictLocked(cb: (c: PendingEncryptedConflict) => void) { return this.encryptedConflictStore.onEncryptedConflictLocked(cb); }
    private notifyEncryptedConflictLocked(c: PendingEncryptedConflict) { this.encryptedConflictStore.notifyEncryptedConflictLocked(c); }
    quarantineEncryptedConflict(c: PendingEncryptedConflict) { this.encryptedConflictStore.quarantineEncryptedConflict(c); }
    getQuarantineDiagnostics(): QuarantineDiagnostics { return this.encryptedConflictStore.getQuarantineDiagnostics(); }
    async discardPendingEncryptedConflict(id: string) { return this.encryptedConflictStore.discardPendingEncryptedConflict(id); }
    async resolvePendingEncryptedConflict(id: string) { return this.encryptedConflictStore.resolvePendingEncryptedConflict(id); }

    private setStatus(status: SyncStatus, progress?: number): void {
        if (this.isDestroyed && status !== 'stopped') return;
        this.status = status;
        this.statusCallbacks.forEach(cb => { try { cb(status, progress); } catch (e) { console.error('[SyncManager] Status cb error:', e); } });
    }
    getStatus(): SyncStatus { return this.status; }
    onStatusChange(cb: SyncStatusCallback): () => void {
        this.statusCallbacks.add(cb);
        return () => this.statusCallbacks.delete(cb);
    }

    private startAutoSync(intervalMs: number): void {
        this.stopAutoSync();
        this.autoSyncTimer = setInterval(() => {
            if (!this.isDestroyed && connectionDetector.isOnline() && (this.status === 'idle' || this.status === 'queued')) this.sync();
        }, intervalMs);
    }

    private stopAutoSync(): void {
        if (this.autoSyncTimer) { clearInterval(this.autoSyncTimer); this.autoSyncTimer = undefined; }
    }

    private async triggerOnlineConsumer(): Promise<void> {
        if (this.isDestroyed || !this.initialized || !connectionDetector.isOnline()) return;
        if (this.isConsumerRunning) { this.hasPendingOnlineConsumer = true; return; }
        this.isConsumerRunning = true;
        try { await this.sync(); }
        catch (err) { console.error('[SyncManager] Online consumer error:', err); }
        finally {
            this.isConsumerRunning = false;
            if (this.hasPendingOnlineConsumer && !this.isDestroyed && connectionDetector.isOnline()) {
                this.hasPendingOnlineConsumer = false; this.triggerOnlineConsumer();
            }
        }
    }

    async sync(): Promise<SyncResult> {
        if (this.isDestroyed || this.status === 'stopped') {
            return { success: false, filesProcessed: 0, filesPushed: 0, filesPulled: 0, conflicts: [], errors: ['SyncManager is stopped or uninitialized'], timestamp: Date.now() };
        }
        if (!this.config?.userId) throw new Error('SyncManager not initialized with valid userId');
        if (this.status === 'syncing') {
            return { success: false, filesProcessed: 0, filesPushed: 0, filesPulled: 0, conflicts: [], errors: ['Sync already in progress'], timestamp: Date.now() };
        }
        if (!connectionDetector.isOnline()) {
            this.setStatus('offline');
            return { success: false, filesProcessed: 0, filesPushed: 0, filesPulled: 0, conflicts: [], errors: ['Offline'], timestamp: Date.now() };
        }

        this.activeAbortController = new AbortController();
        const signal = this.activeAbortController.signal;
        this.setStatus('syncing', 0);
        const timingId = syncPerformanceMonitor.startTiming('sync_duration');
        const res: SyncResult = { success: true, filesProcessed: 0, filesPushed: 0, filesPulled: 0, conflicts: [], errors: [], timestamp: Date.now() };

        try {
            const queueRes = await this.processOperationsQueue(signal);
            res.filesPushed += queueRes.succeeded;
            res.conflicts.push(...queueRes.conflicts);
            if (queueRes.failed > 0) res.errors.push(`Failed to sync ${queueRes.failed} queued operations`);
            if (signal.aborted) throw new Error('Sync aborted');

            const pushRes = await this.pushDirtyFiles(signal);
            res.filesPushed += pushRes.pushed;
            res.conflicts.push(...pushRes.conflicts);
            res.errors.push(...pushRes.errors);
            if (signal.aborted) throw new Error('Sync aborted');

            const pullRes = await this.pullEngine.pullUpdates(signal);
            res.filesPulled = pullRes.pulled;
            res.conflicts.push(...pullRes.conflicts);
            res.errors.push(...pullRes.errors);

            res.filesProcessed = res.filesPushed + res.filesPulled;
            res.success = res.errors.length === 0;
            await this.idb.updateLastSyncedAt(this.config.userId);
            if (!this.isDestroyed) this.setStatus('idle');
        } catch (error) {
            if (signal.aborted || this.isDestroyed) {
                res.success = false; res.errors.push('Sync aborted'); this.setStatus('stopped'); return res;
            }
            const syncErr = syncErrorHandler.fromException(error, 'Full sync');
            await syncErrorHandler.handle(syncErr);
            res.success = false; res.errors.push(syncErr.message);
            this.setStatus(syncErr.type === SyncErrorType.NETWORK_ERROR ? 'offline' : 'failed');
        } finally {
            this.activeAbortController = null;
            syncPerformanceMonitor.stopTiming(timingId, 'sync_duration', { filesProcessed: res.filesProcessed, pushed: res.filesPushed, pulled: res.filesPulled }, res.success);
        }
        return res;
    }

    async processOperationsQueue(s?: AbortSignal) {
        return (this.isDestroyed || !this.initialized || this.status === 'stopped')
            ? { processed: 0, succeeded: 0, failed: 0, conflicts: [] }
            : this.queueWorker.processOperationsQueue(s);
    }
    async processSingleOperation(op: IDBOperation, s?: AbortSignal): Promise<FileSyncResult> { return this.queueWorker.processSingleOperation(op, s); }
    async pushDirtyFiles(s?: AbortSignal) { return this.queueWorker.pushDirtyFiles(s); }
    async pushFile(file: IDBFile, s?: AbortSignal): Promise<FileSyncResult> { return this.queueWorker.pushFile(file, s); }
    private async pullUpdates(s?: AbortSignal) { return this.pullEngine.pullUpdates(s); }
    private async pullFile(file: Parameters<SyncPullEngine['pullFile']>[0], s?: AbortSignal): Promise<FileSyncResult> { return this.pullEngine.pullFile(file, s); }

    async queueSync(fileId: string, priority: 1 | 2 | 3 = 2, operationId?: string): Promise<void> {
        if (this.isDestroyed || !this.initialized) return;
        this.syncQueue = this.syncQueue.filter(item => item.fileId !== fileId);
        const opId = operationId || `op_${this.config?.userId || 'anon'}_${fileId}_${Date.now()}`;
        this.syncQueue.push({ operationId: opId, fileId, priority, addedAt: Date.now(), retryCount: 0 });
        this.syncQueue.sort((a, b) => a.priority - b.priority);
        this.setStatus('queued');

        const file = await this.idb.getFile(fileId);
        await this.idb.addOperation({
            id: opId, operationId: opId, userId: this.config?.userId || 'anon',
            fileId, baseVersion: file?.version || 1, status: 'queued', attempts: 0,
            operationType: 'update', position: 0, content: file?.content || '',
            timestamp: Date.now(), synced: false,
            snapshot: file ? { content: file.content, etag: file.etag, version: file.version } : undefined,
        });

        if (connectionDetector.isOnline() && (this.status === 'idle' || this.status === 'queued')) {
            this.processOperationsQueue().catch(err => console.error('[SyncManager] Queue consumer error:', err));
        }
    }

    async syncFile(fileId: string): Promise<FileSyncResult> {
        if (this.isDestroyed || !this.initialized) return { fileId, success: false, action: 'skipped', error: 'SyncManager is not initialized' };
        const file = await this.idb.getFile(fileId);
        if (!file) return { fileId, success: false, action: 'skipped', error: 'File not found' };
        return file.isDirty ? this.queueWorker.pushFile(file) : { fileId, success: true, action: 'skipped' };
    }
}

export function createSyncManager(config?: SyncManagerConfig): SyncManager { return new SyncManager(config); }
export const syncManager = new SyncManager();
export { SyncManager };
