/**
 * LIVE integration tests — Server atomic commit & optimistic version guard
 * (Gate G2 / Phase 8) against the isolated Neon test branch.
 *
 * ONLY the Supabase session boundary is mocked (`getUser`); the database
 * client, the transactional client and all production logic run for real.
 * Live twin of the mocked contract suite `ai-server-atomic-commit.test.ts`.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb, cleanupTestUsers } from "@/test/test-db";
import * as schema from "@/lib/db/schema";
import { getUser } from "@/lib/supabase/server";
import { commitAIFileOperation } from "@/server/actions/ai-commit";
import { reserveAndUpdateUsage } from "@/server/actions/ai-ops";

vi.mock("@/lib/supabase/server", () => ({ getUser: vi.fn() }));

const USER_ID = "66666666-6666-6666-6666-666666666666"; // placeholder pattern

async function seedFileWithReservation(operationId: string): Promise<string> {
    await testDb
        .insert(schema.users)
        .values({ id: USER_ID, email: `${USER_ID}@live.test` })
        .onConflictDoNothing();
    const fileId = randomUUID();
    await testDb.insert(schema.files).values({
        id: fileId,
        userId: USER_ID,
        title: `Live atomic ${operationId}`,
        content: "<p>v1</p>",
        etag: "etag-v1",
    });
    await testDb.delete(schema.aiReservations).where(
        eq(schema.aiReservations.operationId, operationId)
    );
    const res = await reserveAndUpdateUsage(USER_ID, "improve", 60, "pro", {
        operationId,
        fileId,
    });
    if (!res.reserved) throw new Error(`seed reservation failed: ${res.reason}`);
    return fileId;
}

async function getFileRow(fileId: string) {
    const [row] = await testDb
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, fileId));
    return row;
}

afterAll(async () => {
    await cleanupTestUsers([USER_ID]);
});

describe("LIVE: server atomic commit on isolated branch", () => {
    it("refuses unauthenticated commits with zero mutation", async () => {
        vi.mocked(getUser).mockResolvedValueOnce(null as never);
        const fileId = await seedFileWithReservation("live-g2-unauth");

        const res = await commitAIFileOperation({
            operationId: "live-g2-unauth",
            fileId,
            expectedVersion: 1,
            resultContent: "<p>should never land</p>",
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe("unauthorized");
        const row = await getFileRow(fileId);
        expect(row.version).toBe(1);
        expect(row.content).toBe("<p>v1</p>");
    });

    it("commits file + reservation atomically in one real transaction", async () => {
        vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
        const fileId = await seedFileWithReservation("live-g2-success");

        const res = await commitAIFileOperation({
            operationId: "live-g2-success",
            fileId,
            expectedVersion: 1,
            resultContent: "<p>committed content</p>",
        });

        expect(res.success).toBe(true);
        expect(res.status).toBe("committed");

        // Row-level proof: file advanced, reservation settled, same tx.
        const fileRow = await getFileRow(fileId);
        expect(fileRow.version).toBe(2);
        expect(fileRow.content).toBe("<p>committed content</p>");

        const [reservation] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, "live-g2-success"));
        expect(reservation.status).toBe("committed");
        expect(reservation.committedUnits).toBe(60);
    });

    it("stale expectedVersion yields conflict with ZERO mutation anywhere", async () => {
        vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
        const fileId = await seedFileWithReservation("live-g2-stale");

        const res = await commitAIFileOperation({
            operationId: "live-g2-stale",
            fileId,
            expectedVersion: 99,
            resultContent: "<p>stale attempt</p>",
        });

        expect(res.success).toBe(false);
        expect(res.status).toBe("conflict");

        // Nothing changed: file untouched, reservation still reserved.
        const row = await getFileRow(fileId);
        expect(row.version).toBe(1);
        expect(row.content).toBe("<p>v1</p>");
        const [reservation] = await testDb
            .select()
            .from(schema.aiReservations)
            .where(eq(schema.aiReservations.operationId, "live-g2-stale"));
        expect(reservation.status).toBe("reserved");
    });

    it("replay after successful commit is idempotent (no second version bump)", async () => {
        vi.mocked(getUser).mockResolvedValue({ id: USER_ID } as never);
        const fileId = await seedFileWithReservation("live-g2-replay");
        const params = {
            operationId: "live-g2-replay",
            fileId,
            expectedVersion: 1,
            resultContent: "<p>committed once</p>",
        };

        const first = await commitAIFileOperation(params);
        expect(first.success).toBe(true);

        const replay = await commitAIFileOperation(params);
        expect(replay.success).toBe(true);
        expect(replay.status).toBe("already_committed");

        const row = await getFileRow(fileId);
        expect(row.version).toBe(2); // NOT 3 — no double write.
    });
});
