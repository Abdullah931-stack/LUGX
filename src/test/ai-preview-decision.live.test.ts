/**
 * @vitest-environment jsdom
 *
 * LIVE integration tests — AI preview explicit-decision model against the
 * isolated Neon test branch.
 *
 * Mocked boundaries ONLY: Supabase session (`getUser`) and the NDJSON network
 * consumer (`consumeAIStream`, driven manually). Everything else is real:
 * quota reservation, reservation settlement, and the atomic server commit all
 * hit real rows. Live twin of `ai-preview-decision.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { CodeMirrorEditorAdapter, createEditorAdapter } from "@/components/editor/markdown/editor-adapter";
import { createMarkdownExtensions } from "@/components/editor/markdown/markdown-extensions";
import { useAIStream } from "@/hooks/use-ai-stream";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { getUser } from "@/lib/supabase/server";
import { reserveAndUpdateUsage } from "@/server/actions/ai-ops";

vi.mock("@/lib/supabase/server", () => ({ getUser: vi.fn(async () => ({ id: USER_ID })) }));

// jsdom has no WebSocket, so the Neon-serverless WS pool cannot open there.
// Route interactive transactions through the REAL pg pool against the SAME
// isolated branch — the same precedent used by ai-atomic-commit.integration.
vi.mock("@/lib/db/transactional", async () => {
    const { testDb } = await import("@/test/test-db");
    return { txDb: testDb };
});

type ConsumeCallbacks = {
    onMeta?: (meta: { sessionId: string; operationId: string; reservationId?: string }) => void;
    onChunk?: (accumulated: string, latestChunk: string) => void;
    onComplete?: (finalRawText: string) => void | Promise<void>;
    onError?: (err: Error) => void;
};
let capturedCallbacks: ConsumeCallbacks & { operationId?: string };
vi.mock("@/lib/ai/stream-handler", () => ({
    consumeAIStream: vi.fn(async (options: never) => {
        const opts = options as ConsumeCallbacks & { operationId: string };
        capturedCallbacks = opts;
        // Mirror the production /api/ai/stream route: the quota reservation is
        // created SERVER-side for the hook-generated operationId.
        if (activeFixture) {
            await seedServerReservation(opts.operationId, activeFixture.fileId);
        }
        opts.onMeta?.({ sessionId: "s-live", operationId: opts.operationId });
        opts.onChunk?.("Better text", " text");
        await opts.onComplete?.("Better text");
    }),
}));

const USER_ID = "88888888-8888-8888-8888-888888888888"; // placeholder pattern
const INITIAL = "The quick brown fox jumps over the lazy dog.";

interface Fixture {
    fileId: string;
}

let activeFixture: Fixture | null = null;

async function seedUserAndFile(): Promise<Fixture> {
    await testDb
        .insert(schema.users)
        .values({ id: USER_ID, email: `${USER_ID}@live.test` })
        .onConflictDoNothing();
    const fileId = randomUUID();
    await testDb.insert(schema.files).values({
        id: fileId,
        userId: USER_ID,
        title: `Preview live ${fileId.slice(0, 8)}`,
        content: INITIAL,
        etag: "etag-v1",
    });
    return { fileId };
}

/**
 * Mirrors the production /api/ai/stream route: the reservation is created
 * SERVER-side for the hook-generated operationId once the stream starts.
 */
async function seedServerReservation(operationId: string, fileId: string) {
    const res = await reserveAndUpdateUsage(USER_ID, "improve", 11, "pro", {
        operationId,
        fileId,
    });
    if (!res.reserved) throw new Error(`server-seed failed: ${res.reason}`);
}

afterAll(async () => {
    await cleanupTestUsers([USER_ID]);
});

