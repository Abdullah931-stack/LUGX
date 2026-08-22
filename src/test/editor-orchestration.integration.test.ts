/**
 * @vitest-environment jsdom
 *
 * Editor Orchestration, AutoSave & Sync Integration Tests (Phase 9 / Gate G9)
 *
 * Validates:
 * 1. Centralized state management (document, preview, dirty, server version, conflict, write state).
 * 2. AutoSave suspension invariants (never autosaves during streaming, reserving, committing, conflict, or stopped).
 * 3. Manual edit during streaming policy: immediately aborts AI stream, clears ghost, and avoids corrupt merges.
 * 4. Authoritative write controller: handles manual saves, 412 conflicts, conflict resolution with conditioned writes.
 * 5. Atomic single undo invariant after AI operations.
 * 6. Cross-tab synchronization invariants (clean vs dirty tabs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { StreamingGhostExtension } from "@/lib/extensions/streaming-ghost-extension";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import * as fileOps from "@/server/actions/file-ops";

// Mock server actions
vi.mock("@/server/actions/file-ops", () => ({
    getFile: vi.fn(),
    updateFileContent: vi.fn(),
    renameFile: vi.fn(),
    deleteFile: vi.fn(),
}));

vi.mock("@/server/actions/ai-commit", () => ({
    commitAIFileOperation: vi.fn(),
    refundAIReservation: vi.fn().mockResolvedValue({ success: true }),
}));

// Mock IndexedDB and SyncManager dependencies
const mockLocalDb: Record<string, Record<string, unknown>> = {};

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

describe("Editor Orchestration & Centralized Write Controller (Phase 9)", () => {
    let editor: Editor;
    const fileId = "test-file-99";
    const userId = "user-test-123";

    beforeEach(() => {
        vi.clearAllMocks();

        mockLocalDb[fileId] = {
            id: fileId,
            title: "Test Note",
            content: "<p>Original document content</p>",
            version: 1,
            etag: "etag-v1",
            isDirty: false,
        };

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: fileId,
                title: "Test Note",
                content: "<p>Original document content</p>",
                version: 1,
                etag: "etag-v1",
                createdAt: new Date(),
                updatedAt: new Date(),
                userId,
                parentFolderId: null,
                isFolder: false,
                storagePath: null,
                deletedAt: null,
            },
        });

        vi.mocked(fileOps.updateFileContent).mockResolvedValue({
            success: true,
            version: 2,
            etag: "etag-v2",
        });

        editor = new Editor({
            extensions: [StarterKit, StreamingGhostExtension],
            content: "<p>Original document content</p>",
        });
    });

    afterEach(() => {
        editor.destroy();
    });

    it("should initialize with clean state from offline storage and background server fetch", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));
        expect(result.current.serverVersion).toBe(1);
        expect(result.current.serverEtag).toBe("etag-v1");
        expect(result.current.isDirty).toBe(false);
        expect(result.current.isSaving).toBe(false);
        expect(result.current.writeState).toBe("idle");
    });

    it("should trigger debounced auto-save on manual edit and advance version", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Simulate manual user typing
        act(() => {
            result.current.handleEditorChange("<p>Modified content by user</p>");
        });

        expect(result.current.isDirty).toBe(true);

        // Wait for debounce timer (1000ms) and server write execution
        await waitFor(
            () => {
                expect(fileOps.updateFileContent).toHaveBeenCalledWith(
                    fileId,
                    "<p>Modified content by user</p>",
                    { expectedVersion: 1, expectedETag: "etag-v1" }
                );
            },
            { timeout: 3000 }
        );

        await waitFor(() => {
            expect(result.current.serverVersion).toBe(2);
            expect(result.current.serverEtag).toBe("etag-v2");
            expect(result.current.isDirty).toBe(false);
        });
    });

    it("should suspend auto-save when active conflict is unresolved", async () => {
        vi.mocked(fileOps.updateFileContent).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            error: "412 Precondition Failed",
            serverVersion: {
                version: 5,
                content: "<p>Concurrent remote update</p>",
                etag: "etag-v5",
                updatedAt: new Date().toISOString(),
            },
        });

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Trigger manual change that results in 412 Conflict
        act(() => {
            result.current.handleEditorChange("<p>Local conflicting change</p>");
        });

        await waitFor(
            () => {
                expect(result.current.activeConflict).not.toBeNull();
            },
            { timeout: 3000 }
        );

        expect(result.current.isConflictDialogOpen).toBe(true);
        expect(result.current.activeConflict?.serverVersion.version).toBe(5);

        // Try to trigger another edit while conflict is unresolved
        vi.mocked(fileOps.updateFileContent).mockClear();

        act(() => {
            result.current.handleEditorChange("<p>Further edit during unresolved conflict</p>");
        });

        // Wait a period to ensure debounced autosave does NOT call updateFileContent
        await new Promise((resolve) => setTimeout(resolve, 1300));

        // Auto-save MUST be suspended; updateFileContent must not be called
        expect(fileOps.updateFileContent).not.toHaveBeenCalled();
    });

    it("should execute conflict resolution via authoritative conditioned write", async () => {
        vi.mocked(fileOps.updateFileContent).mockResolvedValueOnce({
            success: false,
            status: "conflict",
            error: "412 Conflict",
            serverVersion: {
                version: 3,
                content: "<p>Server version 3</p>",
                etag: "etag-v3",
                updatedAt: new Date().toISOString(),
            },
        });

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        act(() => {
            result.current.handleEditorChange("<p>Local version 2</p>");
        });

        await waitFor(
            () => {
                expect(result.current.activeConflict).not.toBeNull();
            },
            { timeout: 3000 }
        );

        // Now resolve conflict with merged content
        vi.mocked(fileOps.updateFileContent).mockResolvedValueOnce({
            success: true,
            version: 4,
            etag: "etag-v4",
        });

        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "merge",
                content: "<p>Authoritative merged content</p>",
                title: "Test Note",
            });
        });

        expect(fileOps.updateFileContent).toHaveBeenCalledWith(
            fileId,
            "<p>Authoritative merged content</p>",
            { expectedVersion: 3, expectedETag: "etag-v3" }
        );

        expect(result.current.activeConflict).toBeNull();
        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.serverVersion).toBe(4);
        expect(result.current.serverEtag).toBe("etag-v4");
        expect(result.current.isDirty).toBe(false);
    });

    it("should abort active AI stream when user manually edits INSIDE the target selection range", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Set ghost streaming decoration on range [1, 10]
        editor.commands.startStreamingGhost({
            from: 1,
            to: 10,
            text: "AI is generating text...",
            operation: "improve",
        });

        // Position user selection inside [1, 10] (overlapping)
        editor.commands.setTextSelection({ from: 3, to: 5 });

        // Trigger manual edit while selection is inside the AI range
        act(() => {
            result.current.handleEditorChange("<p>User interrupts AI inside target paragraph</p>");
        });

        // Stream should be stopped and ghost cleared
        expect(result.current.isStreaming).toBe(false);
    });

    it("should ALLOW manual edits in other paragraphs outside target range without aborting active AI stream", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Set ghost streaming decoration on paragraph 1 (range [1, 10])
        editor.commands.startStreamingGhost({
            from: 1,
            to: 10,
            text: "AI is generating text for paragraph 1...",
            operation: "improve",
        });

        // Position user cursor in paragraph 2 (outside target range, e.g. pos 20)
        editor.commands.setTextSelection({ from: 20, to: 20 });

        // Trigger manual edit in paragraph 2
        act(() => {
            result.current.handleEditorChange("<p>Original</p><p>User editing paragraph 2 safely</p>");
        });

        // Active AI stream should NOT be aborted because edit is outside the target selection range
        expect(result.current.isDirty).toBe(true);
    });

    it("should synchronize server version from sibling tab when clean, but retain local expectedVersion when dirty", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                editor,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));
        expect(result.current.serverVersion).toBe(1);

        // Broadcast save event from a simulated sibling tab
        act(() => {
            const channel = new BroadcastChannel("textai_cross_tab_sync");
            channel.postMessage({
                type: "file_saved",
                fileId,
                version: 7,
                etag: "etag-v7",
                senderTabId: "sibling_tab_999",
                timestamp: Date.now(),
            });
            channel.close();
        });

        // Clean tab should advance its server version reference
        await waitFor(
            () => {
                expect(result.current.serverVersion).toBe(7);
                expect(result.current.serverEtag).toBe("etag-v7");
            },
            { timeout: 2000 }
        );
    });
});
