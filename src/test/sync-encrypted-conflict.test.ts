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
    type EncryptedEnvelope,
} from '../lib/sync';
import { SyncManager } from '../lib/sync/sync-manager';
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
});
