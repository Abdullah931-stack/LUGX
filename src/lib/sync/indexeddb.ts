/**
 * IndexedDB Manager for Offline Sync System
 */

import {
    IDBFile,
    IDBOperation,
    IDBSyncMetadata,
    IDB_CONFIG,
    getDatabaseName,
} from './idb-types';

class IndexedDBManager {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<IDBDatabase> | null = null;
    private userId: string | null = null;

    constructor(userId?: string) {
        if (userId && userId.trim()) {
            this.userId = userId.trim();
        }
    }

    /**
     * Get current scoped userId
     */
    getUserId(): string | null {
        return this.userId;
    }

    /**
     * Initialize IndexedDB database scoped to a specific user
     */
    async init(userId?: string): Promise<IDBDatabase> {
        const targetUserId = userId?.trim() || this.userId;

        if (!targetUserId) {
            throw new Error('Valid userId is required to initialize IndexedDB');
        }

        // If user changed, close existing connection
        if (this.userId && this.userId !== targetUserId) {
            this.close();
        }

        this.userId = targetUserId;

        if (this.initPromise) return this.initPromise;
        if (this.db) return this.db;

        const dbName = getDatabaseName(this.userId);

        this.initPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                this.initPromise = null;
                reject(new Error('IndexedDB is not available in the current environment'));
                return;
            }

            const request = indexedDB.open(dbName, IDB_CONFIG.DB_VERSION);

