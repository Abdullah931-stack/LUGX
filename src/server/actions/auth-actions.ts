"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { db, schema } from "@/server/db";
import { createClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser } from "@/server/auth/session";
import { eq, sql } from "drizzle-orm";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";

/**
 * Sign in with Google OAuth
 */
export async function signInWithGoogle(redirectTo?: string) {
    const supabase = await createClient();

    const safeRedirect = resolveSafeRedirectPath(redirectTo, "/dashboard");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const callbackUrl = new URL("/auth/callback", appUrl);
    callbackUrl.searchParams.set("redirectTo", safeRedirect);

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo: callbackUrl.toString(),
        },
    });

    if (error) {
        return { error: error.message };
    }

    if (data.url) {
        redirect(data.url);
    }
}

/**
 * Sign out
 */
export async function signOut() {
    const supabase = await createClient();
    await supabase.auth.signOut();

    // Invalidate stale RSC layouts and router cache
    revalidatePath("/", "layout");

    // Explicitly wipe all Supabase auth session cookies
    const cookieStore = await cookies();
    const allCookies = cookieStore.getAll();
    for (const cookie of allCookies) {
        if (cookie.name.startsWith("sb-")) {
            cookieStore.delete(cookie.name);
        }
    }

    redirect("/");
}

/**
 * Sync user to database after OAuth login.
 * Remediates LUGX-139: Preserves existing custom display name, synchronizes email changes,
 * and maintains atomic upsert integrity.
 */
export async function syncUserToDatabase(): Promise<{ success: boolean; error?: string }> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, error: "No authenticated user" };
        }

        const userEmail = user.email || `${user.id}@auth.local`;
        const defaultDisplayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "User";
        const avatarUrl = user.user_metadata?.avatar_url || null;

        // Atomic UPSERT: preserves custom displayName using COALESCE and updates email
        await db.insert(schema.users).values({
            id: user.id,
            email: userEmail,
            displayName: defaultDisplayName,
            avatarUrl,
            tier: "free",
        }).onConflictDoUpdate({
            target: schema.users.id,
            set: {
                email: userEmail,
                displayName: sql`COALESCE(${schema.users.displayName}, ${defaultDisplayName})`,
                avatarUrl: avatarUrl ? avatarUrl : schema.users.avatarUrl,
                updatedAt: new Date(),
            },
        });

        // Atomic ensure: inserts initial usage record idempotently
        await db.insert(schema.usage).values({
            userId: user.id,
            date: new Date().toISOString().split("T")[0],
        }).onConflictDoNothing({
            target: [schema.usage.userId, schema.usage.date],
        });

        return { success: true };

    } catch (error) {
        console.error("Sync user error:", error);
        return { success: false, error: "Failed to sync user" };
    }
}

/**
 * Get current user profile
 */
export async function getUserProfile(): Promise<{
    success: boolean;
    data?: typeof schema.users.$inferSelect;
    error?: string;
}> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, error: "Not authenticated" };
        }

        const profile = await db.query.users.findFirst({
            where: eq(schema.users.id, user.id),
        });

        if (!profile) {
            return { success: false, error: "User profile not found" };
        }

        return { success: true, data: profile };

    } catch (error) {
        console.error("Get profile error:", error);
        return { success: false, error: "Failed to get profile" };
    }
}

/**
 * Update user profile
 * Remediates LUGX-067: Strict allowlist construction preventing mass assignment
 * of sensitive columns (tier, stripeCustomerId, email).
 */
export async function updateUserProfile(
    data: { displayName?: string }
): Promise<{ success: boolean; error?: string }> {
    try {
        let user;
        try {
            user = await requireAuthenticatedUser();
        } catch {
            return { success: false, error: "Not authenticated" };
        }

        const updatePayload: { displayName?: string; updatedAt: Date } = {
            updatedAt: new Date(),
        };

        // Strict allowlist: only extract and sanitize displayName
        if (data && typeof data.displayName === "string") {
            const sanitized = data.displayName.trim().slice(0, 100);
            if (sanitized.length > 0) {
                updatePayload.displayName = sanitized;
            }
        }

        await db.update(schema.users)
            .set(updatePayload)
            .where(eq(schema.users.id, user.id));

        return { success: true };

    } catch (error) {
        console.error("Update profile error:", error);
        return { success: false, error: "Failed to update profile" };
    }
}