describe("LIVE: AI preview explicit decision model on isolated branch", () => {
    let editor: CodeMirrorEditorAdapter;
    let view: EditorView;
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement("div");
        document.body.appendChild(container);

        const state = EditorState.create({
            doc: INITIAL,
            extensions: createMarkdownExtensions({ mode: "live" }),
        });
        view = new EditorView({ state, parent: container });
        editor = new CodeMirrorEditorAdapter(view);
    });

    afterEach(() => {
        view.destroy();
        container.remove();
    });

    const renderAIStream = () =>
        renderHook(() =>
            useAIStream({
                onCommitSuccess: vi.fn(),
                onConflict: vi.fn(),
                onError: vi.fn(),
                onProgrammaticTransaction: (fn) => fn(),
            })
        );

    const startDefaultStream = async (
        result: { current: ReturnType<typeof useAIStream> },
        fixture: Fixture
    ) => {
        await act(async () => {
            await result.current.startStream({
                editor,
                operation: "improve",
                fileId: fixture.fileId,
                expectedVersion: 1,
                originalEtag: "etag-v1",
                editorGeneration: 1,
            });
        });
    };

    it("parks the completed stream in preview_ready with ZERO server writes", async () => {
        activeFixture = await seedUserAndFile();
        const fixture = activeFixture;
        const snapshot = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result, fixture);
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));

        // Document pristine, preview parked.
        expect(editor.getValue()).toBe(snapshot);
        expect(result.current.previewText).toBe("Better text");

        // DB untouched by preview: file still v1, reservation still reserved.
        const [fileRow] = await testDb
            .select()
            .from(schema.files)
            .where(eq(schema.files.id, fixture.fileId));
        expect(fileRow.version).toBe(1);
        const [reservation] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, capturedCallbacks.operationId!));
        expect(reservation.status).toBe("reserved");
    });

    it("rejectPreview settles the reservation as consumed (never refunds) and keeps the document pristine", async () => {
        activeFixture = await seedUserAndFile();
        const fixture = activeFixture;
        const snapshot = editor.getValue();
        const { result } = renderAIStream();

        await startDefaultStream(result, fixture);
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));

        await act(async () => {
            result.current.rejectPreview();
        });

        expect(editor.getValue()).toBe(snapshot);

        // Settlement is fire-and-forget inside the hook — wait for the row.
        let reservation!: typeof schema.aiReservations.$inferSelect;
        await waitFor(async () => {
            const [row] = await testDb
                .select()
                .from(schema.aiReservations)
                .where(
                    eq(
                        schema.aiReservations.operationId,
                        capturedCallbacks.operationId!
                    )
                );
            if (!row || row.status !== "committed") {
                throw new Error("reservation not settled as committed yet");
            }
            reservation = row;
        });
        expect(reservation.committedUnits).toBe(11);
        expect(reservation.refundedUnits).toBe(0); // NEVER refunded

        const [fileRow] = await testDb
            .select()
            .from(schema.files)
            .where(eq(schema.files.id, fixture.fileId));
        expect(fileRow.version).toBe(1); // document untouched
    });

    it("commitPreview performs the real server-first commit then applies ONE atomic local replace", async () => {
        activeFixture = await seedUserAndFile();
        const fixture = activeFixture;
        const { result } = renderAIStream();

        await startDefaultStream(result, fixture);
        await waitFor(() => expect(result.current.status).toBe("preview_ready"));

        await act(async () => {
            await result.current.commitPreview();
        });

        // Server truth: single version bump + content persisted atomically.
        const [fileRow] = await testDb
            .select()
            .from(schema.files)
            .where(eq(schema.files.id, fixture.fileId));
        expect(fileRow.version).toBe(2);
        expect(fileRow.content).toContain("Better text");

        const [reservation] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, capturedCallbacks.operationId!));
        expect(reservation.status).toBe("committed");

        // Local editor applied the AI output as exactly one undoable step.
        expect(editor.getValue()).toContain("Better text");
        editor.undo();
        expect(editor.getValue()).toBe(INITIAL);
    });
});
