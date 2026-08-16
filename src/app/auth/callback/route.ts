import { redirect } from "next/navigation";
import { NextRequest } from "next/server";
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
            // Sync user to database
            await syncUserToDatabase();
            redirect(redirectTo);
        }
    }

    // If there's an error, redirect to login with error
    redirect("/login?error=auth_failed");
}
