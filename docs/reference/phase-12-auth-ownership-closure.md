# Phase 12 Architecture & Verification Reference: Authentication, OAuth & Resource Ownership

## 1. Overview & Objectives

Phase 12 enforces deterministic security hardening across all authentication, OAuth callback, server actions, and API routes in LUGX. It eliminates Open Redirect and Host Header Injection vulnerabilities, and guarantees complete server-side user isolation with unified error handling to prevent resource enumeration.

---

## 2. Technical Architecture & Security Invariants

### 2.1. Safe Redirect Path Resolution (`resolveSafeRedirectPath`)

Located in [`src/lib/auth/safe-redirect.ts`](file:///d:/Projects/LUGX/src/lib/auth/safe-redirect.ts), this shared validator provides deterministic protection against all known redirect bypass techniques:

```typescript
export function resolveSafeRedirectPath(
    target: string | null | undefined,
    defaultPath: string = "/dashboard"
): string
```

#### Security Rules Enforced:
1. **Single Leading Slash:** Must begin with exactly one `/`. Rejects relative paths without leading slash (`dashboard`, `google.com`).
2. **Protocol-Relative & Universal Backslash Defense:** Rejects `//`, `/\`, `\\`, and any backslash character `\` occurring anywhere in the target or decoded path.
3. **Payload Length & ReDoS Guard:** Enforces `MAX_URL_LENGTH = 2048` characters upfront to eliminate CPU exhaustion and denial-of-service attempts.
4. **Unicode Normalization & Homograph Defense:** Applies `NFKC` normalization and explicitly rejects full-width solidus (`\uFF0F`), reverse solidus (`\uFF3C`), small reverse solidus (`\uFE68`), and zero-width bypass sequences (`\u200B-\u200D`, `\uFEFF`).
5. **Control Character & Null Byte Stripping:** Strips all ASCII control characters (`0x00-0x1F`, `0x7F`) and Unicode line/paragraph separators.
6. **Iterative Percent-Decoding:** Decodes up to 3 passes to identify obfuscated and double-encoded payloads (`/%2F%2Fevil.com`, `/%5Cevil.com`).
7. **Scheme, Communication & Pseudo-Protocol Rejection:** Blocks `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, `about:`, `mailto:`, `tel:`, `sms:`, `urn:`, and external protocols `http:`, `https:`.
8. **URL Constructor Verification:** Parses target against local dummy base (`http://localhost`) to verify origin integrity before returning the relative path, query, and hash.

### 2.2. OAuth Callback Hardening (`/auth/callback`)

The callback handler in [`src/app/auth/callback/route.ts`](file:///d:/Projects/LUGX/src/app/auth/callback/route.ts):
- Cleans and verifies `redirectTo` via `resolveSafeRedirectPath`.
- Replaces blind trust in `x-forwarded-host` with canonical trusted origin derived from `process.env.NEXT_PUBLIC_APP_URL || origin`.
- Constructs redirection URLs using standard `new URL(safeRedirectPath, trustedOrigin)`.
- Redirects failed exchanges exclusively to `new URL("/login?error=auth_failed", trustedOrigin)`.

### 2.3. Middleware Context & Deep Link Preservation

In [`src/middleware.ts`](file:///d:/Projects/LUGX/src/middleware.ts) *(Note: In Next.js 16, route protection and deep-link preservation are implemented in the Edge proxy at [`src/proxy.ts`](file:///d:/Projects/LUGX/src/proxy.ts))*:
- Preserves search queries on protected route redirects (`${request.nextUrl.pathname}${request.nextUrl.search}`) so users seamlessly retain their full editor / query state after authentication.

### 2.4. OAuth Client, User Sync & Dead Code Elimination

In [`src/server/actions/auth-actions.ts`](file:///d:/Projects/LUGX/src/server/actions/auth-actions.ts):
- `signInWithGoogle(redirectTo?: string)` verifies and resolves `redirectTo` with `resolveSafeRedirectPath` before appending to OAuth callback options.
- `syncUserToDatabase()` uses atomic single-step `db.insert(schema.users).values(...).onConflictDoUpdate(...)` on `users.id` and `.onConflictDoNothing()` on `schema.usage` to guarantee zero-race concurrency during rapid OAuth logins.
- Unused legacy email authentication functions (`signInWithEmail`, `signUpWithEmail`, `normalizeAuthKey`) have been permanently removed to eliminate dead attack surface.

### 2.5. Cross-User Resource Isolation & Unified Error Mapping (404 vs 403)

To prevent resource enumeration (attacker guessing foreign UUIDs by probing for 403 Forbidden vs 404 Not Found), all resource lookups enforce unified `not_found` (404) semantics:
- **File Operations (`createFile`, `copyFile`, `moveFile`, `getFile`, `updateFileContent`, `deleteFile`, `restoreFile`):**
  Parent folder checks and target file lookups return `status: "not_found"` when the row is not owned by the session user.
- **Hierarchy Traversal Cycle Safety (`file-ops.ts`):**
  `getDescendantIds` and `restoreFile` implement BFS queue traversal guarded with `visited = new Set<string>()` to eliminate infinite loops in the event of corrupt cyclic folder pointers.
- **File Import (`importFile`):**
  Returns `error: "Parent folder not found"` for non-existent or foreign parent folders.
- **AI Streaming (`/api/ai/stream`):**
  Enforces strict type validation on `fileId` (`typeof fileId === "string" && fileId.trim()`), returning `400 Bad Request` for non-string / malformed payloads. If `fileId` is provided, verifies that the file exists and is owned by `user.id`, returning `404 Not Found` if foreign or missing before performing quota reservations.
- **AI Commit (`commitAIFileOperation`):**
  Verifies reservation and file ownership conditioned on session user id (`eq(schema.aiReservations.userId, user.id)`).
- **Subscription Server Actions (`subscription-actions.ts`):**
  Removed `'use server'` directive so internal database mutation helpers (`updateUserTier`, `upsertSubscription`, `updateUserStripeCustomerId`, `cancelUserSubscription`) are purely server-side internal utilities and never exposed as client-callable RPC endpoints.
- **Storage Path Tenant Isolation (`src/lib/supabase/storage.ts`):**
  `assertSafeStoragePath(userId, path)` enforces that storage bucket operations strictly require the `userId/` prefix and reject directory traversal (`..`) sequences. *(Note: Supabase Storage was subsequently eliminated in Phase 14 ([`phase-14-supabase-storage-removal-closure.md`](./phase-14-supabase-storage-removal-closure.md)), dropping the `storage_path` database column and deleting `storage.ts` to store pure Markdown text directly in Neon PostgreSQL)*.

---

## 3. Verification & Test Evidence

### 3.1. Test Suites Executed

1. **`src/test/auth-redirect.test.ts` (21 tests, 100% passing)**
   - Internal relative routes with query params and hashes.
   - Null, empty, whitespace, and invalid paths.
   - Standard external URLs (`http`, `https`).
   - Protocol-relative URLs (`//evil.com`, `/\evil.com`, `\\evil.com`).
   - Universal backslash rejection in any position (`/foo\\bar`, `/workspace\\editor`).
   - Percent-encoded and double-encoded bypasses (`/%2F%2Fevil.com`, `/%5Cevil.com`).
   - Pseudo-protocols (`javascript:`, `data:`, `vbscript:`).
   - Unicode homographs (full-width solidus, small reverse solidus, zero-width characters).
   - Control characters and null-byte bypasses.
   - MAX_URL_LENGTH (2048) payload length guard.
   - `/auth/callback` route handler behavior with successful and failing code exchange.
   - Rejection of `x-forwarded-host` header spoofing.
   - HTTP Parameter Pollution (HPP) resistance.

2. **`src/test/cross-user-ownership.test.ts` (14 tests, 100% passing)**
   - `createFile` parent folder isolation between User A and User B.
   - `copyFile` destination folder isolation.
   - `moveFile` target parent folder isolation.
   - `getFile`, `updateFileContent`, `deleteFile` cross-user mutation immunity.
   - `importFile` foreign parent folder rejection.
   - `getAIReservationStatus` foreign reservation isolation (`found: false`, `reason: "not_found"`).
   - `commitAIFileOperation` foreign reservation rejection.
   - `/api/ai/stream` foreign `fileId` rejection with `404 Not Found`.
   - `/api/ai/stream` malformed/non-string `fileId` rejection with `400 Bad Request`.
   - High-concurrency atomic `syncUserToDatabase` UPSERT race test (10 parallel executions with zero constraint errors).
   - Storage path tenant isolation and directory traversal tests (`assertSafeStoragePath`) *(Note: pruned in Phase 14 clean-up)*.
   - Unauthenticated session invariants.

3. **Full Suite Regression (`npx vitest run`)**
   - **31 test files passed (384 tests total, 0 failures)** across all modules.

---

## 4. Closure Verdict

Phase 12 is **`CLOSED`**. All security gates, isolation invariants, edge cases, and test requirements are fully verified and passing.
