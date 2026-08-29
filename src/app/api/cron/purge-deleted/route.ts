import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

/**
 * Purge expired tombstones — 30-day soft-delete retention.
 *
 * Permanently deletes file rows whose `deleted_at` is older than
 * RETENTION_DAYS, in bounded batches to keep each run short and cheap.
 *
 * AUTH: Protected by a shared cron secret (CRON_SECRET env). Call from
 * a scheduler (cron, GitHub Actions, Vercel cron) with:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app/api/cron/purge-deleted
 *
 * IDEMPOTENT: running it extra times only deletes what is already past
 * the retention window — nothing else.
 */
const RETENTION_DAYS = 30;
const BATCH_LIMIT = 500;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const header = request.headers.get("Authorization") ?? "";
    return header === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
    if (!authorized(request)) {
        return NextResponse.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    try {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);

        // Bounded batch: one route run deletes at most BATCH_LIMIT rows so
        // long-running purges never hold a connection indefinitely.
        // Drizzle's PgDelete builder has no .limit(), and parameterized LIMIT
        // is rejected by prepared statements, so the bound is expressed as a
        // CTE subquery (portable across PG versions and platforms).
        const result = await db.execute(sql`
            WITH doomed AS (
                SELECT id FROM files
                WHERE deleted_at <= ${cutoff}
                LIMIT ${BATCH_LIMIT}
            )
            DELETE FROM files USING doomed
            WHERE files.id = doomed.id
        `);

        const deleted = result?.rowCount ?? 0;

        return NextResponse.json({
            success: true,
            deleted,
            cutoff: cutoff.toISOString(),
            retentionDays: RETENTION_DAYS,
            batchLimit: BATCH_LIMIT,
            done: deleted < BATCH_LIMIT, // client can stop scheduling once done
        });
    } catch (error) {
        console.error("Purge deleted files error:", error);
        return NextResponse.json(
            { success: false, error: "Purge failed" },
            { status: 500 }
        );
    }
}
