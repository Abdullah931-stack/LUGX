/**
 * Phase 5 Closure: Encrypted Sync (Matrix #8 Isolation, #9 Diff3+Syntax).
 * Real WebCrypto + fake-indexeddb. Proves non-blocking isolation while
 * locked and Diff3 merge + syntax gate + fresh-IV re-encryption on unlock.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    generateMasterKeyRaw, generateSalt,
    encryptEnvelope, sessionKeyStore, wipeBuffer,
    arrayBufferToBase64, validateMarkdownSyntaxIntegrity,
    conflictResolver, generateEncryptedETagSync,
    MAX_QUARANTINED_CONFLICTS,
    SyncRollback, IndexedDBManager,
    type EncryptedEnvelope,
    type QuarantineDiagnostics,
} from '@/lib/sync';
import { SyncManager } from '@/lib/sync/sync-manager';
const ITER = 5000;
const USER = 'user-enconf-closure-5';
async function makeEnvelope(text: string, key: Uint8Array, fileId: string): Promise<EncryptedEnvelope> {
    const saltB64 = arrayBufferToBase64(await generateSalt(16));
    return encryptEnvelope(text, key, 'master-v1', saltB64, `vault:file:${USER}:${fileId}`, ITER);
}
describe('Phase 5 Closure: Encrypted Conflict Isolation & Merge (Matrix #8/#9)', () => {
    let mgr: SyncManager;
    beforeEach(async () => {
        sessionKeyStore.purgeKeys();
        mgr = new SyncManager();
        await mgr.init({ userId: `${USER}-${Math.random().toString(36).slice(2, 7)}` });
    });
    afterEach(() => { mgr.destroy(); sessionKeyStore.purgeKeys(); vi.restoreAllMocks(); });
    it('#8 locked file isolates as CONFLICT_LOCKED; clean file still pushes', async () => {
        const key = await generateMasterKeyRaw();
        const encId = 'file-locked-enc-1';
        const plainId = 'file-plain-clean-1';
        const base = await makeEnvelope('# Base\n\nA.\n', key, encId);
        const local = await makeEnvelope('# Base\n\nA local.\n', key, encId);
        const remote = await makeEnvelope('# Base\n\nA remote.\n', key, encId);
        expect(sessionKeyStore.isVaultUnlocked()).toBe(false);
        (mgr as unknown as { pendingEncryptedConflicts: Map<string, unknown> }).pendingEncryptedConflicts.set(encId, {
            fileId: encId, remoteEnvelope: remote, baseEnvelope: base,
            localEnvelope: local, remoteEtag: 'etag-remote-412', detectedAt: new Date(),
        });
        expect(mgr.isEncryptedConflictLocked(encId)).toBe(true);
        expect(mgr.isEncryptedConflictLocked(plainId)).toBe(false);
        expect(mgr.getPendingEncryptedConflicts().map((c) => c.fileId)).toContain(encId);
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ etag: 'etag-plain-2', version: 2 }) });
        (global as unknown as { fetch: unknown }).fetch = fetchMock;
        await (mgr as unknown as { idb: { saveFile: (f: unknown) => Promise<void> } }).idb.saveFile({
            id: plainId, title: 'plain', parentFolderId: null, isFolder: false,
            content: '# Plain clean', etag: 'etag-plain-1', version: 1,
            isDirty: true, isEncrypted: false, lastModified: Date.now(), lastSyncedAt: 0,
        });
        const res = await mgr.syncFile(plainId);
        expect(res.success).toBe(true);
        expect(mgr.isEncryptedConflictLocked(encId)).toBe(true);
        wipeBuffer(key);
    });
    it('#9 unlock resolves Diff3 merge, passes syntax, re-encrypts with fresh IV + ETag', async () => {
        const key = await generateMasterKeyRaw();
        const encId = 'file-merge-enc-1';
        const mgrUser = mgr.getUserId() ?? USER;
        const aad = `vault:file:${mgrUser}:${encId}`;
        const baseText = '# Doc\n\nSection 1 original\n\nSection 2 original\n';
        const localText = '# Doc\n\nSection 1 local edit\n\nSection 2 original\n';
        const remoteText = '# Doc\n\nSection 1 original\n\nSection 2 remote edit\n';
        const saltOf = async () => arrayBufferToBase64(await generateSalt(16));
        const base = await encryptEnvelope(baseText, key, 'master-v1', await saltOf(), aad, ITER);
        const local = await encryptEnvelope(localText, key, 'master-v1', await saltOf(), aad, ITER);
        const remote = await encryptEnvelope(remoteText, key, 'master-v1', await saltOf(), aad, ITER);
        sessionKeyStore.storeMasterKeyRaw(key, 3600);
        (mgr as unknown as { pendingEncryptedConflicts: Map<string, unknown> }).pendingEncryptedConflicts.set(encId, {
            fileId: encId, remoteEnvelope: remote, baseEnvelope: base,
            localEnvelope: local, remoteEtag: 'etag-remote-412', detectedAt: new Date(),
        });
        await (mgr as unknown as { idb: { saveFile: (f: unknown) => Promise<void> } }).idb.saveFile({
            id: encId, title: 'enc', parentFolderId: null, isFolder: false,
            content: local.ciphertext, etag: 'etag-old', version: 1,
            isDirty: true, isEncrypted: true,
            encryptionMetadata: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', salt: local.salt, iv: local.iv, kdfIterations: ITER },
            lastModified: Date.now(), lastSyncedAt: 0,
        });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ etag: 'etag-merged-2', version: 2 }) });
        (global as unknown as { fetch: unknown }).fetch = fetchMock;
        const res = await mgr.resolvePendingEncryptedConflict(encId);
        expect(res.success).toBe(true);
        expect(res.action).toBe('pushed');
        expect(mgr.isEncryptedConflictLocked(encId)).toBe(false);
        const putBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(putBody.isEncrypted).toBe(true);
        expect(putBody.encryptionMetadata.iv).toBeTruthy();
        expect(putBody.encryptionMetadata.iv).not.toBe(local.iv);
        expect(putBody.encryptionMetadata.iv).not.toBe(remote.iv);
        expect(generateEncryptedETagSync({ ...remote, ciphertext: putBody.content })).toMatch(/^[a-f0-9]{32}$/);
        const syntax = validateMarkdownSyntaxIntegrity(
            conflictResolver.attemptThreeWayMerge({ base: { content: baseText }, local: { content: localText }, remote: { content: remoteText } }).content ?? ''
        );
        expect(syntax.isValid).toBe(true);
    });
    it('#9 corrupt merge output falls back to CONFLICT_MANUAL, never pushes', async () => {
        const key = await generateMasterKeyRaw();
        const encId = 'file-manual-enc-1';
        const mgrUser = mgr.getUserId() ?? USER;
        const aad = `vault:file:${mgrUser}:${encId}`;
        const corruptedLocal = '# Doc\n\n```ts\nunclosed fence\n';
        const saltOf = async () => arrayBufferToBase64(await generateSalt(16));
        const base = await encryptEnvelope('# Doc\n\nok\n', key, 'master-v1', await saltOf(), aad, ITER);
        const local = await encryptEnvelope(corruptedLocal, key, 'master-v1', await saltOf(), aad, ITER);
        const remote = await encryptEnvelope('# Doc\n\nok remote\n', key, 'master-v1', await saltOf(), aad, ITER);
        sessionKeyStore.storeMasterKeyRaw(key, 3600);
        (mgr as unknown as { pendingEncryptedConflicts: Map<string, unknown> }).pendingEncryptedConflicts.set(encId, {
            fileId: encId, remoteEnvelope: remote, baseEnvelope: base,
            localEnvelope: local, remoteEtag: 'etag-remote-x', detectedAt: new Date(),
        });
        await (mgr as unknown as { idb: { saveFile: (f: unknown) => Promise<void> } }).idb.saveFile({
            id: encId, title: 'enc', parentFolderId: null, isFolder: false,
            content: local.ciphertext, etag: 'etag-old', version: 1,
            isDirty: true, isEncrypted: true,
            encryptionMetadata: { version: 1, algorithm: 'AES-GCM-256', keyId: 'master-v1', salt: local.salt, iv: local.iv, kdfIterations: ITER },
            lastModified: Date.now(), lastSyncedAt: 0,
        });
        const fetchMock = vi.fn();
        (global as unknown as { fetch: unknown }).fetch = fetchMock;
        const res = await mgr.resolvePendingEncryptedConflict(encId);
        expect(res.success).toBe(false);
        expect(res.error).toBe('CONFLICT_MANUAL');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(validateMarkdownSyntaxIntegrity(corruptedLocal).isValid).toBe(false);
        wipeBuffer(key);
    });

    describe('Phase 23: Encrypted Conflict Quarantine Governance & Backpressure', () => {
        it('returns zero defaults when quarantine is empty', () => {
            const diag = mgr.getQuarantineDiagnostics();
            expect(diag).toEqual({
                totalQuarantined: 0,
                staleCount: 0,
                oldestQuarantinedAt: null,
                newestQuarantinedAt: null,
                isAtCapacity: false,
            });
        });

        it('accurately calculates total, staleCount (> 24h), and timestamps', () => {
            const now = Date.now();
            const staleTime1 = new Date(now - 30 * 60 * 60 * 1000); // 30h ago (oldest)
            const staleTime2 = new Date(now - 25 * 60 * 60 * 1000); // 25h ago
            const freshTime = new Date(now - 2 * 60 * 60 * 1000);   // 2h ago (newest)

            const dummyEnvelope: EncryptedEnvelope = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                iv: 'iv',
                salt: 'salt',
                ciphertext: 'ciphertext',
                kdfIterations: 600000,
            };

            mgr.quarantineEncryptedConflict({
                fileId: 'file-stale-1',
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-1',
                detectedAt: staleTime1,
            });
            mgr.quarantineEncryptedConflict({
                fileId: 'file-stale-2',
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-2',
                detectedAt: staleTime2,
            });
            mgr.quarantineEncryptedConflict({
                fileId: 'file-fresh-1',
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-3',
                detectedAt: freshTime,
            });

            const diag: QuarantineDiagnostics = mgr.getQuarantineDiagnostics();
            expect(diag.totalQuarantined).toBe(3);
            expect(diag.staleCount).toBe(2);
            expect(diag.oldestQuarantinedAt).toBe(staleTime1.getTime());
            expect(diag.newestQuarantinedAt).toBe(freshTime.getTime());
            expect(diag.isAtCapacity).toBe(false);
        });

        it('enforces MAX_QUARANTINED_CONFLICTS capacity by evicting oldest entry', () => {
            const baseTime = Date.now() - 200000;
            const dummyEnvelope: EncryptedEnvelope = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                iv: 'iv',
                salt: 'salt',
                ciphertext: 'ct',
                kdfIterations: 600000,
            };

            // Fill quarantine up to MAX_QUARANTINED_CONFLICTS (100)
            for (let i = 0; i < MAX_QUARANTINED_CONFLICTS; i++) {
                mgr.quarantineEncryptedConflict({
                    fileId: `file-quarantine-${i}`,
                    remoteEnvelope: dummyEnvelope,
                    baseEnvelope: dummyEnvelope,
                    localEnvelope: dummyEnvelope,
                    remoteEtag: `etag-${i}`,
                    detectedAt: new Date(baseTime + i * 1000), // file-quarantine-0 is oldest
                });
            }

            const diagBefore = mgr.getQuarantineDiagnostics();
            expect(diagBefore.totalQuarantined).toBe(MAX_QUARANTINED_CONFLICTS);
            expect(diagBefore.isAtCapacity).toBe(true);
            expect(mgr.isEncryptedConflictLocked('file-quarantine-0')).toBe(true);

            // Adding 101st conflict triggers capacity eviction
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mgr.quarantineEncryptedConflict({
                fileId: 'file-quarantine-newest',
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-newest',
                detectedAt: new Date(baseTime + (MAX_QUARANTINED_CONFLICTS + 10) * 1000),
            });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining(`Quarantine at capacity (${MAX_QUARANTINED_CONFLICTS}), evicting oldest: file-quarantine-0`)
            );
            expect(mgr.isEncryptedConflictLocked('file-quarantine-0')).toBe(false);
            expect(mgr.isEncryptedConflictLocked('file-quarantine-newest')).toBe(true);
            expect(mgr.getQuarantineDiagnostics().totalQuarantined).toBe(MAX_QUARANTINED_CONFLICTS);
            expect(mgr.getQuarantineDiagnostics().isAtCapacity).toBe(true);
            warnSpy.mockRestore();
        });

        it('does not evict existing conflicts when an already quarantined file is updated at capacity', () => {
            const baseTime = Date.now() - 200000;
            const dummyEnvelope: EncryptedEnvelope = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                iv: 'iv',
                salt: 'salt',
                ciphertext: 'ct',
                kdfIterations: 600000,
            };

            for (let i = 0; i < MAX_QUARANTINED_CONFLICTS; i++) {
                mgr.quarantineEncryptedConflict({
                    fileId: `file-cap-${i}`,
                    remoteEnvelope: dummyEnvelope,
                    baseEnvelope: dummyEnvelope,
                    localEnvelope: dummyEnvelope,
                    remoteEtag: `etag-${i}`,
                    detectedAt: new Date(baseTime + i * 1000),
                });
            }

            expect(mgr.getQuarantineDiagnostics().totalQuarantined).toBe(MAX_QUARANTINED_CONFLICTS);
            expect(mgr.isEncryptedConflictLocked('file-cap-0')).toBe(true);

            // Re-quarantine file-cap-50 (already present)
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            mgr.quarantineEncryptedConflict({
                fileId: 'file-cap-50',
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-updated',
                detectedAt: new Date(),
            });

            // file-cap-0 should NOT have been evicted
            expect(warnSpy).not.toHaveBeenCalled();
            expect(mgr.isEncryptedConflictLocked('file-cap-0')).toBe(true);
            expect(mgr.isEncryptedConflictLocked('file-cap-50')).toBe(true);
            expect(mgr.getQuarantineDiagnostics().totalQuarantined).toBe(MAX_QUARANTINED_CONFLICTS);
            warnSpy.mockRestore();
        });

        it('discards conflict safely by purging memory, rollback checkpoints, and marking IDB operations discarded', async () => {
            const discardFileId = 'file-discard-test-1';
            const dummyEnvelope: EncryptedEnvelope = {
                version: 1,
                algorithm: 'AES-GCM-256',
                keyId: 'master-v1',
                iv: 'iv',
                salt: 'salt',
                ciphertext: 'ct',
                kdfIterations: 600000,
            };

            const idb = (mgr as unknown as { idb: IndexedDBManager }).idb;
            const rollback = (mgr as unknown as { rollback: SyncRollback }).rollback;

            // 1. Setup file and checkpoint
            await idb.saveFile({
                id: discardFileId,
                title: 'discard test file',
                parentFolderId: null,
                isFolder: false,
                content: 'original content',
                etag: 'etag-orig',
                version: 1,
                isDirty: true,
                isEncrypted: true,
                lastModified: Date.now(),
                lastSyncedAt: 0,
            });
            await rollback.createCheckpoint(discardFileId, 'pre_sync');
            expect(rollback.getFileCheckpoints(discardFileId).length).toBeGreaterThan(0);

            // 2. Setup IDB operations for this file
            await idb.addOperation({
                id: 'op-discard-conflict',
                operationId: 'op-discard-conflict',
                fileId: discardFileId,
                status: 'conflict',
                operationType: 'update',
                position: 0,
                content: 'conflict edit',
                timestamp: Date.now(),
                synced: false,
            });
            await idb.addOperation({
                id: 'op-discard-queued',
                operationId: 'op-discard-queued',
                fileId: discardFileId,
                status: 'queued',
                operationType: 'update',
                position: 0,
                content: 'queued edit',
                timestamp: Date.now(),
                synced: false,
            });

            // 3. Add to quarantine
            mgr.quarantineEncryptedConflict({
                fileId: discardFileId,
                remoteEnvelope: dummyEnvelope,
                baseEnvelope: dummyEnvelope,
                localEnvelope: dummyEnvelope,
                remoteEtag: 'etag-remote-disc',
                detectedAt: new Date(),
            });
            expect(mgr.isEncryptedConflictLocked(discardFileId)).toBe(true);

            // 4. Discard conflict
            await mgr.discardPendingEncryptedConflict(discardFileId);

            // 5. Verify multi-tier cleanup
            expect(mgr.isEncryptedConflictLocked(discardFileId)).toBe(false);
            expect(rollback.getFileCheckpoints(discardFileId).length).toBe(0);

            const opConflict = await idb.getOperation('op-discard-conflict');
            const opQueued = await idb.getOperation('op-discard-queued');
            expect(opConflict?.status).toBe('discarded');
            expect(opQueued?.status).toBe('discarded');

            // 6. Graceful handling of non-existent conflict discard
            await expect(mgr.discardPendingEncryptedConflict('file-never-existed')).resolves.toBeUndefined();
        });
    });
});

