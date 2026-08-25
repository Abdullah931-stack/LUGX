"use server";

import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db";
import { createClient, getUser } from "@/lib/supabase/server";
import { eq } from "drizzle-orm";
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
    redirect("/");
}

/**
 * Sync user to database after OAuth login
 * Called from auth callback
 */
export async function syncUserToDatabase(): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "No authenticated user" };
        }

        const userEmail = user.email || `${user.id}@auth.local`;
        const displayName = user.user_metadata?.full_name || user.email?.split("@")[0] || "User";
        const avatarUrl = user.user_metadata?.avatar_url || null;

        // Atomic UPSERT: insert new user or update profile metadata without read-modify-write race
        await db.insert(schema.users).values({
            id: user.id,
            email: userEmail,
            displayName,
            avatarUrl,
            tier: "free",
        }).onConflictDoUpdate({
            target: schema.users.id,
            set: {
                displayName,
                avatarUrl,
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
        const user = await getUser();
        if (!user) {
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
 */
export async function updateUserProfile(
    data: { displayName?: string }
): Promise<{ success: boolean; error?: string }> {
    try {
        const user = await getUser();
        if (!user) {
            return { success: false, error: "Not authenticated" };
        }

        await db.update(schema.users)
            .set({
                ...data,
                updatedAt: new Date(),
            })
            .where(eq(schema.users.id, user.id));

        return { success: true };

    } catch (error) {
        console.error("Update profile error:", error);
        return { success: false, error: "Failed to update profile" };
    }
}
