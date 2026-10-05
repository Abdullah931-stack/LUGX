/**
 * @vitest-environment jsdom
 *
 * Regression & Contract Tests for Editor Security Hardening (Phase 17)
 * Findings covered:
 * - LUGX-056: Empty User ID in AAD Derivation
 * - LUGX-004: Unmount Flush Persists Plaintext Tagged as Encrypted
 * - LUGX-047: Early Exit on Vault Lock Enters `finally`, Falsely Resetting Hydration to `ready`
 * - LUGX-048: Decryption Failure Renders Ciphertext into Editor
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { buildFileAAD, useEditorOrchestrator } from "../../hooks/use-editor-orchestrator";
import { sessionKeyStore } from "../../lib/sync/session-key-store";
import { SyncCryptoGateway } from "../../lib/sync/sync-crypto-gateway";
import * as fileOps from "../../server/actions/file-ops";
import type { EditorAdapter } from "../../components/editor/markdown/types";

// Mock dependencies
vi.mock("../../server/actions/file-ops", () => ({
    getFile: vi.fn(),
    updateFileContent: vi.fn(),
    toggleFileEncryption: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
}));

vi.mock("../../server/actions/vault-actions", () => ({
    getUserVaultProfile: vi.fn().mockResolvedValue({
        success: true,
        data: { allowAIOnEncryptedFiles: false },
    }),
}));

vi.mock("../../lib/supabase/client", () => ({
    createClient: vi.fn(() => ({
        auth: {
            getUser: vi.fn().mockResolvedValue({ data: { user: { id: "mock-user-123" } } }),
        },
    })),
}));

vi.mock("../../lib/sync/cross-tab-sync", () => ({
    broadcastCrossTabEvent: vi.fn(),
    subscribeCrossTabSync: vi.fn(() => () => {}),
}));

const mockSaveLocal = vi.fn().mockResolvedValue(undefined);
const mockLoadLocal = vi.fn().mockResolvedValue(null);

vi.mock("../../hooks/use-sync", () => ({
    useSync: vi.fn(() => ({
        isInitialized: true,
        status: "idle",
        saveLocal: mockSaveLocal,
        loadLocal: mockLoadLocal,
    })),
}));

vi.mock("../../hooks/use-ai-stream", () => ({
    useAIStream: vi.fn(() => ({
        isLoading: false,
        isStreaming: false,
        isCommitting: false,
        status: "idle",
        previewText: null,
        error: null,
        isConflict: false,
        startStream: vi.fn(),
        stopStream: vi.fn(),
        reset: vi.fn(),
        commitPreview: vi.fn(),
        rejectPreview: vi.fn(),
        retryPreview: vi.fn(),
    })),
}));

function createMockAdapter(initialValue = ""): EditorAdapter {
    let content = initialValue;
    return {
        getValue: vi.fn(() => content),
        setValue: vi.fn((val: string) => {
            content = val;
        }),
        insertText: vi.fn(),
        replaceRange: vi.fn(),
        getSelection: vi.fn(() => ({ from: 0, to: 0 })),
        setSelection: vi.fn(),
        focus: vi.fn(),
        hasFocus: vi.fn(() => false),
        setEditable: vi.fn(),
    } as unknown as EditorAdapter;
}

describe("LUGX-056: User ID validation in AAD derivation (buildFileAAD)", () => {
    it("throws descriptive error when userId is missing, empty string, or whitespace", () => {
        expect(() => buildFileAAD("", "file-123")).toThrow(/Invalid userId for file AAD/);
        expect(() => buildFileAAD("   ", "file-123")).toThrow(/Invalid userId for file AAD/);
        expect(() => buildFileAAD(undefined, "file-123")).toThrow(/Invalid userId for file AAD/);
        expect(() => buildFileAAD(null, "file-123")).toThrow(/Invalid userId for file AAD/);
    });

    it("throws descriptive error when fileId is missing, empty string, or whitespace", () => {
        expect(() => buildFileAAD("user-123", "")).toThrow(/Invalid fileId for file AAD/);
        expect(() => buildFileAAD("user-123", "   ")).toThrow(/Invalid fileId for file AAD/);
    });

    it("derives valid AAD binding when userId and fileId are valid strings", () => {
        const aad = buildFileAAD("user-123", "file-abc");
        expect(aad).toBe("vault:file:user-123:file-abc");
    });

    it("trims whitespace from valid userId and fileId", () => {
        const aad = buildFileAAD("  user-123  ", "  file-abc  ");
        expect(aad).toBe("vault:file:user-123:file-abc");
    });
});

describe("LUGX-004: Unmount Flush Plaintext Leak Prevention", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("refuses to persist plaintext tagged as encrypted when vault is locked during unmount flush", async () => {
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(false);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Mock IDB with an encrypted file
        mockLoadLocal.mockResolvedValueOnce({
            id: "enc-file-1",
            content: "encrypted-ciphertext-blob",
            title: "Encrypted Doc",
            version: 1,
            etag: "etag-1",
            isEncrypted: true,
            encryptionMetadata: { iv: "some-iv" },
            isDirty: false,
        });

        // getFile returns same encrypted file
        vi.mocked(fileOps.getFile).mockResolvedValueOnce({
            success: true,
            data: {
                id: "enc-file-1",
                content: "encrypted-ciphertext-blob",
                title: "Encrypted Doc",
                version: 1,
                etag: "etag-1",
                isEncrypted: true,
                encryptionMetadata: { iv: "some-iv" } as any,
                updatedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                userId: "user-123",
            } as any,
        });

        const adapter = createMockAdapter("unencrypted user plaintext edits");

        const { result, unmount } = renderHook(() =>
            useEditorOrchestrator({
                fileId: "enc-file-1",
                userId: "user-123",
                adapter,
            })
        );

        // Wait for initial load effect
        await act(async () => {
            await Promise.resolve();
        });

        // Trigger user edit to mark dirty
        act(() => {
            result.current.handleEditorChange("unencrypted user plaintext edits");
        });

        mockSaveLocal.mockClear();

        // Unmount to trigger flushOnUnmount
        act(() => {
            unmount();
        });

        await act(async () => {
            await Promise.resolve();
        });

        // Verify that saveLocal was NEVER called with plaintext tagged as isEncrypted: true
        expect(mockSaveLocal).not.toHaveBeenCalled();
        const calls = mockSaveLocal.mock.calls;
        for (const call of calls) {
            const savedPayload = call[0];
            if (savedPayload.isEncrypted) {
                expect(savedPayload.content).not.toBe("unencrypted user plaintext edits");
            }
        }

        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining("refusing to persist plaintext tagged as encrypted")
        );
        warnSpy.mockRestore();
    });

    it("encrypts content before saving to IndexedDB on unmount flush when vault is unlocked", async () => {
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(true);
        const encryptSpy = vi.spyOn(SyncCryptoGateway, "encryptOutbound").mockResolvedValueOnce({
            ciphertextBase64: "ENCRYPTED_OUTBOUND_CIPHERTEXT",
            encryptionMetadata: {
                version: 1,
                algorithm: "AES-GCM-256",
                keyId: "master-v1",
                salt: "",
                iv: "mock-iv",
                kdfIterations: 600000,
            },
        });

        mockLoadLocal.mockResolvedValueOnce({
            id: "enc-file-2",
            content: "initial-ciphertext",
            title: "Encrypted Doc",
            version: 1,
            etag: "etag-2",
            isEncrypted: true,
            encryptionMetadata: { iv: "some-iv" },
            isDirty: false,
        });

        vi.mocked(fileOps.getFile).mockResolvedValueOnce({
            success: true,
            data: {
                id: "enc-file-2",
                content: "initial-ciphertext",
                title: "Encrypted Doc",
                version: 1,
                etag: "etag-2",
                isEncrypted: true,
                encryptionMetadata: { iv: "some-iv" } as any,
                updatedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                userId: "user-123",
            } as any,
        });

        vi.spyOn(SyncCryptoGateway, "decryptInbound").mockResolvedValue({
            fileId: "enc-file-2",
            content: "decrypted initial text",
            isEncrypted: true,
            isVaultLocked: false,
            status: "decrypted",
            encryptionMetadata: { iv: "some-iv" } as any,
        });

        const adapter = createMockAdapter("decrypted initial text");

        const { result, unmount } = renderHook(() =>
            useEditorOrchestrator({
                fileId: "enc-file-2",
                userId: "user-123",
                adapter,
            })
        );

        await act(async () => {
            await Promise.resolve();
        });

        act(() => {
            result.current.handleEditorChange("secret user edit");
        });

        mockSaveLocal.mockClear();

        act(() => {
            unmount();
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(encryptSpy).toHaveBeenCalledWith("enc-file-2", "secret user edit", "user-123");
        expect(mockSaveLocal).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "enc-file-2",
                content: "ENCRYPTED_OUTBOUND_CIPHERTEXT",
                isEncrypted: true,
                isDirty: true,
            })
        );
    });
});

describe("LUGX-047: Early Exit on Vault Lock in loadInitialFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("retains hydration as 'vault_locked' and keeps editor uneditable when vault is locked", async () => {
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(false);

        mockLoadLocal.mockResolvedValueOnce({
            id: "locked-file-1",
            content: "raw-ciphertext",
            title: "Secret File",
            version: 1,
            etag: "etag-lock",
            isEncrypted: true,
            encryptionMetadata: { iv: "mock-iv" },
            isDirty: false,
        });

        const adapter = createMockAdapter();

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: "locked-file-1",
                userId: "user-123",
                adapter,
            })
        );

        // Run all microtasks for loadInitialFile
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // The finally block must NOT have reset hydration to 'ready'
        expect(result.current.hydration).toBe("vault_locked");
        expect(result.current.isVaultLocked).toBe(true);
        expect(result.current.isUnlockModalOpen).toBe(true);

        // Editor must remain NOT editable
        expect(adapter.setEditable).toHaveBeenLastCalledWith(false);
    });
});

describe("LUGX-048: Decryption Failure Handling in loadInitialFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("sets hydration to 'fatal', sets error, and prevents rendering ciphertext into editor on decrypt error", async () => {
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(true);

        mockLoadLocal.mockResolvedValueOnce({
            id: "corrupted-file-1",
            content: "MOCK_BASE64_CIPHERTEXT_THAT_CANNOT_BE_DECRYPTED==",
            title: "Corrupted Doc",
            version: 1,
            etag: "etag-corrupt",
            isEncrypted: true,
            encryptionMetadata: { iv: "invalid-iv" },
            isDirty: false,
        });

        vi.spyOn(SyncCryptoGateway, "decryptInbound").mockResolvedValueOnce({
            fileId: "corrupted-file-1",
            content: "MOCK_BASE64_CIPHERTEXT_THAT_CANNOT_BE_DECRYPTED==",
            isEncrypted: true,
            isVaultLocked: false,
            status: "error",
            error: "Authentication tag mismatch or corrupted ciphertext",
            encryptionMetadata: null,
        });

        const adapter = createMockAdapter();

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId: "corrupted-file-1",
                userId: "user-123",
                adapter,
            })
        );

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // Hydration must be fatal, never ready
        expect(result.current.hydration).toBe("fatal");
        expect(result.current.error).toMatch(/تعذّر فك تشفير محتوى الملف/);

        // Raw ciphertext must NOT have been written to the editor
        expect(adapter.setValue).not.toHaveBeenCalledWith(
            "MOCK_BASE64_CIPHERTEXT_THAT_CANNOT_BE_DECRYPTED=="
        );

        // Editor must NOT be editable
        expect(adapter.setEditable).toHaveBeenLastCalledWith(false);
    });
});
