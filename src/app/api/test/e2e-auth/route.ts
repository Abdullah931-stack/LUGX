import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { db, schema } from "@/lib/db";

export const dynamic = "force-dynamic";

function isTestEnvironment(): boolean {
    return process.env.NODE_ENV === "test" || process.env.PLAYWRIGHT === "1";
}

/**
 * POST /api/test/e2e-auth
 * Establishes an authentic Supabase test session and syncs the user to the isolated Neon database.
 */
export async function POST(request: NextRequest) {
    if (!isTestEnvironment()) {
        return NextResponse.json({ error: "Access denied. Test environment only." }, { status: 403 });
    }

    try {
        const body = await request.json();
        const email = body.email || "e2e-runner@lugx.test";
        const password = body.password || "E2E_Secure_Pass_2026!";
        const displayName = body.displayName || "E2E Test User";

        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

        const admin = createAdminClient(supabaseUrl, serviceKey);
        const anon = createAdminClient(supabaseUrl, anonKey);

        // Ensure user exists in Supabase Auth
        const { data: listData } = await admin.auth.admin.listUsers();
        let user = listData?.users.find((u) => u.email === email);

        if (!user) {
            const { data: createData, error: createError } = await admin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: { full_name: displayName },
            });
            if (createError) {
                return NextResponse.json({ error: createError.message }, { status: 400 });
            }
            user = createData.user;
        }

        // Generate session tokens via password sign-in
        const { data: sessionData, error: signInError } = await anon.auth.signInWithPassword({
            email,
            password,
        });

        if (signInError || !sessionData.session) {
            return NextResponse.json(
                { error: signInError?.message || "Failed to establish session" },
                { status: 400 }
            );
        }

        // Sync user to isolated Neon database
        await db
            .insert(schema.users)
            .values({
                id: user.id,
                email: user.email || email,
                displayName,
                tier: body.tier || "free",
            })
            .onConflictDoUpdate({
                target: schema.users.id,
                set: {
                    displayName,
                    tier: body.tier || "free",
                    updatedAt: new Date(),
                },
            });

        await db
            .insert(schema.usage)
            .values({
                userId: user.id,
                date: new Date().toISOString().split("T")[0],
            })
            .onConflictDoNothing({
                target: [schema.usage.userId, schema.usage.date],
            });

        const cookiesForClient: Array<{
            name: string;
            value: string;
            path?: string;
        }> = [];

        const ssrClient = createServerClient(supabaseUrl, anonKey, {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        cookiesForClient.push({
                            name,
                            value,
                            path: options?.path || "/",
                        });
                    });
                },
            },
        });

        await ssrClient.auth.setSession({
            access_token: sessionData.session.access_token,
            refresh_token: sessionData.session.refresh_token,
        });

        const finalResponse = NextResponse.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                displayName,
            },
            session: {
                accessToken: sessionData.session.access_token,
                expiresAt: sessionData.session.expires_at,
            },
            cookies: cookiesForClient,
        });

        cookiesForClient.forEach((c) => {
            finalResponse.cookies.set(c.name, c.value, {
                path: c.path,
                sameSite: "lax",
                httpOnly: false,
                secure: false,
            });
        });

        return finalResponse;
    } catch (error) {
        console.error("[E2E Auth API] Error:", error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : "Internal error" },
            { status: 500 }
        );
    }
}

/**
 * DELETE /api/test/e2e-auth
 * Signs out and clears all Supabase session cookies.
 */
export async function DELETE(request: NextRequest) {
    if (!isTestEnvironment()) {
        return NextResponse.json({ error: "Access denied. Test environment only." }, { status: 403 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

    const response = NextResponse.json({ success: true, message: "Logged out" });

    const ssrClient = createServerClient(supabaseUrl, anonKey, {
        cookies: {
            getAll() {
                return request.cookies.getAll();
            },
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({ name, value, options }) => {
                    response.cookies.set(name, value, options);
                });
            },
        },
    });

    await ssrClient.auth.signOut();

    // Explicitly delete all Supabase auth cookies
    const allCookies = request.cookies.getAll();
    for (const c of allCookies) {
        if (c.name.startsWith("sb-") && c.name.includes("auth-token")) {
            response.cookies.delete(c.name);
        }
    }

    return response;
}
