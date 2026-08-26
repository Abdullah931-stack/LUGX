/**
 * @vitest-environment jsdom
 *
 * LIVE integration tests — Editor orchestration single-writer path
 * (Phase 9 / Gate G9) against the isolated Neon test branch.
 *
 * Unlike `editor-orchestration.integration.test.ts` (which mocks server
 * actions), this suite runs the REAL `file-ops` server actions against the
 * branch and asserts persisted rows. Only two boundaries stay mocked:
 *  - Supabase session (`getUser`) — auth boundary;
 *  - `@/lib/sync` IndexedDB/SyncManager — browser-local boundary, not the
 *    system under test here.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { EditorAdapter } from "@/components/editor/markdown/types";
import { useEditorOrchestrator } from "@/hooks/use-editor-orchestrator";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { getUser } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ getUser: vi.fn(async () => ({ id: USER_ID })) }));

function createMockAdapter(initialContent = ""): EditorAdapter {
    let content = initialContent;
    let sel = { from: 0, to: 0 };
    return {
        getValue: () => content,
        setValue: (newContent: string) => {
            content = newContent;
        },
        getSelection: () => sel,
        setSelection: (from: number, to = from) => {
            sel = { from, to };
        },
        replaceRange: (from: number, to: number, insert: string) => {
            content = content.slice(0, from) + insert + content.slice(to);
        },
        replaceRanges: (changes: { from: number; to: number; insert: string }[]) => {
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
        destroy: vi.fn(),
    };
}

// Browser-local storage boundary (NOT the system under test).
vi.mock("@/lib/sync", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/sync")>();
    return {
        ...actual,
        createIndexedDBManager: vi.fn(() => ({
            init: vi.fn().mockResolvedValue({}),
            getFile: vi.fn().mockResolvedValue(null),
            saveFile: vi.fn().mockResolvedValue(undefined),
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

const USER_ID = "77777777-7777-7777-7777-777777777777"; // placeholder pattern
const FILE_ID = randomUUID();

async function seedFile(): Promise<void> {
    await testDb
        .insert(schema.files)
        .values({
            id: FILE_ID,
            userId: USER_ID,
            title: "Test Note",
            content: "Original",
            version: 1,
            etag: "etag-v1",
        })
        .onConflictDoUpdate({
            target: schema.files.id,
            set: {
                title: "Test Note",
                content: "Original",
                version: 1,
                etag: "etag-v1",
                deletedAt: null,
            },
        });
}

async function getFileRow() {
    const [row] = await testDb
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, FILE_ID));
    return row;
}

describe("LIVE: editor orchestration single-writer path on isolated branch", () => {
    let adapter: EditorAdapter;

    const renderOrchestrator = () =>
        renderHook(() => useEditorOrchestrator({ fileId: FILE_ID, userId: USER_ID, adapter }));

    beforeEach(async () => {
        vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
        await seedFile();
        adapter = createMockAdapter("Original");
    });

    afterEach(() => {
        adapter.destroy();
    });

    afterAll(async () => {
        await cleanupTestUsers([USER_ID]);
    });

    it("initializes from the REAL database row (title/version/etag)", async () => {
        const { result } = renderOrchestrator();

        await waitFor(() => expect(result.current.title).toBe("Test Note"));
        expect(result.current.serverVersion).toBe(1);
        expect(result.current.serverEtag).toBe("etag-v1");
        expect(result.current.isDirty).toBe(false);
        expect(result.current.writeState).toBe("idle");
    });

    it("debounced autosave persists the edit through the real update action", async () => {
        const { result } = renderOrchestrator();
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        act(() => {
            result.current.handleEditorChange("<p>Modified content by user</p>");
        });
        expect(result.current.isDirty).toBe(true);

        // Debounce (1000ms) + real DB round-trip — assert persisted rows.
        await waitFor(
            () => {
                expect(result.current.serverVersion).toBe(2);
                expect(result.current.isDirty).toBe(false);
            },
            { timeout: 8000 }
        );
        const row = await getFileRow();
        expect(row.version).toBe(2);
        expect(row.content).toBe("<p>Modified content by user</p>");
        expect(row.etag).not.toBe("etag-v1"); // new etag computed server-side
    });

    it("detects a real 412 against a sibling write and resolves via authoritative merge", async () => {
        const { result } = renderOrchestrator();
        await waitFor(() => expect(result.current.title).toBe("Test Note"));

        // First local save advances to v2 (establishes hook's expected state).
        act(() => {
            result.current.handleEditorChange("<p>Local v2</p>");
        });
        await waitFor(
            () => expect(result.current.serverVersion).toBe(2),
            { timeout: 8000 }
        );

        // Sibling tab write directly in the DB: version jumps to 3.
        await testDb
            .update(schema.files)
            .set({ version: 3, etag: "etag-v3", content: "<p>Sibling v3</p>" })
            .where(eq(schema.files.id, FILE_ID));

        // Stale local write must collide with the sibling's v3.
        act(() => {
            result.current.handleEditorChange("<p>Local conflicting change</p>");
        });
        await waitFor(
            () => expect(result.current.activeConflict).not.toBeNull(),
            { timeout: 8000 }
        );
        expect(result.current.activeConflict?.serverVersion.version).toBe(3);

        // Resolve with an authoritative conditioned merge write.
        await act(async () => {
            await result.current.handleResolveConflict({
                strategy: "merge",
                content: "<p>Authoritative merged content</p>",
                title: "Test Note",
            });
        });

        expect(result.current.activeConflict).toBeNull();
        expect(result.current.serverVersion).toBe(4);

        const row = await getFileRow();
        expect(row.version).toBe(4);
        expect(row.content).toBe("<p>Authoritative merged content</p>");
    });
});
