/**
 * Phase 12: Authentication, OAuth & Open Redirect Hardening Test Suite
 *
 * Verifies:
 * 1. Safe redirect resolution algorithm against all canonical and obfuscated open redirect vectors.
 * 2. Unicode homographs (full-width slashes, small reverse solidus, zero-width spaces).
 * 3. ASCII control characters and null bytes (%00, \x00, CRLF).
 * 4. MAX_URL_LENGTH (2048) and universal backslash rejection.
 * 5. Auth callback route (/auth/callback):
 *    - Rejects open redirect payloads and falls back to /dashboard.
 *    - Rejects untrusted x-forwarded-host headers in favor of canonical trusted origin.
 *    - Handles session exchange success and failure deterministically.
 *    - Resists HTTP Parameter Pollution (HPP).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveSafeRedirectPath } from "@/lib/auth/safe-redirect";
import { GET as authCallbackGET } from "@/app/auth/callback/route";
import { NextRequest } from "next/server";

// Mock supabase client and user sync
const mockExchangeCodeForSession = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
        auth: {
            exchangeCodeForSession: mockExchangeCodeForSession,
        },
    })),
}));

const mockSyncUserToDatabase = vi.fn();
vi.mock("@/server/actions/auth-actions", () => ({
    syncUserToDatabase: () => mockSyncUserToDatabase(),
}));

describe("Phase 12: Safe Redirect Resolution (resolveSafeRedirectPath)", () => {
    describe("Valid Internal Routes", () => {
        it("allows standard internal paths", () => {
            expect(resolveSafeRedirectPath("/dashboard")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/workspace")).toBe("/workspace");
            expect(resolveSafeRedirectPath("/account")).toBe("/account");
            expect(resolveSafeRedirectPath("/workspace/editor/doc-123")).toBe("/workspace/editor/doc-123");
        });

        it("preserves query parameters and fragments on valid internal paths", () => {
            expect(resolveSafeRedirectPath("/workspace?tab=recent")).toBe("/workspace?tab=recent");
            expect(resolveSafeRedirectPath("/workspace/editor/123?view=split#section-2")).toBe(
                "/workspace/editor/123?view=split#section-2"
            );
        });

        it("respects custom valid defaultPath fallback", () => {
            expect(resolveSafeRedirectPath(null, "/workspace")).toBe("/workspace");
            expect(resolveSafeRedirectPath("https://evil.com", "/workspace")).toBe("/workspace");
        });
    });

    describe("Empty, Null, and Falsy Inputs", () => {
        it("returns /dashboard for null, undefined, empty, or whitespace-only inputs", () => {
            expect(resolveSafeRedirectPath(null)).toBe("/dashboard");
            expect(resolveSafeRedirectPath(undefined)).toBe("/dashboard");
            expect(resolveSafeRedirectPath("")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("   ")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("\t\n\r")).toBe("/dashboard");
        });

        it("returns /dashboard if target is not a relative path starting with slash", () => {
            expect(resolveSafeRedirectPath("dashboard")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("workspace/editor")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("www.google.com")).toBe("/dashboard");
        });
    });

    describe("Open Redirect & Protocol-Relative Attack Vectors", () => {
        it("blocks standard external absolute URLs (http and https)", () => {
            expect(resolveSafeRedirectPath("https://evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("http://evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("https://evil.com/dashboard")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("http://attacker.com/workspace")).toBe("/dashboard");
        });

        it("blocks protocol-relative URLs (//evil.com)", () => {
            expect(resolveSafeRedirectPath("//evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("//evil.com/path")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("///evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("////evil.com")).toBe("/dashboard");
        });

        it("blocks backslash in any position (/\\evil.com, \\evil.com, /foo\\bar)", () => {
            expect(resolveSafeRedirectPath("/\\evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("\\evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("\\\\evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\\\\evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/foo\\bar")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/workspace\\editor\\doc")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/sub\\..\\..\\evil.com")).toBe("/dashboard");
        });

        it("blocks URL-encoded slashes and bypasses (/%2F%2Fevil.com, /%5Cevil.com)", () => {
            expect(resolveSafeRedirectPath("/%2F%2Fevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/%2f%2fevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/%5Cevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/%5c%5cevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/%252F%252Fevil.com")).toBe("/dashboard"); // double encoded
        });

        it("blocks pseudo-protocols and script/communication schemes (javascript:, data:, vbscript:, blob:, mailto:, tel:, sms:, urn:)", () => {
            expect(resolveSafeRedirectPath("javascript:alert(1)")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/javascript:alert(1)")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("data:text/html,<script>alert(1)</script>")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/data:text/html,<script>alert(1)</script>")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("vbscript:msgbox(1)")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/vbscript:msgbox(1)")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("blob:http://localhost/uuid")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("mailto:attacker@evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/mailto:attacker@evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("tel:+1234567890")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/tel:+1234567890")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("sms:+1234567890")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/sms:+1234567890")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("urn:isbn:0-486-27557-4")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/urn:isbn:0-486-27557-4")).toBe("/dashboard");
        });
    });

    describe("Adversarial Evasion: Unicode Homographs, Control Chars, Null Bytes & Max Length", () => {
        it("blocks Unicode slash homographs (Full-width solidus ／, Reverse solidus ＼)", () => {
            expect(resolveSafeRedirectPath("\uFF0F\uFF0Fevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\uFF0Fevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("\uFF3C\uFF3Cevil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\uFE68evil.com")).toBe("/dashboard");
        });

        it("blocks zero-width spaces and invisible characters (\u200B, \u200C, \u200D, \uFEFF)", () => {
            expect(resolveSafeRedirectPath("/\u200B/evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\uFEFF/evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\u200D/evil.com")).toBe("/dashboard");
        });

        it("blocks null bytes and control character injection (%00, \\x00, CRLF)", () => {
            expect(resolveSafeRedirectPath("/%00//evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\x00//evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/%0d%0a/evil.com")).toBe("/dashboard");
            expect(resolveSafeRedirectPath("/\r\n//evil.com")).toBe("/dashboard");
        });

        it("enforces MAX_URL_LENGTH (2048) to prevent ReDoS / CPU exhaustion", () => {
            const massiveUrl = `/workspace?param=${"x".repeat(3000)}`;
            expect(resolveSafeRedirectPath(massiveUrl)).toBe("/dashboard");
        });
    });
});

describe("Phase 12: Auth Callback Handler (/auth/callback)", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
        process.env.NEXT_PUBLIC_APP_URL = "https://app.lugx.com";
    });

    it("redirects to safe validated path upon successful OAuth code exchange", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/workspace/editor/doc-abc");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307); // NextResponse.redirect default status
        expect(res.headers.get("location")).toBe("https://app.lugx.com/workspace/editor/doc-abc");
        expect(mockExchangeCodeForSession).toHaveBeenCalledWith("auth_code_123");
        expect(mockSyncUserToDatabase).toHaveBeenCalled();
    });

    it("sanitizes open redirect target to /dashboard upon successful code exchange", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=https://evil.com/steal-session");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("sanitizes encoded protocol-relative payload to /dashboard", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/%2F%2Fattacker.com");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("rejects untrusted x-forwarded-host and anchors redirect to NEXT_PUBLIC_APP_URL", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/dashboard", {
            headers: {
                "x-forwarded-host": "attacker-spoofed-host.com",
            },
        });
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        // Location MUST be on trusted NEXT_PUBLIC_APP_URL, NOT attacker-spoofed-host.com
        expect(res.headers.get("location")).toBe("https://app.lugx.com/dashboard");
    });

    it("redirects to login error page when exchangeCodeForSession fails", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: { message: "Invalid auth code" } });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=invalid_code&redirectTo=/workspace");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/login?error=auth_failed");
    });

    it("redirects to login error page when code parameter is missing", async () => {
        const req = new NextRequest("https://app.lugx.com/auth/callback?redirectTo=/workspace");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/login?error=auth_failed");
        expect(mockExchangeCodeForSession).not.toHaveBeenCalled();
    });

    it("resists HTTP Parameter Pollution (HPP) when duplicate redirectTo params are supplied", async () => {
        mockExchangeCodeForSession.mockResolvedValueOnce({ error: null });
        mockSyncUserToDatabase.mockResolvedValueOnce({ success: true });

        const req = new NextRequest("https://app.lugx.com/auth/callback?code=auth_code_123&redirectTo=/workspace&redirectTo=https://evil.com");
        const res = await authCallbackGET(req);

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("https://app.lugx.com/workspace");
    });
});
