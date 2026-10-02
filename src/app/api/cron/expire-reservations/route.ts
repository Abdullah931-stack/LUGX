import { NextRequest, NextResponse } from "next/server";
import { expireStaleReservations } from "@/server/services/ai-settlement-service";

/**
 * Sweeper for stale AI quota reservations — closing TD-02.
 *
 * Transitions abandoned `reserved` records to `expired` and restores
 * user quota counters in PostgreSQL.
 *
 * AUTH: Protected by shared cron secret (CRON_SECRET env).
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://app/api/cron/expire-reservations
 *
 * IDEMPOTENT: Re-running only touches records that are currently past
 * their TTL window (`expires_at <= now()`).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { timingSafeEqual } from "crypto";
import { acquireCronLock } from "@/lib/cron/lock";

function authorized(request: NextRequest): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret) return false;
    const header = request.headers.get("Authorization") ?? "";
    const expected = `Bearer ${secret}`;
    const headerBuf = Buffer.from(header);
    const expectedBuf = Buffer.from(expected);
    if (headerBuf.length !== expectedBuf.length) {
        return false;
    }
    return timingSafeEqual(headerBuf, expectedBuf);
}

export async function GET(request: NextRequest) {
    if (!authorized(request)) {
        return NextResponse.json(
            { success: false, error: "Unauthorized" },
            { status: 401 }
        );
    }

    const lock = await acquireCronLock("expire-reservations", 300);
    if (!lock.acquired) {
        return NextResponse.json({
            success: true,
            skipped: true,
            reason: "Overlapping execution prevented by distributed lock",
            timestamp: new Date().toISOString(),
        });
    }

    try {
        const expiredCount = await expireStaleReservations();

        return NextResponse.json({
            success: true,
            expiredCount,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error("Expire reservations cron error:", error);
        return NextResponse.json(
            { success: false, error: "Expire reservations failed" },
            { status: 500 }
        );
    } finally {
        await lock.release();
    }
}

export const POST = GET;