            request.onerror = () => {
                this.initPromise = null;
                reject(request.error || new Error(`Failed to open database: ${dbName}`));
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (event.oldVersion < 1) {
                    this.createInitialStores(db);
                }
            };
        });

        return this.initPromise;
    }


    private createInitialStores(db: IDBDatabase): void {
        if (!db.objectStoreNames.contains(IDB_CONFIG.STORES.FILES)) {
            const filesStore = db.createObjectStore(IDB_CONFIG.STORES.FILES, { keyPath: 'id' });
            filesStore.createIndex('isDirty', 'isDirty', { unique: false });
            filesStore.createIndex('lastModified', 'lastModified', { unique: false });
            filesStore.createIndex('parentFolderId', 'parentFolderId', { unique: false });
        }

        if (!db.objectStoreNames.contains(IDB_CONFIG.STORES.OPERATIONS)) {
            const opsStore = db.createObjectStore(IDB_CONFIG.STORES.OPERATIONS, { keyPath: 'id' });
            opsStore.createIndex('fileId', 'fileId', { unique: false });
            opsStore.createIndex('synced', 'synced', { unique: false });
            opsStore.createIndex('timestamp', 'timestamp', { unique: false });
            opsStore.createIndex('fileId_synced', ['fileId', 'synced'], { unique: false });
        }

        if (!db.objectStoreNames.contains(IDB_CONFIG.STORES.SYNC_METADATA)) {
            db.createObjectStore(IDB_CONFIG.STORES.SYNC_METADATA, { keyPath: 'id' });
        }
    }

    private async getDB(): Promise<IDBDatabase> {
        if (!this.db) await this.init();
        return this.db!;
    }

    async getFile(id: string): Promise<IDBFile | undefined> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async saveFile(file: IDBFile): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).put(file);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async deleteFile(id: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllFiles(): Promise<IDBFile[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getDirtyFiles(): Promise<IDBFile[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).getAll();
            request.onsuccess = () => {
                // Filter dirty files in memory since IndexedDB doesn't support boolean index keys
                const files = (request.result as IDBFile[]).filter(f => f.isDirty === true);
                resolve(files);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async markFileDirty(id: string): Promise<void> {
        const file = await this.getFile(id);
        if (file) {
            file.isDirty = true;
            file.lastModified = Date.now();
            await this.saveFile(file);
        }
    }

    async markFileClean(id: string, newEtag: string): Promise<void> {
        const file = await this.getFile(id);
        if (file) {
            file.isDirty = false;
            file.etag = newEtag;
            file.lastSyncedAt = Date.now();
            await this.saveFile(file);
        }
    }

    async addOperation(operation: IDBOperation): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).add(operation);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getOperations(fileId: string): Promise<IDBOperation[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const index = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).index('fileId');
            const request = index.getAll(IDBKeyRange.only(fileId));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getUnsyncedOperations(fileId: string): Promise<IDBOperation[]> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).getAll();
            request.onsuccess = () => {
                // Filter in memory since IndexedDB doesn't support boolean/compound boolean index keys
                const ops = (request.result as IDBOperation[]).filter(
                    o => o.fileId === fileId && o.synced === false
                );
                resolve(ops);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async markOperationsSynced(operationIds: string[]): Promise<void> {
        const db = await this.getDB();
        const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
        const store = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);

        for (const id of operationIds) {
            const request = store.get(id);
            request.onsuccess = () => {
                const op = request.result as IDBOperation;
                if (op) {
                    op.synced = true;
                    store.put(op);
                }
            };
        }

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async deleteOldOperations(maxAgeMs: number = IDB_CONFIG.MAX_OPERATION_AGE_MS): Promise<number> {
        const db = await this.getDB();
        const cutoffTime = Date.now() - maxAgeMs;
        let deletedCount = 0;

        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const index = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).index('timestamp');
            const request = index.openCursor(IDBKeyRange.upperBound(cutoffTime));

            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const op = cursor.value as IDBOperation;
                    if (op.synced) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                }
            };

            tx.oncomplete = () => resolve(deletedCount);
            tx.onerror = () => reject(tx.error);
        });
    }

    async replaceOperations(fileId: string, operations: IDBOperation[]): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const store = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);
            const index = store.index('fileId');

            const deleteRequest = index.openCursor(IDBKeyRange.only(fileId));
            deleteRequest.onsuccess = () => {
                const cursor = deleteRequest.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    // Cursor finished deleting old operations for this file; now save new operations
                    for (const op of operations) {
                        store.put(op);
                    }
                }
            };
            deleteRequest.onerror = () => reject(deleteRequest.error);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async getSyncMetadata(userId: string): Promise<IDBSyncMetadata | undefined> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.SYNC_METADATA, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.SYNC_METADATA).get(userId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async saveSyncMetadata(metadata: IDBSyncMetadata): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.SYNC_METADATA, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.SYNC_METADATA).put(metadata);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async updateLastSyncedAt(userId: string): Promise<void> {
        let metadata = await this.getSyncMetadata(userId);
        if (!metadata) {
            metadata = {
                id: userId,
                lastSyncedAt: Date.now(),
                syncInProgress: false,
                pendingOperationsCount: 0,
            };
        } else {
            metadata.lastSyncedAt = Date.now();
        }
        await this.saveSyncMetadata(metadata);
    }

    async clearAll(): Promise<void> {
        const db = await this.getDB();
        const stores = [
            IDB_CONFIG.STORES.FILES,
            IDB_CONFIG.STORES.OPERATIONS,
            IDB_CONFIG.STORES.SYNC_METADATA,
        ];

        for (const storeName of stores) {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                const request = tx.objectStore(storeName).clear();
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        }
    }

    async getStorageEstimate(): Promise<{ usage: number; quota: number; percentage: number }> {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            const estimate = await navigator.storage.estimate();
            const usage = estimate.usage || 0;
            const quota = estimate.quota || 0;
            return { usage, quota, percentage: quota > 0 ? (usage / quota) * 100 : 0 };
        }
        return { usage: 0, quota: 0, percentage: 0 };
    }

    async isStorageNearlyFull(): Promise<boolean> {
        const { percentage } = await this.getStorageEstimate();
        return percentage > 80;
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.initPromise = null;
        }
    }

    /**
     * Delete the entire IndexedDB database for a user
     */
    async deleteDatabase(): Promise<void> {
        this.close();
        if (!this.userId) return;

        const dbName = getDatabaseName(this.userId);
        if (typeof indexedDB === 'undefined') return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => {
                console.warn(`[IndexedDB] Database ${dbName} deletion was blocked by open connection`);
                resolve();
            };
        });
    }
}

/**
 * Factory for user-scoped IndexedDB managers
 */
export function createIndexedDBManager(userId?: string): IndexedDBManager {
    return new IndexedDBManager(userId);
}

export const indexedDBManager = new IndexedDBManager();
export { IndexedDBManager };

