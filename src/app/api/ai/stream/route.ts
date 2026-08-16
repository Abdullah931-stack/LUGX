import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getUserTier, checkQuota, reserveAndUpdateUsage } from "@/server/actions/ai-ops";
import { streamWithAI } from "@/lib/ai/client";
import { countWords } from "@/lib/utils";
import { AIOperation } from "@/lib/ai/prompts";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
    try {
        const user = await getUser();
        if (!user) {
            return new NextResponse("Unauthorized", { status: 401 });
        }

        const body = await req.json();
        const { text, operation } = body;

        if (!text || !operation) {
            return new NextResponse("Missing required fields", { status: 400 });
        }

        // 1. Get User Tier
        const tier = await getUserTier(user.id);

        // 2. Atomically reserve quota BEFORE starting the stream (TOCTOU fix).
        // The old flow (checkQuota -> stream -> updateUsage) let concurrent
        // requests slip past the quota check. Quota is now deducted
        // conditionally in one atomic step; if exhausted, the stream never starts.
        const wordCount = countWords(text);
        const reservation = await reserveAndUpdateUsage(
            user.id,
            operation as AIOperation,
            wordCount,
            tier,
        );

        if (!reservation.reserved) {
            return new NextResponse(reservation.reason || "Quota exceeded", { status: 403 });
        }

        // 3. Start Stream
        const aiStream = await streamWithAI(operation as AIOperation, text, tier);

        // 4. Transform Stream (quota already reserved; no per-chunk tracking needed)
        const transformStream = new TransformStream({
            transform(chunk, controller) {
                controller.enqueue(chunk);
            },
            flush(controller) {
                controller.terminate();
            },
        });

        const responseStream = aiStream.pipeThrough(transformStream);

        return new NextResponse(responseStream, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
            },
        });

    } catch (error: any) {
        console.error("AI Stream Error:", error);
        return new NextResponse(error.message || "Internal Server Error", { status: 500 });
    }
}
