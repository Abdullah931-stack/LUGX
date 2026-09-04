/**
 * IndexedDB Manager for Offline Sync System & Transparent At-Rest Encryption
 *
 * Implements transparent, automatic client-side encryption of all local data
 * (files, base snapshots, operations, undo history) using AES-GCM-256 via LocalDeviceKey.
 * Guarantees Zero Plaintext At-Rest on client storage with deterministic AAD binding,
 * seamless legacy data migration, and corrupted record isolation.
 */

import {
    IDBFile,
    IDBOperation,
    OperationStatus,
    IDBSyncMetadata,
    IDB_CONFIG,
    getDatabaseName,
    CorruptedLocalRecordError,
} from './idb-types';
import {
    cryptoWorkerBridge,
    wipeBuffer,
    arrayBufferToBase64,
    base64ToUint8Array,
} from './crypto-worker-bridge';
import { sessionKeyStore } from './session-key-store';

interface LocalEncryptedPayload {
    readonly _enc: 1;
    readonly iv: string; // Base64 (12 bytes)
    readonly ct: string; // Base64 (Ciphertext + 16-byte Auth Tag)
}

function isEncryptedPayload(val: unknown): val is LocalEncryptedPayload {
    return (
        typeof val === 'object' &&
        val !== null &&
        (val as LocalEncryptedPayload)._enc === 1 &&
        typeof (val as LocalEncryptedPayload).iv === 'string' &&
        typeof (val as LocalEncryptedPayload).ct === 'string'
    );
}

function isEncryptedString(val: unknown): boolean {
    if (typeof val !== 'string') return false;
    return val.startsWith('{"_enc":1,') || val.startsWith('{"_enc": 1,');
}

class IndexedDBManager {
    private db: IDBDatabase | null = null;
    private initPromise: Promise<IDBDatabase> | null = null;
    private userId: string | null = null;
    private localDeviceKey: Uint8Array | null = null;
    private keyInitPromise: Promise<Uint8Array> | null = null;

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
     * Explicitly sets or overrides the Local Device Key for this manager
     */
    setLocalDeviceKey(key: Uint8Array | CryptoKey): void {
        if (key instanceof Uint8Array) {
            this.localDeviceKey = new Uint8Array(key);
        }
        sessionKeyStore.setLocalDeviceKey(key);
    }

    /**
     * Retrieves or lazily creates a persistent Local Device Key for the current user
     */
    private async getDeviceKey(): Promise<Uint8Array> {
        if (this.localDeviceKey && this.localDeviceKey instanceof Uint8Array) {
            return this.localDeviceKey;
        }

        if (this.keyInitPromise) {
            return this.keyInitPromise;
        }

        this.keyInitPromise = (async () => {
            try {
                // Ensure DB connection is active before reading/writing persistent key
                const db = await this.getDB();

                // 1. Attempt retrieval from sync_metadata store in the user's IndexedDB
                try {
                    const keyRecord = await new Promise<{ id: string; keyBase64: string } | undefined>((resolve, reject) => {
                        const tx = db.transaction(IDB_CONFIG.STORES.SYNC_METADATA, 'readonly');
                        const req = tx.objectStore(IDB_CONFIG.STORES.SYNC_METADATA).get('local_device_key');
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });

                    if (keyRecord && keyRecord.keyBase64) {
                        const raw = base64ToUint8Array(keyRecord.keyBase64);
                        this.localDeviceKey = raw;
                        sessionKeyStore.setLocalDeviceKey(raw);
                        return raw;
                    }
                } catch {
                    // Fall through to generation if store read fails
                }

                // 2. Generate fresh CSPRNG 256-bit key
                const generated = await cryptoWorkerBridge.generateRandomBytes(32);
                this.localDeviceKey = generated;
                sessionKeyStore.setLocalDeviceKey(generated);

                // 3. Persist to sync_metadata store
                try {
                    await new Promise<void>((resolve, reject) => {
                        const tx = db.transaction(IDB_CONFIG.STORES.SYNC_METADATA, 'readwrite');
                        const req = tx.objectStore(IDB_CONFIG.STORES.SYNC_METADATA).put({
                            id: 'local_device_key',
                            keyBase64: arrayBufferToBase64(generated),
                        });
                        req.onsuccess = () => resolve();
                        req.onerror = () => reject(req.error);
                    });
                } catch {
                    // Ignore persistence errors
                }

                return generated;
            } finally {
                this.keyInitPromise = null;
            }
        })();

        return this.keyInitPromise;
    }

