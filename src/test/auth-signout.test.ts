/**
 * Authentication Sign-Out & Cache Invalidation Test Suite
 *
 * Verifies TD-12 remediation:
 * 1. signOut() triggers supabase.auth.signOut().
 * 2. Invalidate RSC layouts via revalidatePath("/", "layout").
 * 3. Proactively clears all "sb-*" auth cookies from cookieStore.
 * 4. Preserves non-auth cookies (e.g. theme, prefs).
 * 5. Executes redirect("/").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSignOut = vi.fn();
const mockRevalidatePath = vi.fn();
const mockRedirect = vi.fn();
const mockCookieDelete = vi.fn();

const mockCookies: Array<{ name: string; value: string }> = [];

vi.mock("next/cache", () => ({
    revalidatePath: (path: string, type?: "layout" | "page") => mockRevalidatePath(path, type),
}));

vi.mock("next/navigation", () => ({
    redirect: (url: string) => {
        mockRedirect(url);
        throw new Error(`NEXT_REDIRECT:${url}`);
    },
}));

vi.mock("next/headers", () => ({
    cookies: vi.fn(async () => ({
        getAll: () => [...mockCookies],
        delete: (name: string) => mockCookieDelete(name),
    })),
}));

vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
        auth: {
            signOut: mockSignOut,
        },
    })),
    getUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
    db: {
        insert: vi.fn(),
        query: { users: { findFirst: vi.fn() } },
        update: vi.fn(),
    },
    schema: {
        users: { id: "id" },
        usage: { userId: "userId", date: "date" },
    },
}));

import { signOut } from "@/server/actions/auth-actions";

describe("TD-12: signOut() Cache Invalidation & Cookie Wiping", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCookies.length = 0;
    });

    it("invalidates layout cache, wipes all sb-* cookies, and redirects to /", async () => {
        mockCookies.push(
            { name: "sb-access-token", value: "tok_123" },
            { name: "sb-refresh-token", value: "ref_456" },
            { name: "theme_preference", value: "dark" },
            { name: "sb-provider-token", value: "prov_789" }
        );

        await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/");

        // 1. Supabase auth.signOut() was invoked
        expect(mockSignOut).toHaveBeenCalledTimes(1);

        // 2. revalidatePath("/", "layout") was invoked to purge stale RSC cache
        expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");

        // 3. Only sb-* cookies are deleted
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-access-token");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-refresh-token");
        expect(mockCookieDelete).toHaveBeenCalledWith("sb-provider-token");
        expect(mockCookieDelete).not.toHaveBeenCalledWith("theme_preference");
        expect(mockCookieDelete).toHaveBeenCalledTimes(3);

        // 4. Redirect was invoked with "/"
        expect(mockRedirect).toHaveBeenCalledWith("/");
    });

    it("handles sign-out when no sb-* cookies are present", async () => {
        mockCookies.push({ name: "app_locale", value: "en" });

        await expect(signOut()).rejects.toThrow("NEXT_REDIRECT:/");

        expect(mockSignOut).toHaveBeenCalledTimes(1);
        expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
        expect(mockCookieDelete).not.toHaveBeenCalled();
        expect(mockRedirect).toHaveBeenCalledWith("/");
    });
});
