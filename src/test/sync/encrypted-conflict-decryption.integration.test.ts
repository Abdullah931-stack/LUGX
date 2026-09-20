/**
 * @vitest-environment jsdom
 *
 * Integration Tests: Encrypted Conflict Decryption & Inbound Gateway
 *
 * Validates:
 * 1. Fast-forward remote encrypted update is transparently decrypted and applied as plaintext to editor.
 * 2. Concurrent edit resulting in 412 Conflict populates activeConflict with DECRYPTED plaintext (not raw Base64 ciphertext).
 * 3. Conflict resolution ('server', 'merge', 'local') sets plaintext into CodeMirror and re-encrypts with fresh IV for server persistence.
 * 4. Inbound encrypted updates while vault is locked are quarantined without polluting editor with ciphertext.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import * as fileOps from "@/server/actions/file-ops";
import { sessionKeyStore } from "@/lib/sync/session-key-store";
import { SyncCryptoGateway } from "@/lib/sync/sync-crypto-gateway";

vi.mock("@/server/actions/file-ops", () => ({
    getFile: vi.fn(),
    updateFileContent: vi.fn(),
    toggleFileEncryption: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
}));

vi.mock("@/server/actions/ai-commit", () => ({
    commitAIFileOperation: vi.fn(),
    refundAIReservation: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/server/actions/ai-ops", () => ({
    commitAIReservation: vi.fn().mockResolvedValue({ committed: true }),
    refundAIReservation: vi.fn().mockResolvedValue({ refunded: true }),
    getAIReservationStatus: vi.fn(),
}));

vi.mock("@/server/actions/vault-actions", () => ({
    getUserVaultProfile: vi.fn().mockResolvedValue({
        hasVaultProfile: true,
        allowAIOnEncryptedFiles: true,
    }),
}));

const mockLocalDb: Record<string, Record<string, unknown>> = {};
let capturedRemoteUpdateCallback: ((event: any) => void) | null = null;

vi.mock("@/lib/sync", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/sync")>();
    return {
        ...actual,
        createIndexedDBManager: vi.fn(() => ({
            init: vi.fn().mockResolvedValue({}),
            getFile: vi.fn().mockImplementation(async (id: string) => mockLocalDb[id] || null),
            saveFile: vi.fn().mockImplementation(async (file: { id: string } & Record<string, unknown>) => {
                mockLocalDb[file.id] = { ...mockLocalDb[file.id], ...file };
            }),
            markFileDirty: vi.fn().mockResolvedValue(undefined),
            coalesceOperation: vi.fn().mockResolvedValue(undefined),
            getOperations: vi.fn().mockResolvedValue([]),
            saveOperations: vi.fn().mockResolvedValue(undefined),
            getDirtyFiles: vi.fn().mockResolvedValue([]),
            close: vi.fn(),
        })),
        createSyncManager: vi.fn(() => ({
            init: vi.fn().mockResolvedValue(undefined),
            destroy: vi.fn(),
            sync: vi.fn().mockResolvedValue({ success: true, filesProcessed: 0 }),
            syncFile: vi.fn().mockResolvedValue(undefined),
            getStatus: vi.fn().mockReturnValue("idle"),
            onStatusChange: vi.fn().mockReturnValue(() => undefined),
            onRemoteUpdate: vi.fn().mockImplementation((cb) => {
                capturedRemoteUpdateCallback = cb;
                return () => { capturedRemoteUpdateCallback = null; };
            }),
            setConflictCallback: vi.fn(),
        })),
        connectionDetector: {
            init: vi.fn(),
            destroy: vi.fn(),
            getState: vi.fn().mockReturnValue("online"),
            onChange: vi.fn().mockReturnValue(() => undefined),
        },
        createOperationsGC: vi.fn(() => ({
            cleanup: vi.fn().mockResolvedValue(undefined),
            schedule: vi.fn().mockReturnValue(() => undefined),
        })),
    };
});

function createMockAdapter(initialContent = ""): EditorAdapter {
    let content = initialContent;
    let sel = { from: 0, to: 0 };
    let ghostRange: { from: number; to: number } | null = null;
    return {
        getValue: () => content,
        setValue: vi.fn((newContent: string) => {
            content = newContent;
            ghostRange = null;
        }),
        getSelection: () => sel,
        setSelection: vi.fn((from: number, to = from) => {
            sel = { from, to };
        }),
        replaceRange: vi.fn((from: number, to: number, insert: string) => {
            if (ghostRange) {
                if (ghostRange.from === ghostRange.to) {
                    if (from <= ghostRange.from && to >= ghostRange.from) ghostRange = null;
                } else {
                    if (from < ghostRange.to && to > ghostRange.from) ghostRange = null;
                }
            }
            content = content.slice(0, from) + insert + content.slice(to);
        }),
        replaceRanges: vi.fn((changes) => {
            ghostRange = null;
            const sorted = [...changes].sort((a, b) => b.from - a.from);
            for (const c of sorted) {
                content = content.slice(0, c.from) + c.insert + content.slice(c.to);
            }
        }),
        getSelectedText: () => content.slice(sel.from, sel.to),
        insertMarkdown: vi.fn(),
        setEditable: vi.fn(),
        focus: vi.fn(),
        blur: vi.fn(),
        hasFocus: vi.fn().mockReturnValue(true),
        undo: vi.fn().mockReturnValue(true),
        redo: vi.fn().mockReturnValue(true),
        canUndo: vi.fn().mockReturnValue(true),
        canRedo: vi.fn().mockReturnValue(false),
        getWordCount: () => content.split(/\s+/).filter(Boolean).length,
        getCharCount: () => content.length,
        getLineCount: () => content.split("\n").length,
        getHeadingCount: () => (content.match(/^#{1,6}\s/gm) || []).length,
        getMode: () => "live",
        setMode: vi.fn(),
        getDirectionSettings: () => ({ mode: "auto", lockCodeBlocksLTR: true }),
        setDirectionSettings: vi.fn(),
        startStreamingGhost: (opts) => {
            ghostRange = { from: opts.from, to: opts.to };
        },
        updateStreamingGhost: vi.fn(),
        clearStreamingGhost: () => {
            ghostRange = null;
        },
        getGhostRange: () => ghostRange,
        destroy: vi.fn(),
    };
}

describe("Encrypted Conflict Decryption & Gateway Integration", () => {
    const testUserId = "user-e2e-123";
    const testFileId = "file-enc-456";
    const masterKeyRaw = new Uint8Array(32).fill(9);

    beforeEach(() => {
        vi.clearAllMocks();
        sessionKeyStore.purgeKeys();
        sessionKeyStore.storeMasterKeyRaw(masterKeyRaw, 3600);
        Object.keys(mockLocalDb).forEach((k) => delete mockLocalDb[k]);
        capturedRemoteUpdateCallback = null;
    });

    afterEach(() => {
        sessionKeyStore.purgeKeys();
    });

    it("should transparently decrypt remote encrypted pull update and apply plaintext to editor", async () => {
        const initialPlaintext = "# Original Document\nInitial text.";
        const encInitial = await SyncCryptoGateway.encryptOutbound(testFileId, initialPlaintext, testUserId);

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: testFileId,
                title: "Encrypted Note",
                content: encInitial.ciphertextBase64,
                etag: "etag-v1",
                version: 1,
                userId: testUserId,
                isEncrypted: true,
                encryptionMetadata: encInitial.encryptionMetadata,
                isFolder: false,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            },
        });

        const adapter = createMockAdapter();
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: testFileId,
                userId: testUserId,
                editor: adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });
        expect(adapter.getValue()).toBe(initialPlaintext);

        // Simulate Browser B editing and pushing an updated encrypted version
        const remoteUpdatedPlaintext = "# Original Document\nUpdated remotely by Browser B.";
        const encRemote = await SyncCryptoGateway.encryptOutbound(testFileId, remoteUpdatedPlaintext, testUserId);

        // Fire onRemoteUpdate with encrypted payload
        act(() => {
            capturedRemoteUpdateCallback?.({
                fileId: testFileId,
                content: encRemote.ciphertextBase64,
                etag: "etag-v2",
                version: 2,
                title: "Encrypted Note",
                updatedAt: new Date().toISOString(),
                isEncrypted: true,
                encryptionMetadata: encRemote.encryptionMetadata,
            });
        });

        // Wait for async decryption and editor update
        await waitFor(() => {
            expect(adapter.getValue()).toBe(remoteUpdatedPlaintext);
            expect(result.current.serverVersion).toBe(2);
        });
        expect(adapter.getValue()).not.toContain(encRemote.ciphertextBase64);
    });

    it("should decrypt 412 serverVersion using server IV and populate activeConflict with plaintext", async () => {
        const localPlaintext = "# Doc\nLocal edits from Browser A.";
        const encLocal = await SyncCryptoGateway.encryptOutbound(testFileId, localPlaintext, testUserId);

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: testFileId,
                title: "Conflicted Doc",
                content: encLocal.ciphertextBase64,
                etag: "etag-v1",
                version: 1,
                userId: testUserId,
                isEncrypted: true,
                encryptionMetadata: encLocal.encryptionMetadata,
                isFolder: false,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            },
        });

        const adapter = createMockAdapter();
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: testFileId,
                userId: testUserId,
                editor: adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });

        // Browser B concurrently saved version 2 on the server
        const remoteServerPlaintext = "# Doc\nConcurrent remote edits from Browser B.";
        const encServer = await SyncCryptoGateway.encryptOutbound(testFileId, remoteServerPlaintext, testUserId);

        // Server rejects Browser A's save with 412 Precondition Failed
        vi.mocked(fileOps.toggleFileEncryption).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            error: "Precondition Failed",
            serverVersion: {
                content: encServer.ciphertextBase64, // Raw ciphertext from server!
                etag: "etag-v2",
                version: 2,
                updatedAt: new Date().toISOString(),
                isEncrypted: true,
                encryptionMetadata: encServer.encryptionMetadata, // Contains IV_B!
            },
        });

        // Browser A makes local edit triggering autosave
        act(() => {
            result.current.handleEditorChange("# Doc\nLocal edits from Browser A (modified).");
        });

        // Assert conflict dialog is triggered after autosave debounce
        await waitFor(
            () => {
                expect(result.current.activeConflict).not.toBeNull();
            },
            { timeout: 3000 }
        );

        expect(result.current.isConflictDialogOpen).toBe(true);

        // Critical verification: serverVersion content in activeConflict MUST BE PLAINTEXT!
        const serverConflictContent = result.current.activeConflict?.serverVersion.content;
        expect(serverConflictContent).toBe(remoteServerPlaintext);
        expect(serverConflictContent).not.toBe(encServer.ciphertextBase64);

        // Local version must also be plaintext
        expect(result.current.activeConflict?.localVersion.content).toBe(
            "# Doc\nLocal edits from Browser A (modified)."
        );
    });

    it("should resolve conflict cleanly by re-encrypting with fresh IV and setting plaintext in editor", async () => {
        const localPlaintext = "# Doc\nLocal edits from Browser A.";
        const encLocal = await SyncCryptoGateway.encryptOutbound(testFileId, localPlaintext, testUserId);

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: testFileId,
                title: "Doc",
                content: encLocal.ciphertextBase64,
                etag: "etag-v1",
                version: 1,
                userId: testUserId,
                isEncrypted: true,
                encryptionMetadata: encLocal.encryptionMetadata,
                isFolder: false,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            },
        });

        const adapter = createMockAdapter();
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: testFileId,
                userId: testUserId,
                editor: adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });

        // Set up active conflict with plaintext
        const serverPlaintext = "# Doc\nServer version to adopt.";
        const encServer = await SyncCryptoGateway.encryptOutbound(testFileId, serverPlaintext, testUserId);

        vi.mocked(fileOps.toggleFileEncryption).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            error: "Precondition Failed",
            serverVersion: {
                content: encServer.ciphertextBase64,
                etag: "etag-v2",
                version: 2,
                updatedAt: new Date().toISOString(),
                isEncrypted: true,
                encryptionMetadata: encServer.encryptionMetadata,
            },
        });

        act(() => {
            result.current.handleEditorChange("# Doc\nLocal edits trigger conflict.");
        });

        await waitFor(
            () => {
                expect(result.current.activeConflict).not.toBeNull();
            },
            { timeout: 3000 }
        );

        expect(result.current.isConflictDialogOpen).toBe(true);

        // Mock successful resolution save on server
        vi.mocked(fileOps.toggleFileEncryption).mockResolvedValueOnce({
            success: true,
            version: 3,
            etag: "etag-v3",
        });

        // User resolves by adopting server version
        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "server",
                content: serverPlaintext,
                title: "Doc",
            });
        });

        // Conflict dialog closed
        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.activeConflict).toBeNull();

        // Editor value must be the clean plaintext
        expect(adapter.getValue()).toBe(serverPlaintext);

        // toggleFileEncryption was called with freshly re-encrypted ciphertext and metadata
        expect(fileOps.toggleFileEncryption).toHaveBeenCalledWith(
            testFileId,
            true,
            expect.any(String),
            expect.objectContaining({
                algorithm: "AES-GCM-256",
                iv: expect.any(String),
            }),
            expect.objectContaining({
                expectedVersion: 2,
            })
        );

        // The sent ciphertext must NOT be plaintext
        const lastCallArgs = vi.mocked(fileOps.toggleFileEncryption).mock.calls.at(-1);
        expect(lastCallArgs?.[2]).not.toBe(serverPlaintext);
    });

    it("should quarantine remote encrypted update when vault is locked without overwriting editor", async () => {
        const initialPlaintext = "# Secure Note\nInitial data.";
        const encInitial = await SyncCryptoGateway.encryptOutbound(testFileId, initialPlaintext, testUserId);

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: testFileId,
                title: "Secure Note",
                content: encInitial.ciphertextBase64,
                etag: "etag-v1",
                version: 1,
                userId: testUserId,
                isEncrypted: true,
                encryptionMetadata: encInitial.encryptionMetadata,
                isFolder: false,
                parentFolderId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null,
            },
        });

        const adapter = createMockAdapter();
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: testFileId,
                userId: testUserId,
                editor: adapter,
            })
        );

        await waitFor(() => {
            expect(result.current.hydration).toBe("ready");
        });
        expect(adapter.getValue()).toBe(initialPlaintext);

        // Now LOCK the vault
        sessionKeyStore.purgeKeys();

        // An encrypted remote update arrives while vault is locked
        act(() => {
            capturedRemoteUpdateCallback?.({
                fileId: testFileId,
                content: "new-remote-ciphertext",
                etag: "etag-v2",
                version: 2,
                title: "Secure Note",
                updatedAt: new Date().toISOString(),
                isEncrypted: true,
                isVaultLocked: true,
                encryptionMetadata: {
                    version: 1,
                    algorithm: "AES-GCM-256",
                    keyId: "master-v1",
                    salt: "",
                    iv: "remote-iv",
                },
            });
        });

        // Editor must NOT be overwritten with ciphertext!
        expect(adapter.getValue()).toBe(initialPlaintext);
        expect(adapter.getValue()).not.toContain("new-remote-ciphertext");
        expect(result.current.isVaultLocked).toBe(true);
    });
});
