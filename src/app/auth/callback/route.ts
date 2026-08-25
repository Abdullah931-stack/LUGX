import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncUserToDatabase } from "@/server/actions/auth-actions";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";

export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get("code");
    const rawRedirectTo = searchParams.get("redirectTo");
    const safeRedirectPath = resolveSafeRedirectPath(rawRedirectTo, "/dashboard");

    // Enforce trusted origin: never trust spoofable x-forwarded-host headers blindly
    const trustedOrigin = process.env.NEXT_PUBLIC_APP_URL || origin;

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

            return NextResponse.redirect(new URL(safeRedirectPath, trustedOrigin));
        } else {
            console.error("[Auth Callback] exchangeCodeForSession error:", error.message);
        }
    }

    // If there's an error or no code, redirect to login with error indicator
    return NextResponse.redirect(new URL("/login?error=auth_failed", trustedOrigin));
}

