import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function copyCookiesAndRedirect(url: URL | string, sourceResponse: NextResponse): NextResponse {
    const redirectResponse = NextResponse.redirect(url);
    for (const cookie of sourceResponse.cookies.getAll()) {
        redirectResponse.cookies.set(cookie);
    }
    return redirectResponse;
}

export async function proxy(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) =>
                        request.cookies.set(name, value)
                    );
                    supabaseResponse = NextResponse.next({
                        request,
                    });
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    );
                },
            },
        }
    );

    // Intercept OAuth callback codes if they land on root or other pages
    if (request.nextUrl.searchParams.has("code") && request.nextUrl.pathname !== "/auth/callback") {
        const url = request.nextUrl.clone();
        url.pathname = "/auth/callback";
        return copyCookiesAndRedirect(url, supabaseResponse);
    }

    // Protected routes - require authentication
    const protectedPaths = ["/workspace", "/account", "/dashboard"];
    const isProtectedPath = protectedPaths.some((path) =>
        request.nextUrl.pathname.startsWith(path)
    );
    const isLoginPath = request.nextUrl.pathname === "/login";
    const hasAuthCookies = request.cookies.getAll().some((cookie) =>
        cookie.name.startsWith("sb-")
    );

    // Fast-Path: Bypass expensive getUser() network call on public non-auth routes (e.g. "/", public assets)
    // and on /login when no auth cookies exist.
    const shouldCheckUser = isProtectedPath || (isLoginPath && hasAuthCookies);

    // Refresh session if needed with watchdog timeout
    let user = null;
    if (shouldCheckUser) {
        try {
            const timeoutSignal = AbortSignal.timeout(2500);
            const timeoutPromise = new Promise<never>((_, reject) => {
                if (timeoutSignal.aborted) {
                    reject(new Error("Supabase auth.getUser watchdog timeout after 2500ms"));
                    return;
                }
                timeoutSignal.addEventListener(
                    "abort",
                    () => {
                        reject(new Error("Supabase auth.getUser watchdog timeout after 2500ms"));
                    },
                    { once: true }
                );
            });

            const { data } = await Promise.race([
                supabase.auth.getUser(),
                timeoutPromise,
            ]);
            user = data?.user || null;
        } catch (err) {
            console.warn('[Proxy] supabase.auth.getUser error (network/offline):', err);
        }
    }

    // If it's a Server Action or API request, never redirect to HTML login page (which breaks Server Action client runtime)
    const isActionOrApi = request.headers.has('next-action') || request.nextUrl.pathname.startsWith('/api/');

    if (isProtectedPath && !user) {
        if (isActionOrApi) {
            const res = new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "Content-Type": "application/json" }
            });
            for (const cookie of supabaseResponse.cookies.getAll()) {
                res.cookies.set(cookie);
            }
            return res;
        }
        // Redirect to login for page navigation
        const redirectTarget = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        const url = request.nextUrl.clone();
        url.pathname = "/login";
        url.search = "";
        url.searchParams.set("redirectTo", redirectTarget);
        return copyCookiesAndRedirect(url, supabaseResponse);
    }

    // If user is logged in and tries to access login page, redirect to dashboard
    if (user && isLoginPath) {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.search = "";
        return copyCookiesAndRedirect(url, supabaseResponse);
    }

    return supabaseResponse;
}

export const config = {
    matcher: [
        /*
         * Match all request paths except for the ones starting with:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - public files (images, fonts, etc.)
         */
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2)$).*)",
    ],
};
