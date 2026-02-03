"use server";

import { redirect } from "next/navigation";
import { db, schema } from "@/lib/db";
import { createClient, getUser } from "@/lib/supabase/server";
import { eq } from "drizzle-orm";

/**
 * Sign in with Google OAuth
 */
export async function signInWithGoogle(redirectTo?: string) {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
            redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback${redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : ""
                }`,
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
 * Sign in with email and password
 */
export async function signInWithEmail(
    email: string,
    password: string
): Promise<{ error?: string }> {
    const supabase = await createClient();

    const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
    });

    if (error) {
        return { error: error.message };
    }

    redirect("/dashboard");
}

/**
 * Sign up with email and password
 */
export async function signUpWithEmail(
    email: string,
    password: string,
    displayName?: string
): Promise<{ error?: string }> {
    const supabase = await createClient();

    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {
                display_name: displayName,
            },
        },
    });

    if (error) {
        return { error: error.message };
    }

    // Create user record in our database
    if (data.user) {
        await db.insert(schema.users).values({
            id: data.user.id,
            email: data.user.email!,
            displayName: displayName || data.user.email?.split("@")[0],
            tier: "free",
        }).onConflictDoNothing();
    }

    redirect("/dashboard");
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

        // Check if user exists
        const existingUser = await db.query.users.findFirst({
            where: eq(schema.users.id, user.id),
        });

        if (!existingUser) {
            // Create user record
            await db.insert(schema.users).values({
                id: user.id,
                email: user.email!,
                displayName: user.user_metadata?.full_name || user.email?.split("@")[0],
                avatarUrl: user.user_metadata?.avatar_url,
                tier: "free",
            });

            // Create initial usage record
            await db.insert(schema.usage).values({
                userId: user.id,
                date: new Date().toISOString().split("T")[0],
            });
        } else {
            // Update user info
            await db.update(schema.users)
                .set({
                    displayName: user.user_metadata?.full_name || existingUser.displayName,
                    avatarUrl: user.user_metadata?.avatar_url || existingUser.avatarUrl,
                    updatedAt: new Date(),
                })
                .where(eq(schema.users.id, user.id));
        }

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
