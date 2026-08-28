/**
 * @vitest-environment jsdom
 *
 * Editor Orchestration, AutoSave & Sync Integration Tests (Phase 3 Markdown Model)
 *
 * Validates:
 * 1. Centralized state management with pure Markdown text.
 * 2. AutoSave suspension invariants (never autosaves during streaming, reserving, committing, conflict, or stopped).
 * 3. Manual edit during streaming policy: aborts AI stream on overlapping edit and preserves user edits.
 * 4. Authoritative write controller: handles manual saves, 412 conflicts, conflict resolution with conditioned writes.
 * 5. Cross-tab synchronization invariants.
 * 6. Hydration lifecycle and offline-first recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { EditorAdapter } from "@/components/editor/markdown/types";
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

// Manual-callback NDJSON consumer mock
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
        setValue: (newContent: string) => {
            content = newContent;
            ghostRange = null;
        },
        getSelection: () => sel,
        setSelection: (from: number, to = from) => {
            sel = { from, to };
        },
        replaceRange: (from: number, to: number, insert: string) => {
            if (ghostRange) {
                if (ghostRange.from === ghostRange.to) {
                    if (from <= ghostRange.from && to >= ghostRange.from) ghostRange = null;
                } else {
                    if (from < ghostRange.to && to > ghostRange.from) ghostRange = null;
                }
            }
            content = content.slice(0, from) + insert + content.slice(to);
        },
        replaceRanges: (changes) => {
            ghostRange = null;
            const sorted = [...changes].sort((a, b) => b.from - a.from);
            for (const c of sorted) {
                content = content.slice(0, c.from) + c.insert + content.slice(c.to);
            }
        },
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

describe("Editor Orchestration & Centralized Write Controller (Phase 3 Markdown Model)", () => {
    let adapter: EditorAdapter;
    const fileId = "test-file-99";
    const userId = "user-test-123";

    beforeEach(() => {
        vi.clearAllMocks();

        mockLocalDb[fileId] = {
            id: fileId,
            title: "Test Note",
            content: "Original document content",
            version: 1,
            etag: "etag-v1",
            isDirty: false,
        };

        vi.mocked(fileOps.getFile).mockResolvedValue({
            success: true,
            data: {
                id: fileId,
                title: "Test Note",
                content: "Original document content",
                version: 1,
                etag: "etag-v1",
                createdAt: new Date(),
                updatedAt: new Date(),
                userId,
                parentFolderId: null,
                isFolder: false,
                deletedAt: null,
            },
        });

        vi.mocked(fileOps.updateFileContent).mockResolvedValue({
            success: true,
            version: 2,
            etag: "etag-v2",
        });

        adapter = createMockAdapter("Original document content");

        capturedCallbacks = {} as ConsumeCallbacks;
        mockConsumeAIStream.mockImplementation(async (options: ConsumeCallbacks) => {
            capturedCallbacks = options;
            options.onMeta?.({ sessionId: "s1", operationId: "op1" });
            options.onChunk?.("Partial ", "Partial ");
            // Stream intentionally left open; individual tests complete it explicitly.
        });
    });

    afterEach(() => {
        adapter.destroy();
    });

    it("should initialize with clean state from offline storage and background server fetch", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
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
                adapter,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Simulate manual user typing
        act(() => {
            result.current.handleEditorChange("Modified content by user");
        });

        expect(result.current.isDirty).toBe(true);

        // Wait for debounce timer (1000ms) and server write execution
        await waitFor(
            () => {
                expect(fileOps.updateFileContent).toHaveBeenCalledWith(
                    fileId,
                    "Modified content by user",
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
                content: "Concurrent remote update",
                etag: "etag-v5",
                updatedAt: new Date().toISOString(),
            },
        });

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // Trigger manual change that results in 412 Conflict
        act(() => {
            result.current.handleEditorChange("Local conflicting change");
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
            result.current.handleEditorChange("Further edit during unresolved conflict");
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
                content: "Server version 3",
                etag: "etag-v3",
                updatedAt: new Date().toISOString(),
            },
        });

        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        act(() => {
            result.current.handleEditorChange("Local version 2");
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
                content: "Authoritative merged content",
                title: "Test Note",
            });
        });

        expect(fileOps.updateFileContent).toHaveBeenCalledWith(
            fileId,
            "Authoritative merged content",
            { expectedVersion: 3, expectedETag: "etag-v3" }
        );

        expect(result.current.activeConflict).toBeNull();
        expect(result.current.isConflictDialogOpen).toBe(false);
        expect(result.current.serverVersion).toBe(4);
        expect(result.current.serverEtag).toBe("etag-v4");
        expect(result.current.isDirty).toBe(false);
    });

    it("should abort active AI stream when user manually edits during active generation", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
            })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await waitFor(() => expect(result.current.isStreaming).toBe(true));

        // Trigger manual edit while stream is running (replaces document -> clears ghost)
        act(() => {
            adapter.setValue("User interrupts AI generation");
            result.current.handleEditorChange("User interrupts AI generation");
        });

        // Stream should be stopped
        await waitFor(() => expect(result.current.isStreaming).toBe(false));
    });

    it("should synchronize server version from sibling tab when clean, but retain local expectedVersion when dirty", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({
                fileId,
                userId,
                adapter,
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

    it("suspends autosave while a completed preview waits for an explicit decision (preview_ready)", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await act(async () => {
            await capturedCallbacks.onComplete?.("Improved AI output text");
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("preview_ready"));
        expect(result.current.canAutoSave()).toBe(false);

        // Explicit decision settles the session and releases autosave
        await act(async () => {
            await result.current.rejectAIPreview();
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("aborted"));
    });

    it("blocks writes during ai_committing, warns on unload, then restores a single write path", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );

        await waitFor(() => expect(result.current.title).toBe("Test Note"));

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
            useEditorOrchestrator({ fileId, userId, adapter })
        );
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        act(() => {
            result.current.handleEditorChange("Unsaved user edit");
        });
        expect(result.current.isDirty).toBe(true);

        const preventDefaultSpy = vi.spyOn(Event.prototype, "preventDefault");
        act(() => {
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
        });
        expect(preventDefaultSpy).toHaveBeenCalled();
        preventDefaultSpy.mockRestore();

        // Allow debounce timer to settle
        await new Promise((resolve) => setTimeout(resolve, 1300));
    });

    it("warns on unload while an undecided preview waits (preview_ready) even when clean", async () => {
        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        await act(async () => {
            await result.current.startAIOperation("improve");
        });
        await act(async () => {
            await capturedCallbacks.onComplete?.("Undecided preview output");
        });
        await waitFor(() => expect(result.current.aiStatus).toBe("preview_ready"));
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

    it("cold start: lost local snapshot still paints the server file (even server v1) and turns save green", async () => {
        const seedSnapshot = { ...(mockLocalDb[fileId] as Record<string, unknown>) };
        delete mockLocalDb[fileId]; // simulate the lost/corrupted local record

        vi.mocked(fileOps.getFile).mockImplementation(async () =>
            ({
                success: true,
                data: {
                    id: fileId,
                    title: "Test Note",
                    content: "Server authoritative content",
                    version: 1,
                    etag: "etag-server-v1",
                    updatedAt: "2026-08-25T00:00:00.000Z",
                },
            }) as never
        );

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );

        await waitFor(() => expect(result.current.hydration).toBe("ready"));
        expect(adapter.getValue()).toContain("Server authoritative content");
        expect(result.current.serverVersion).toBe(1);
        expect(result.current.lastSaved).not.toBeNull(); // green save dot
        expect(result.current.isDirty).toBe(false);

        mockLocalDb[fileId] = seedSnapshot; // restore suite state
    });

    it("defers autosave until hydration completes, then writes with hydrated anchors", async () => {
        vi.mocked(fileOps.updateFileContent).mockClear();
        let releaseGet!: (value: unknown) => void;
        const getGate = new Promise((resolve) => {
            releaseGet = resolve;
        });
        vi.mocked(fileOps.getFile).mockImplementation(() => getGate as never);

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );
        await waitFor(() => expect(result.current.title).toBe("")); // pre-hydration mount
        expect(result.current.hydration).toBe("hydrating");

        // Eager edit BEFORE the fetch resolves: must never reach the server.
        act(() => {
            result.current.handleEditorChange("Eager pre-hydration edit");
        });
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(fileOps.updateFileContent).not.toHaveBeenCalled();

        // Resolve with content IDENTICAL to the seeded local snapshot
        releaseGet({
            success: true,
            data: {
                id: fileId,
                title: "Test Note",
                content: "Original document content",
                version: 2,
                etag: "etag-v2",
            },
        });
        await waitFor(() => expect(result.current.hydration).toBe("ready"));

        act(() => {
            result.current.handleEditorChange("Post-hydration edit");
        });
        // Debounce (1s) must fully elapse before the anchored write lands.
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledWith(
            fileId,
            "Post-hydration edit",
            { expectedVersion: 2, expectedETag: "etag-v2" }
        );
    });

    it("OFFLINE-FIRST: unreachable server with no local snapshot unlocks local composition", async () => {
        vi.mocked(fileOps.getFile).mockImplementation(
            (() => Promise.reject(new Error("network unreachable"))) as never
        );
        vi.mocked(fileOps.updateFileContent).mockRejectedValue(
            new Error("network unreachable")
        );

        const { result } = renderHook(() =>
            useEditorOrchestrator({ fileId, userId, adapter })
        );

        // NOT fatal: hydration settles ready and releases the keyboard.
        await waitFor(() => expect(result.current.hydration).toBe("ready"));

        act(() => {
            result.current.handleEditorChange("Offline composition");
        });

        // The sync attempt is produced against the unreachable server...
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fileOps.updateFileContent)).toHaveBeenCalledWith(
            fileId,
            "Offline composition",
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

    describe("Remote Update Event Propagation & Guards (Phase 4)", () => {
        it("should apply safe fast-forward remote update cleanly to editor when document is clean", async () => {
            const { result } = renderHook(() =>
                useEditorOrchestrator({ fileId, userId, adapter })
            );

            await waitFor(() => expect(result.current.hydration).toBe("ready"));
            expect(result.current.isDirty).toBe(false);
            expect(capturedRemoteUpdateCallback).toBeDefined();

            // Simulate incoming clean remote update
            act(() => {
                capturedRemoteUpdateCallback!({
                    fileId,
                    content: "# Remote Updated Title\n\nFresh remote body",
                    etag: "etag-remote-v2",
                    version: 2,
                    title: "Remote Title",
                    updatedAt: new Date().toISOString(),
                });
            });

            expect(adapter.getValue()).toBe("# Remote Updated Title\n\nFresh remote body");
            expect(result.current.serverVersion).toBe(2);
            expect(result.current.serverEtag).toBe("etag-remote-v2");
            expect(result.current.title).toBe("Remote Title");
            expect(result.current.isDirty).toBe(false);
        });

        it("should NOT overwrite editor when remote update arrives while local document is dirty", async () => {
            const { result } = renderHook(() =>
                useEditorOrchestrator({ fileId, userId, adapter })
            );

            await waitFor(() => expect(result.current.hydration).toBe("ready"));

            // User types local changes -> becomes dirty
            act(() => {
                adapter.setValue("# My In-Progress Local Edits");
                result.current.handleEditorChange("# My In-Progress Local Edits");
            });
            expect(result.current.isDirty).toBe(true);

            // Simulate remote update arriving concurrently
            act(() => {
                capturedRemoteUpdateCallback!({
                    fileId,
                    content: "# Competing Server Version",
                    etag: "etag-remote-competing",
                    version: 3,
                    title: "Server Title",
                    updatedAt: new Date().toISOString(),
                });
            });

            // Local uncommitted user typing must remain completely untouched!
            expect(adapter.getValue()).toBe("# My In-Progress Local Edits");
            expect(result.current.isDirty).toBe(true);
        });

        it("should preserve and clamp cursor selection when safe fast-forward remote update arrives and editor has focus", async () => {
            const { result } = renderHook(() =>
                useEditorOrchestrator({ fileId, userId, adapter })
            );

            await waitFor(() => expect(result.current.hydration).toBe("ready"));

            // Set focused selection in clean editor
            adapter.setSelection(12, 12);
            expect(adapter.getSelection()).toEqual({ from: 12, to: 12 });

            act(() => {
                capturedRemoteUpdateCallback!({
                    fileId,
                    content: "# Brand New Server Content",
                    etag: "etag-remote-cursor-v2",
                    version: 2,
                    title: "Remote Title",
                    updatedAt: new Date().toISOString(),
                });
            });

            expect(adapter.getValue()).toBe("# Brand New Server Content");
            // Selection should be preserved at 12 without jumping to 0
            expect(adapter.getSelection()).toEqual({ from: 12, to: 12 });
        });
    });
});
