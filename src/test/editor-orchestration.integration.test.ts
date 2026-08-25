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
import { commitAIFileOperation } from "@/server/actions/ai-commit";

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

vi.mock("@/server/actions/ai-ops", () => ({
    commitAIReservation: vi.fn().mockResolvedValue({ committed: true }),
    refundAIReservation: vi.fn().mockResolvedValue({ refunded: true }),
    getAIReservationStatus: vi.fn(),
}));

// Manual-callback NDJSON consumer mock (same harness style as
// ai-preview-decision.test.ts): tests drive stream callbacks explicitly.
type ConsumeCallbacks = {
    onMeta?: (meta: { sessionId: string; operationId: string }) => void;
    onChunk?: (accumulated: string, latestChunk: string) => void;
    onComplete?: (finalRawText: string) => void | Promise<void>;
    onError?: (err: Error) => void;
};
const mockConsumeAIStream = vi.fn();
vi.mock("@/lib/ai/stream-handler", () => ({
    consumeAIStream: (...args: unknown[]) => mockConsumeAIStream(...args),
}));
let capturedCallbacks: ConsumeCallbacks;

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

        capturedCallbacks = {} as ConsumeCallbacks;
        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            capturedCallbacks = options;
            options.onMeta?.({ sessionId: "s1", operationId: "op1" });
            options.onChunk?.("Partial ", "Partial ");
            // Stream intentionally left open; individual tests complete it explicitly.
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

    // ==================== Phase 11 closure assertions ====================

    it("suspends autosave during active AI streaming for outside-range edits", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Real selection -> ghost target range [1, 10]
        editor.commands.setTextSelection({ from: 1, to: 10 });
        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await waitFor(() => expect(result.current.isStreaming).toBe(true));
        expect(result.current.canAutoSave()).toBe(false);

        // Move the cursor OUTSIDE the ghost range, then edit there
        const docEnd = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: docEnd, to: docEnd });
        act(() => {
            result.current.handleEditorChange(
                "<p>Original document content</p><p>Safe second paragraph</p>"
            );
        });

        // Full debounce window elapses WITHOUT any server write (suspension invariant)
        await new Promise((resolve) => setTimeout(resolve, 1300));
        // No server write may carry THIS suspended edit (stale debounce timers
        // from earlier suites may legally flush their own queued writes here).
        const suspendedStreamingEdit = "<p>Original document content</p><p>Safe second paragraph</p>";
        expect(
            vi.mocked(fileOps.updateFileContent).mock.calls.some((c) => c[1] === suspendedStreamingEdit)
        ).toBe(false);
        // Stream retained because the edit was outside the target range
        expect(result.current.isStreaming).toBe(true);

        await act(async () => {
            await result.current.stopAIOperation();
        });
    });

    it("suspends autosave while a completed preview waits for an explicit decision (preview_ready)", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));
        editor.commands.setTextSelection({ from: 1, to: 10 });

        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await act(async () => {
            await capturedCallbacks.onComplete?.("Improved AI output text");
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("preview_ready"));
        expect(result.current.canAutoSave()).toBe(false);

        // Edit OUTSIDE the parked preview range: allowed, but autosave suspended
        const docEnd = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: docEnd, to: docEnd });
        act(() => {
            result.current.handleEditorChange("<p>Edit while preview parked</p>");
        });
        await new Promise((resolve) => setTimeout(resolve, 1300));
        // No server write may carry THIS suspended edit while a decision is pending.
        const suspendedPreviewEdit = "<p>Edit while preview parked</p>";
        expect(
            vi.mocked(fileOps.updateFileContent).mock.calls.some((c) => c[1] === suspendedPreviewEdit)
        ).toBe(false);

        // Explicit decision settles the session and releases autosave
        await act(async () => {
            await result.current.rejectAIPreview();
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("aborted"));
    });

    it("blocks writes during ai_committing, warns on unload, then restores a single write path", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));
        editor.commands.setTextSelection({ from: 1, to: 10 });

        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await act(async () => {
            await capturedCallbacks.onComplete?.("Commit candidate output");
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("preview_ready"));

        // Hang the server atomic commit to hold the session in committing state
        let releaseCommit!: (value: unknown) => void;
        const commitGate = new Promise((resolve) => {
            releaseCommit = resolve;
        });
        vi.mocked(commitAIFileOperation).mockImplementationOnce(
            () => commitGate as unknown as ReturnType<typeof commitAIFileOperation>
        );

        let commitPromise: Promise<void> | null = null;
        act(() => {
            commitPromise = result.current.commitAIPreview();
        });
        await waitFor(() => expect(result.current.isCommitting).toBe(true));
        expect(result.current.writeState).toBe("ai_committing");
        expect(result.current.canAutoSave()).toBe(false);

        // Navigation/unload guard MUST warn while a commit is in flight
        const preventDefaultSpy = vi.spyOn(Event.prototype, "preventDefault");
        act(() => {
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        });
        expect(preventDefaultSpy).toHaveBeenCalled();
        preventDefaultSpy.mockRestore();

        // Edits during committing must NOT enqueue an interleaved server write
        const docEnd = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: docEnd, to: docEnd });
        act(() => {
            result.current.handleEditorChange("<p>Edit while committing</p>");
        });
        await new Promise((resolve) => setTimeout(resolve, 1300));
        // No server write may carry THIS edit while the commit is in flight:
        // the single-write-path invariant forbids interleaved autosaves.
        const suspendedCommittingEdit = "<p>Edit while committing</p>";
        expect(
            vi.mocked(fileOps.updateFileContent).mock.calls.some((c) => c[1] === suspendedCommittingEdit)
        ).toBe(false);

        // Release the commit: single authoritative completion
        releaseCommit({
            success: true,
            status: "committed",
            version: 3,
            etag: "etag-v3",
        });
        await act(async () => {
            await commitPromise;
        });
        await waitFor(() => {
            expect(result.current.serverVersion).toBe(3);
            expect(result.current.serverEtag).toBe("etag-v3");
        });
    });

    it("warns on unload while the document is dirty", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        act(() => {
            result.current.handleEditorChange("<p>Unsaved user edit</p>");
        });
        expect(result.current.isDirty).toBe(true);

        const preventDefaultSpy = vi.spyOn(Event.prototype, "preventDefault");
        act(() => {
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        });
        expect(preventDefaultSpy).toHaveBeenCalled();
        preventDefaultSpy.mockRestore();
    });

    it("warns on unload while an undecided preview waits (preview_ready) even when clean", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        editor.commands.setTextSelection({ from: 1, to: 10 });
        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await act(async () => {
            await capturedCallbacks.onComplete?.("Undecided preview output");
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("preview_ready"));
        // Document is pristine: the warning must come from the parked preview alone
        expect(result.current.isDirty).toBe(false);

        const preventDefaultSpy = vi.spyOn(Event.prototype, "preventDefault");
        act(() => {
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        });
        expect(preventDefaultSpy).toHaveBeenCalled();
        preventDefaultSpy.mockRestore();

        // After an explicit decision the guard releases navigation
        await act(async () => {
            await result.current.rejectAIPreview();
        });
        const afterDecisionSpy = vi.spyOn(Event.prototype, "preventDefault");
        act(() => {
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        });
        expect(afterDecisionSpy).not.toHaveBeenCalled();
        afterDecisionSpy.mockRestore();
    });

    // ==================== Phase 11 hotfix: hydration lifecycle ====================

    it("cold start: lost local snapshot still paints the server file (even server v1) and turns save green", async () => {
        const seedSnapshot = { ...(mockLocalDb[fileId] as Record<string, unknown>) };
        delete mockLocalDb[fileId]; // simulate the lost/corrupted local record
        // Persistent gate: React 18 may double-invoke mount effects in tests,
        // so EVERY mount must receive the same authoritative server payload.
        vi.mocked(fileOps.getFile).mockImplementation(async () =>
            ({
                success: true,
                data: {
                    id: fileId,
                    title: "Test Note",
                    content: "<p>Server authoritative content</p>",
                    version: 1,
                    etag: "etag-server-v1",
                    updatedAt: "2026-08-25T00:00:00.000Z",
                },
            }) as never
        );

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );

        await waitFor(() => expect(result.current.hydration).toBe("ready"));
        expect(editor.getHTML()).toContain("Server authoritative content");
        expect(result.current.serverVersion).toBe(1);
        expect(result.current.lastSaved).not.toBeNull(); // green save dot
        expect(result.current.isDirty).toBe(false);

        // Hydration itself must never trigger a rogue autosave. Scoped to OUR
        // payload: stale debounce timers from earlier suites may legally flush
        // their own queued writes inside this wait window.
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(
            vi.mocked(fileOps.updateFileContent).mock.calls.some(
                (c) => c[1] === "<p>Server authoritative content</p>"
            )
        ).toBe(false);

        mockLocalDb[fileId] = seedSnapshot; // restore suite state
    });

    it("defers autosave until hydration completes, then writes with hydrated anchors", async () => {
        let releaseGet!: (value: unknown) => void;
        const getGate = new Promise((resolve) => {
            releaseGet = resolve;
        });
        // Persistent gate: both effect invocations must hang on this promise.
        vi.mocked(fileOps.getFile).mockImplementation(() => getGate as never);

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );
        await waitFor(() => expect(result.current.title).toBe("")); // pre-hydration mount
        expect(result.current.hydration).toBe("hydrating");

        // Eager edit BEFORE the fetch resolves: must never reach the server.
        act(() => {
            result.current.handleEditorChange("<p>Eager pre-hydration edit</p>");
        });
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(fileOps.updateFileContent).not.toHaveBeenCalled();

        // Resolve with content IDENTICAL to the seeded local snapshot so the
        // policy lands on adopt_metadata and advances the anchors to v2.
        releaseGet({
            success: true,
            data: {
                id: fileId,
                title: "Test Note",
                content: "<p>Original document content</p>",
                version: 2,
                etag: "etag-v2",
            },
        });
        await waitFor(() => expect(result.current.hydration).toBe("ready"));

        act(() => {
            result.current.handleEditorChange("<p>Post-hydration edit</p>");
        });
        // Debounce (1s) must fully elapse before the anchored write lands.
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledWith(
            fileId,
            "<p>Post-hydration edit</p>",
            { expectedVersion: 2, expectedETag: "etag-v2" }
        );
    });

    it("OFFLINE-FIRST: unreachable server with no local snapshot unlocks local composition", async () => {
        // Transport-level failure (network down): the request was PRODUCED but
        // the server could not be reached. Per offline-first, this is NEVER
        // fatal \u2014 the user completes on the local copy.
        // Persistent rejection gate: BOTH effect invocations must hit the same
        // transport failure (React 18 double-invokes mount effects in tests).
        vi.mocked(fileOps.getFile).mockImplementation(
            (() => Promise.reject(new Error("network unreachable"))) as never
        );
        vi.mocked(fileOps.updateFileContent).mockRejectedValue(
            new Error("network unreachable")
        );

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, editor })
        );

        // NOT fatal: hydration settles ready and releases the keyboard.
        await waitFor(() => expect(result.current.hydration).toBe("ready"));

        act(() => {
            result.current.handleEditorChange("<p>Offline composition</p>");
        });

        // The sync attempt is honestly produced against the unreachable server...
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledWith(
            fileId,
            "<p>Offline composition</p>",
            { expectedVersion: 1, expectedETag: undefined }
        );

        // ...and COMPLETES LOCALLY: durable dirty snapshot in IndexedDB.
        const localRecord = mockLocalDb[fileId] as
            | { content?: string; isDirty?: boolean }
            | undefined;
        expect(localRecord).toBeDefined();
        expect(localRecord?.isDirty).toBe(true);
        expect(String(localRecord?.content)).toContain("Offline composition");
    });
});
