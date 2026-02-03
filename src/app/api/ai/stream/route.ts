import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/supabase/server";
import { getUserTier, checkQuota, updateUsage } from "@/server/actions/ai-ops";
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

        // 2. Check Quota
        const wordCount = countWords(text);
        const quota = await checkQuota(user.id, operation as AIOperation, wordCount);

        if (!quota.allowed) {
            return new NextResponse(quota.reason || "Quota exceeded", { status: 403 });
        }

        // 3. Start Stream
        const aiStream = await streamWithAI(operation as AIOperation, text, tier);

        // 4. Transform Stream for Usage Tracking
        const decoder = new TextDecoder();
        let collectedResponse = "";

        const transformStream = new TransformStream({
            transform(chunk, controller) {
                // Pass through the chunk
                controller.enqueue(chunk);

                // Accumulate text for usage tracking
                const chunkText = decoder.decode(chunk, { stream: true });
                collectedResponse += chunkText;
            },
            async flush(controller) {
                // Determine usage
                const inputCount = countWords(text);

                try {
                    await updateUsage(user.id, operation as AIOperation, inputCount);
                } catch (error) {
                    console.error("Failed to update usage stats:", error);
                }
            }
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
