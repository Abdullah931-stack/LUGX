import { NextRequest, NextResponse } from "next/server";
import { expireStaleReservations } from "@/server/actions/ai-ops";

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
    }
}

export const POST = GET;