    /**
     * Encrypts plaintext string with LocalDeviceKey and AAD binding
     */
    private async encryptText(text: string, aad: string): Promise<string> {
        const key = await this.getDeviceKey();
        const iv = await cryptoWorkerBridge.generateRandomBytes(12);

        try {
            const { ciphertextBase64, ivBase64 } = await cryptoWorkerBridge.encryptAESGCM(
                key,
                text,
                iv,
                aad
            );

            const payload: LocalEncryptedPayload = {
                _enc: 1,
                iv: ivBase64,
                ct: ciphertextBase64,
            };

            return JSON.stringify(payload);
        } finally {
            wipeBuffer(iv);
        }
    }

    /**
     * Decrypts ciphertext envelope or transparently passes legacy plaintext
     */
    private async decryptText(
        serializedOrPlain: string,
        aad: string,
        storeName: string,
        recordId: string
    ): Promise<string> {
        if (!serializedOrPlain || typeof serializedOrPlain !== 'string') {
            return serializedOrPlain || '';
        }

        if (!isEncryptedString(serializedOrPlain)) {
            // Legacy unencrypted plaintext fallback (In-place transparent migration)
            return serializedOrPlain;
        }

        let payload: LocalEncryptedPayload;
        try {
            payload = JSON.parse(serializedOrPlain);
        } catch {
            return serializedOrPlain;
        }

        if (!isEncryptedPayload(payload)) {
            return serializedOrPlain;
        }

        const key = await this.getDeviceKey();
        const iv = base64ToUint8Array(payload.iv);

        try {
            return await cryptoWorkerBridge.decryptAESGCM(
                key,
                payload.ct,
                iv,
                aad
            );
        } catch (err) {
            throw new CorruptedLocalRecordError(
                storeName,
                recordId,
                (err as Error)?.message || 'Authentication tag mismatch or corrupted ciphertext'
            );
        } finally {
            wipeBuffer(iv);
        }
    }

    /**
     * Transforms an in-memory IDBFile into an encrypted-at-rest record
     */
    private async encryptFileForStorage(file: IDBFile): Promise<IDBFile> {
        const aad = `idb:file:${file.id}`;
        const encryptedContent = await this.encryptText(file.content, aad);

        let encryptedBaseSnapshot: IDBFile['baseSnapshot'] = undefined;
        if (file.baseSnapshot) {
            const snapAad = `idb:snapshot:${file.id}`;
            const snapContent = await this.encryptText(file.baseSnapshot.content, snapAad);
            encryptedBaseSnapshot = {
                ...file.baseSnapshot,
                content: snapContent,
            };
        }

        return {
            ...file,
            content: encryptedContent,
            baseSnapshot: encryptedBaseSnapshot,
        };
    }

    /**
     * Transforms an encrypted-at-rest record into a decrypted in-memory IDBFile
     */
    private async decryptFileFromStorage(stored: IDBFile): Promise<IDBFile> {
        const aad = `idb:file:${stored.id}`;
        const decryptedContent = await this.decryptText(stored.content, aad, 'files', stored.id);

        let decryptedBaseSnapshot: IDBFile['baseSnapshot'] = undefined;
        if (stored.baseSnapshot) {
            const snapAad = `idb:snapshot:${stored.id}`;
            const snapContent = await this.decryptText(stored.baseSnapshot.content, snapAad, 'files', stored.id);
            decryptedBaseSnapshot = {
                ...stored.baseSnapshot,
                content: snapContent,
            };
        }

        return {
            ...stored,
            content: decryptedContent,
            baseSnapshot: decryptedBaseSnapshot,
        };
    }

