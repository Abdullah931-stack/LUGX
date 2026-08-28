import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    });

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
        return NextResponse.redirect(url);
    }

    // Refresh session if expired
    let user = null;
    try {
        const { data } = await supabase.auth.getUser();
        user = data?.user || null;
    } catch (err) {
        console.warn('[Proxy] supabase.auth.getUser error (network/offline):', err);
    }

    // Protected routes - require authentication
    const protectedPaths = ["/workspace", "/account", "/dashboard"];
    const isProtectedPath = protectedPaths.some((path) =>
        request.nextUrl.pathname.startsWith(path)
    );

    // If it's a Server Action or API request, never redirect to HTML login page (which breaks Server Action client runtime)
    const isActionOrApi = request.headers.has('next-action') || request.nextUrl.pathname.startsWith('/api/');

    if (isProtectedPath && !user) {
        if (isActionOrApi) {
            return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
                status: 401,
                headers: { "Content-Type": "application/json" }
            });
        }
        // Redirect to login for page navigation
        const redirectTarget = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        const url = request.nextUrl.clone();
        url.pathname = "/login";
        url.search = "";
        url.searchParams.set("redirectTo", redirectTarget);
        return NextResponse.redirect(url);
    }

    // If user is logged in and tries to access login page, redirect to dashboard
    if (user && request.nextUrl.pathname === "/login") {
        const url = request.nextUrl.clone();
        url.pathname = "/dashboard";
        url.search = "";
        return NextResponse.redirect(url);
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
