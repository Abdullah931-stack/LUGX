// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sidebar } from "../../components/layout/sidebar";
import { indexedDBManager } from "../../lib/sync/indexeddb";
import { importFile } from "../../server/actions/import-file";
import { getUserFiles } from "../../server/actions/file-ops";
import { sessionKeyStore } from "../../lib/sync/session-key-store";
import { cryptoWorkerBridge } from "../../lib/sync/crypto-worker-bridge";
import { parseFileContent } from "../../lib/parsers/text-parser";

// Mock server actions at module boundary (Contract/Unit test)
vi.mock("../../server/actions/import-file", () => ({
    importFile: vi.fn(),
}));
vi.mock("../../server/actions/file-ops", () => ({
    getUserFiles: vi.fn(),
    getDeletedFiles: vi.fn(),
}));
vi.mock("../../lib/parsers/text-parser", () => ({
    parseFileContent: vi.fn(),
}));
vi.mock("../../lib/supabase/client", () => ({
    createClient: () => ({
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "test-user" } } }) },
    }),
}));
vi.mock("../../hooks/use-toast", () => ({
    useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("../../lib/parsers/pdf-ocr-engine", () => ({
    isOcrPackageInstalled: vi.fn().mockResolvedValue(false),
}));

describe("Sidebar - LUGX-057 Vault Import Sync State", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        vi.mocked(getUserFiles).mockResolvedValue({ success: true, data: [] });
        vi.mocked(parseFileContent).mockResolvedValue("parsed text");
        
        vi.spyOn(sessionKeyStore, "hasMasterKey").mockReturnValue(true);
        vi.spyOn(sessionKeyStore, "getMasterKeyRaw").mockReturnValue(new Uint8Array([1, 2, 3]));
        vi.spyOn(cryptoWorkerBridge, "generateRandomBytes").mockResolvedValue(new Uint8Array([0, 0, 0]));
        vi.spyOn(cryptoWorkerBridge, "encryptAESGCM").mockResolvedValue({
            ciphertextBase64: "ciph",
            ivBase64: "iv",
        });
        
        vi.spyOn(indexedDBManager, "init").mockResolvedValue({} as any);
        vi.spyOn(indexedDBManager, "saveFile").mockResolvedValue();
        vi.spyOn(indexedDBManager, "getFile").mockResolvedValue({
            id: "fake-id",
            version: 1,
            etag: "",
            isDirty: true
        } as any);
    });

    it("marks vault import as dirty initially, and cleans it only after successful import", async () => {
        vi.mocked(importFile).mockResolvedValue({
            success: true,
            data: { version: 2, etag: "server-etag", wordCount: 10 } as any,
        });

        render(<Sidebar userId="test-user" />);

        // Wait for initial load
        await waitFor(() => expect(getUserFiles).toHaveBeenCalled());

        // Toggle vault import
        const vaultToggle = screen.getByLabelText(/استيراد مشفر للخزنة/i);
        fireEvent.click(vaultToggle);

        // Mock file input
        const importBtn = screen.getByText(/Import Files/i);
        const file = new File(["dummy content"], "test.md", { type: "text/markdown" });
        
        // JSDOM does not fully support file input triggers easily through the button click that creates an input dynamically.
        // We will spy on document.createElement to intercept the input.
        const originalCreateElement = document.createElement.bind(document);
        let inputEl: HTMLInputElement | null = null;
        vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
            const el = originalCreateElement(tagName);
            if (tagName === "input") {
                inputEl = el as HTMLInputElement;
            }
            return el;
        });

        fireEvent.click(importBtn);

        expect(inputEl).not.toBeNull();
        Object.defineProperty(inputEl!, "files", { value: [file] });
        fireEvent.change(inputEl!);

        // 1. Check it's saved as dirty first
        await waitFor(() => {
            expect(indexedDBManager.saveFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    isDirty: true,
                    isEncrypted: true,
                    lastSyncedAt: 0,
                }),
                "test-user"
            );
        });

        // 2. Then check importFile is called
        await waitFor(() => {
            expect(importFile).toHaveBeenCalled();
        });

        // 3. Finally check it's marked clean with server version/etag
        await waitFor(() => {
            expect(indexedDBManager.saveFile).toHaveBeenCalledWith(
                expect.objectContaining({
                    isDirty: false,
                    version: 2,
                    etag: "server-etag",
                }),
                "test-user"
            );
        });
    });
});