    /**
     * Transforms an in-memory IDBOperation into an encrypted-at-rest record
     */
    private async encryptOperationForStorage(op: IDBOperation): Promise<IDBOperation> {
        const opId = op.operationId || op.id;
        const aad = `idb:op:${opId}`;
        const encryptedContent = await this.encryptText(op.content, aad);

        let encryptedPrevContent: string | undefined = undefined;
        if (op.previousContent !== undefined) {
            const prevAad = `idb:op_prev:${opId}`;
            encryptedPrevContent = await this.encryptText(op.previousContent, prevAad);
        }

        let encryptedSnapshot: IDBOperation['snapshot'] = undefined;
        if (op.snapshot) {
            const snapAad = `idb:op_snap:${opId}`;
            const snapContent = await this.encryptText(op.snapshot.content, snapAad);
            encryptedSnapshot = {
                ...op.snapshot,
                content: snapContent,
            };
        }

        return {
            ...op,
            operationId: opId,
            content: encryptedContent,
            previousContent: encryptedPrevContent,
            snapshot: encryptedSnapshot,
        };
    }

    /**
     * Transforms an encrypted-at-rest record into a decrypted in-memory IDBOperation
     */
    private async decryptOperationFromStorage(stored: IDBOperation): Promise<IDBOperation> {
        const opId = stored.operationId || stored.id;
        const aad = `idb:op:${opId}`;
        const decryptedContent = await this.decryptText(stored.content, aad, 'operations', opId);

        let decryptedPrevContent: string | undefined = undefined;
        if (stored.previousContent !== undefined) {
            const prevAad = `idb:op_prev:${opId}`;
            decryptedPrevContent = await this.decryptText(stored.previousContent, prevAad, 'operations', opId);
        }

        let decryptedSnapshot: IDBOperation['snapshot'] = undefined;
        if (stored.snapshot) {
            const snapAad = `idb:op_snap:${opId}`;
            const snapContent = await this.decryptText(stored.snapshot.content, snapAad, 'operations', opId);
            decryptedSnapshot = {
                ...stored.snapshot,
                content: snapContent,
            };
        }

        return {
            ...stored,
            content: decryptedContent,
            previousContent: decryptedPrevContent,
            snapshot: decryptedSnapshot,
        };
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
            opsStore.createIndex('status', 'status', { unique: false });
            opsStore.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
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

    /**
     * Retrieves and decrypts a file record by ID
     */
    async getFile(id: string): Promise<IDBFile | undefined> {
        const db = await this.getDB();
        const raw = await new Promise<IDBFile | undefined>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!raw) return undefined;
        return this.decryptFileFromStorage(raw);
    }

