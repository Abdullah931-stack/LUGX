import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncUserToDatabase } from "@/server/actions/auth-actions";

export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get("code");
    const redirectTo = searchParams.get("redirectTo") || "/dashboard";

    if (code) {
        const supabase = await createClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);

        if (!error) {
            try {
                // Sync user to Neon database
                await syncUserToDatabase();
            } catch (syncErr) {
                console.error("[Auth Callback] Database user sync error:", syncErr);
            }

            const forwardedHost = request.headers.get("x-forwarded-host");
            const isLocalEnv = process.env.NODE_ENV === "development";

            if (isLocalEnv) {
                return NextResponse.redirect(`${origin}${redirectTo}`);
            } else if (forwardedHost) {
                return NextResponse.redirect(`https://${forwardedHost}${redirectTo}`);
            } else {
                return NextResponse.redirect(`${origin}${redirectTo}`);
            }
        } else {
            console.error("[Auth Callback] exchangeCodeForSession error:", error.message);
        }
    }

    // If there's an error or no code, redirect to login with error indicator
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}

