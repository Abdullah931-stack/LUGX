// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileContextMenu } from "../../components/files/file-context-menu";
import { indexedDBManager } from "../../lib/sync/indexeddb";
import { toggleFileEncryption } from "../../server/actions/file-ops";
import { sessionKeyStore } from "../../lib/sync/session-key-store";
import { cryptoWorkerBridge } from "../../lib/sync/crypto-worker-bridge";
import { getUserVaultProfile } from "../../server/actions/vault-actions";

// Mock server actions at module boundary (Contract/Unit test)
vi.mock("../../server/actions/file-ops", () => ({
    toggleFileEncryption: vi.fn(),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    restoreFile: vi.fn(),
    renameFile: vi.fn(),
    copyFile: vi.fn(),
    moveFile: vi.fn(),
}));

vi.mock("../../server/actions/vault-actions", () => ({
    getUserVaultProfile: vi.fn(),
}));

vi.mock("../../lib/supabase/client", () => ({
    createClient: () => ({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user" } } }) },
    }),
}));

describe("FileContextMenu - LUGX-055 Encryption Conflict Handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Setup base crypto mocks
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(true);
        vi.spyOn(sessionKeyStore, "getMasterKeyRaw").mockReturnValue(new Uint8Array([1, 2, 3]));
        vi.spyOn(cryptoWorkerBridge, "generateRandomBytes").mockResolvedValue(new Uint8Array([0, 0, 0]));
        vi.spyOn(cryptoWorkerBridge, "encryptAESGCM").mockResolvedValue({
            ciphertextBase64: "ciph",
            ivBase64: "iv",
        });
        vi.spyOn(cryptoWorkerBridge, "decryptAESGCM").mockResolvedValue("plain");
        
        // Mock Vault Profile
        vi.mocked(getUserVaultProfile).mockResolvedValue({ success: true, data: {} as any });
        
        // Mock IDB
        vi.spyOn(indexedDBManager, "init").mockResolvedValue({} as any);
        vi.spyOn(indexedDBManager, "getCachedVaultProfile").mockResolvedValue(null);
        vi.spyOn(indexedDBManager, "saveCachedVaultProfile").mockResolvedValue();
        vi.spyOn(indexedDBManager, "getFile").mockResolvedValue({
            id: "file-1",
            content: "hello",
            version: 5,
            etag: "etag-5",
            isDirty: false,
        } as any);
        vi.spyOn(indexedDBManager, "saveFile").mockResolvedValue();
        vi.spyOn(indexedDBManager, "getOperations").mockResolvedValue([]);
        
        // Mock alert
        vi.spyOn(window, "alert").mockImplementation(() => {});
    });

    it("passes expectedVersion and expectedETag to toggleFileEncryption and handles conflict", async () => {
        // Setup toggleFileEncryption to return a conflict
        vi.mocked(toggleFileEncryption).mockResolvedValue({
            success: false,
            status: "conflict",
            error: "Conflict",
        });

        render(
            <FileContextMenu 
                isOpen={true} 
                onClose={vi.fn()} 
                fileId="file-1" 
                fileName="test.md" 
                isFolder={false} 
                isEncrypted={false} 
                userId="test-user" 
            />
        );

        // Click encrypt
        const encryptBtn = screen.getByText(/تشفير الملف/i);
        fireEvent.click(encryptBtn);

        await waitFor(() => {
            expect(toggleFileEncryption).toHaveBeenCalledWith(
                "file-1",
                true,
                "ciph",
                expect.objectContaining({ iv: "iv" }),
                { expectedVersion: 5, expectedETag: "etag-5" }
            );
        });

        // Because it returned conflict, it should show an alert and NOT save to IDB
        await waitFor(() => {
            expect(window.alert).toHaveBeenCalledWith(expect.stringContaining("تعذر التشفير"));
            // saveFile is not called for the new encrypted state due to the early return
            expect(indexedDBManager.saveFile).not.toHaveBeenCalled();
        });
    });
});