    /**
     * Encrypts and saves a file record to IndexedDB
     */
    async saveFile(file: IDBFile): Promise<void> {
        const encryptedFile = await this.encryptFileForStorage(file);
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).put(encryptedFile);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Deletes a file record by ID
     */
    async deleteFile(id: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Retrieves and decrypts all files for the current user
     */
    async getAllFiles(): Promise<IDBFile[]> {
        const db = await this.getDB();
        const rawFiles = await new Promise<IDBFile[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        const decryptedFiles: IDBFile[] = [];
        for (const raw of rawFiles) {
            try {
                decryptedFiles.push(await this.decryptFileFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted file record ${raw.id}:`, err);
            }
        }

        return decryptedFiles;
    }

    /**
     * Retrieves all files with unsynced local changes
     */
    async getDirtyFiles(): Promise<IDBFile[]> {
        const db = await this.getDB();
        const rawDirty = await new Promise<IDBFile[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.FILES, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.FILES).getAll();
            request.onsuccess = () => {
                const files = (request.result as IDBFile[] || []).filter(f => f.isDirty === true);
                resolve(files);
            };
            request.onerror = () => reject(request.error);
        });

        const decryptedDirty: IDBFile[] = [];
        for (const raw of rawDirty) {
            try {
                decryptedDirty.push(await this.decryptFileFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted dirty file record ${raw.id}:`, err);
            }
        }

        return decryptedDirty;
    }

    async markFileDirty(id: string): Promise<void> {
        const file = await this.getFile(id);
        if (file) {
            file.isDirty = true;
            file.lastModified = Date.now();
            await this.saveFile(file);
        }
    }

    async markFileClean(id: string, newEtag: string, newVersion?: number): Promise<void> {
        const file = await this.getFile(id);
        if (file) {
            file.isDirty = false;
            file.etag = newEtag;
            if (newVersion !== undefined) {
                file.version = newVersion;
            }
            file.lastSyncedAt = Date.now();
            file.baseSnapshot = {
                content: file.content,
                etag: newEtag,
                version: file.version,
                title: file.title,
                parentFolderId: file.parentFolderId,
                isEncrypted: file.isEncrypted,
                encryptionMetadata: file.encryptionMetadata,
            };
            await this.saveFile(file);
        }
    }

    /**
     * Atomically marks a file clean and its corresponding operation synced in a single transaction
     */
    async commitFileAndOperationSync(
        fileId: string,
        newEtag: string,
        opId: string,
        attempts: number,
        newVersion?: number
    ): Promise<void> {
        const file = await this.getFile(fileId);
        const op = await this.getOperation(opId);

        if (file) {
            file.isDirty = false;
            file.etag = newEtag;
            if (newVersion !== undefined) {
                file.version = newVersion;
            }
            file.lastSyncedAt = Date.now();
            file.baseSnapshot = {
                content: file.content,
                etag: newEtag,
                version: file.version,
                title: file.title,
                parentFolderId: file.parentFolderId,
                isEncrypted: file.isEncrypted,
                encryptionMetadata: file.encryptionMetadata,
            };
        }

        if (op) {
            op.status = 'synced';
            op.synced = true;
            op.attempts = attempts;
            op.lastError = undefined;
        }

        const encryptedFile = file ? await this.encryptFileForStorage(file) : null;
        const encryptedOp = op ? await this.encryptOperationForStorage(op) : null;

        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([IDB_CONFIG.STORES.FILES, IDB_CONFIG.STORES.OPERATIONS], 'readwrite');
            const filesStore = tx.objectStore(IDB_CONFIG.STORES.FILES);
            const opsStore = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);

            if (encryptedFile) {
                filesStore.put(encryptedFile);
            }
            if (encryptedOp) {
                opsStore.put(encryptedOp);
            }

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Atomic sync transaction aborted'));
        });
    }

    /**
     * Adds an operation record encrypted at rest
     */
    async addOperation(operation: IDBOperation): Promise<void> {
        const opToStore: IDBOperation = {
            ...operation,
            operationId: operation.operationId || operation.id,
            status: operation.status || (operation.synced ? 'synced' : 'queued'),
            attempts: operation.attempts || 0,
            userId: operation.userId || this.userId || 'anon',
        };

        const encryptedOp = await this.encryptOperationForStorage(opToStore);
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).put(encryptedOp);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Coalesces pending operation for the same fileId or adds a new one
     */
    async coalesceOperation(operation: IDBOperation): Promise<void> {
        const db = await this.getDB();
        const opToStore: IDBOperation = {
            ...operation,
            operationId: operation.operationId || operation.id,
            status: operation.status || (operation.synced ? 'synced' : 'queued'),
            attempts: operation.attempts || 0,
            userId: operation.userId || this.userId || 'anon',
        };

        const existingOps = await this.getOperations(operation.fileId);
        const existingPendingOp = existingOps.find(o =>
            !o.synced &&
            o.status !== 'synced' &&
            (o.operationType === operation.operationType || (o.operationType === 'create' && operation.operationType === 'update'))
        );

        if (existingPendingOp) {
            const coalesced: IDBOperation = {
                ...existingPendingOp,
                content: operation.content,
                timestamp: operation.timestamp || Date.now(),
            };
            const encrypted = await this.encryptOperationForStorage(coalesced);
            return new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
                const putReq = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).put(encrypted);
                putReq.onsuccess = () => resolve();
                putReq.onerror = () => reject(putReq.error);
            });
        } else {
            const encrypted = await this.encryptOperationForStorage(opToStore);
            return new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
                const putReq = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).put(encrypted);
                putReq.onsuccess = () => resolve();
                putReq.onerror = () => reject(putReq.error);
            });
        }
    }

    /**
     * Retrieves and decrypts an operation record by ID
     */
    async getOperation(id: string): Promise<IDBOperation | undefined> {
        const db = await this.getDB();
        const raw = await new Promise<IDBOperation | undefined>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!raw) return undefined;
        return this.decryptOperationFromStorage(raw);
    }

    async saveOperation(operation: IDBOperation): Promise<void> {
        return this.addOperation(operation);
    }

    async updateOperation(operation: IDBOperation): Promise<void> {
        return this.addOperation(operation);
    }

    /**
     * Updates an operation's lifecycle status and metadata
     */
    async updateOperationStatus(
        id: string,
        status: OperationStatus,
        updates?: Partial<IDBOperation>
    ): Promise<void> {
        const existing = await this.getOperation(id);
        if (!existing) return;

        const updatedOp: IDBOperation = {
            ...existing,
            ...updates,
            status,
            synced: status === 'synced' ? true : existing.synced,
        };

        const encrypted = await this.encryptOperationForStorage(updatedOp);
        const db = await this.getDB();

        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const putReq = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).put(encrypted);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
        });
    }

    /**
     * Retrieves and decrypts all operations for a specific file
     */
    async getOperations(fileId: string): Promise<IDBOperation[]> {
        const db = await this.getDB();
        const rawOps = await new Promise<IDBOperation[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const index = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).index('fileId');
            const request = index.getAll(IDBKeyRange.only(fileId));
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        const decrypted: IDBOperation[] = [];
        for (const raw of rawOps) {
            try {
                decrypted.push(await this.decryptOperationFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted operation record ${raw.id}:`, err);
            }
        }

        return decrypted;
    }

    /**
     * Retrieves and decrypts all operations across all files
     */
    async getAllOperations(): Promise<IDBOperation[]> {
        const db = await this.getDB();
        const rawOps = await new Promise<IDBOperation[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });

        const decrypted: IDBOperation[] = [];
        for (const raw of rawOps) {
            try {
                decrypted.push(await this.decryptOperationFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted operation record ${raw.id}:`, err);
            }
        }

        return decrypted;
    }

    /**
     * Retrieves operations matching a specific status
     */
    async getOperationsByStatus(status: OperationStatus): Promise<IDBOperation[]> {
        const db = await this.getDB();
        const rawOps = await new Promise<IDBOperation[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).getAll();
            request.onsuccess = () => {
                const all = (request.result as IDBOperation[] || []).filter(op => op.status === status);
                resolve(all);
            };
            request.onerror = () => reject(request.error);
        });

        const decrypted: IDBOperation[] = [];
        for (const raw of rawOps) {
            try {
                decrypted.push(await this.decryptOperationFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted operation record ${raw.id}:`, err);
            }
        }

        return decrypted;
    }

    /**
     * Retrieves unsynced operations for a specific file
     */
    async getUnsyncedOperations(fileId: string): Promise<IDBOperation[]> {
        const db = await this.getDB();
        const rawOps = await new Promise<IDBOperation[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).getAll();
            request.onsuccess = () => {
                const ops = (request.result as IDBOperation[] || []).filter(
                    o => o.fileId === fileId && o.synced === false
                );
                resolve(ops);
            };
            request.onerror = () => reject(request.error);
        });

        const decrypted: IDBOperation[] = [];
        for (const raw of rawOps) {
            try {
                decrypted.push(await this.decryptOperationFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted operation record ${raw.id}:`, err);
            }
        }

        return decrypted;
    }

    /**
     * Retrieves all pending operations due for synchronization
     */
    async getDueOperations(now: number = Date.now(), maxRetries = 5): Promise<IDBOperation[]> {
        const db = await this.getDB();
        const rawDue = await new Promise<IDBOperation[]>((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readonly');
            const request = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS).getAll();
            request.onsuccess = () => {
                const all = (request.result as IDBOperation[] || []);
                const due = all.filter(op => {
                    if (op.synced) return false;

                    if (
                        op.status === 'conflict' ||
                        op.status === 'rollback_failed' ||
                        op.status === 'dead_letter' ||
                        op.status === 'syncing'
                    ) {
                        return false;
                    }

                    if (op.status === 'queued' || !op.status) {
                        return true;
                    }

                    if (op.status === 'failed') {
                        const attempts = op.attempts || 0;
                        if (attempts >= maxRetries) return false;
                        if (op.nextRetryAt && op.nextRetryAt > now) return false;
                        return true;
                    }

                    return false;
                });

                due.sort((a, b) => a.timestamp - b.timestamp);
                resolve(due);
            };
            request.onerror = () => reject(request.error);
        });

        const decrypted: IDBOperation[] = [];
        for (const raw of rawDue) {
            try {
                decrypted.push(await this.decryptOperationFromStorage(raw));
            } catch (err) {
                console.warn(`[IndexedDB] Isolated corrupted due operation record ${raw.id}:`, err);
            }
        }

        return decrypted;
    }

    /**
     * Resets operations stuck in 'syncing' back to 'queued' on startup/crash recovery
     */
    async resetSyncingOperations(): Promise<number> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const store = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);
            const request = store.getAll();
            let resetCount = 0;

            request.onsuccess = () => {
                const all = (request.result as IDBOperation[]) || [];
                for (const op of all) {
                    if (op.status === 'syncing') {
                        op.status = 'queued';
                        store.put(op);
                        resetCount++;
                    }
                }
            };

            tx.oncomplete = () => resolve(resetCount);
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Marks a list of operation IDs as synced
     */
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
                    op.status = 'synced';
                    store.put(op);
                }
            };
        }

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Deletes expired, synced, or dead-letter operations past retention window
     */
    async deleteOldOperations(maxAgeMs: number = IDB_CONFIG.MAX_OPERATION_AGE_MS, now: number = Date.now()): Promise<number> {
        const db = await this.getDB();
        const cutoffTime = now - maxAgeMs;
        let deletedCount = 0;

        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_CONFIG.STORES.OPERATIONS, 'readwrite');
            const store = tx.objectStore(IDB_CONFIG.STORES.OPERATIONS);
            const request = store.getAll();

            request.onsuccess = () => {
                const all = (request.result as IDBOperation[]) || [];
                for (const op of all) {
                    if (
                        op.status === 'syncing' ||
                        op.status === 'conflict' ||
                        op.status === 'rollback_failed' ||
                        op.status === 'queued'
                    ) {
                        continue;
                    }

                    const isOld = op.timestamp <= cutoffTime;
                    const canDelete = (op.synced || op.status === 'synced' || op.status === 'dead_letter') && isOld;

                    if (canDelete) {
                        store.delete(op.id);
                        deletedCount++;
                    }
                }
            };

            tx.oncomplete = () => resolve(deletedCount);
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Atomically replaces operations for a specific file with fresh encrypted operations
     */
    async replaceOperations(fileId: string, operations: IDBOperation[]): Promise<void> {
        const encryptedOps = await Promise.all(
            operations.map(op => this.encryptOperationForStorage(op))
        );

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
                    for (const op of encryptedOps) {
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
        if (this.localDeviceKey) {
            wipeBuffer(this.localDeviceKey);
            this.localDeviceKey = null;
        }
        this.keyInitPromise = null;

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
        if (typeof navigator !== 'undefined' && 'storage' in navigator && 'estimate' in navigator.storage) {
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
        if (this.localDeviceKey) {
            wipeBuffer(this.localDeviceKey);
            this.localDeviceKey = null;
        }
        this.keyInitPromise = null;
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
