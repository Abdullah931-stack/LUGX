# Security Architecture & Rate Limiting

This document covers the cross-cutting security layers of the LUGX platform:
request authentication, rate limiting, content sanitization, local data
encryption, and the protected maintenance cron. Everything here is derived from
the current source files referenced inline.

---

## 1. Request Authentication (`src/middleware.ts`)

The Next.js middleware runs on every route except static assets (see its
`config.matcher`). Behavior:

| Concern | Implementation |
| :--- | :--- |
| Protected pages | `/workspace`, `/account`, `/dashboard` require a Supabase session (`supabase.auth.getUser()`); unauthenticated page navigations redirect to `/login?redirectTo=…` (preserving search params / deep links) |
| Server Actions & API routes | Under the same protected paths, an unauthenticated request receives a **JSON `401 Unauthorized`** instead of an HTML redirect (an HTML redirect breaks the Server Action client runtime) |
| Logged-in access control | Authenticated users hitting `/login` are redirected to `/dashboard` |
| OAuth code interception | Any request carrying an OAuth `code` query param is redirected to `/auth/callback`, unless it already targets that path |
| Session refresh | The middleware refreshes the Supabase session cookie on every matched request |

### 1.1. Open Redirect & Host Header Injection Hardening (`src/lib/auth/safe-redirect.ts`)

All redirect parameters entering the authentication pipeline are strictly validated by `resolveSafeRedirectPath(target, defaultPath)`:
- **MAX_URL_LENGTH = 2048**: Enforces upfront bounds to prevent ReDoS/CPU exhaustion.
- **Universal Backslash Rejection**: Rejects any occurrence of `\` in the target or decoded representation.
- **Unicode Normalization (`NFKC`)**: Rejects homographs (full-width solidus `／`, reverse solidus `＼`, small solidus `﹨`) and zero-width characters (`\u200B-\u200D`, `\uFEFF`).
- **Control Character & Null-Byte Stripping**: Strips ASCII `0x00-0x1F`, `0x7F`, and blocks null-byte/CRLF injection.
- **Iterative 3-Pass Decoding**: Prevents multi-encoded bypasses (`/%2F%2Fevil.com`).
- **Scheme & Protocol Rejection**: Rejects `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, `about:`, `mailto:`, `tel:`, `sms:`, `urn:`, and external protocols `http:`, `https:`.
- **OAuth Callback (`/auth/callback`)**: Redirection targets are anchored exclusively to trusted origins (`process.env.NEXT_PUBLIC_APP_URL || origin`), completely ignoring spoofable `x-forwarded-host` headers.

### 1.2. Cross-User Resource Isolation & Anti-Enumeration (404 vs 403)

To prevent resource enumeration (probing for valid UUIDs via 403 vs 404 responses), all lookups across `file-ops.ts`, `import-file.ts`, and `stream/route.ts` return unified `404 Not Found` responses when foreign/unauthorized resources are accessed.

Defense-in-depth note: middleware gating complements — never replaces — the
per-route `getUser()` checks performed inside every API route and server action
(see [`file-ownership-and-versioning.md`](./file-ownership-and-versioning.md) and [`../reference/phase-12-auth-ownership-closure.md`](../reference/phase-12-auth-ownership-closure.md)).

---

## 2. Rate Limiting (`src/lib/rate-limit.ts`)

A per-user **sliding-window counter** backed by Upstash Redis. Configuration:

```ts
export const RATE_LIMITS = {
    SYNC_API: { limit: 100, windowSeconds: 15 * 60 }, // sync endpoint
    FILE_API: { limit: 200, windowSeconds: 15 * 60 }, // single-file GET/PUT
    GENERAL:  { limit: 300, windowSeconds: 15 * 60 },
    AUTH:     { limit: 20,  windowSeconds: 15 * 60 }, // sign-in/sign-up brute-force guard
} as const;
```

Exported limiter instances and their consumers:

| Instance | Key prefix | Used by |
| :--- | :--- | :--- |
| `syncApiRateLimiter` | `sync` | `GET /api/files/sync` |
| `fileApiRateLimiter` | `file` | `GET` / `PUT /api/files/[id]` |
| `authRateLimiter` | `auth` | authentication endpoints |

Response contract:

- Success responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` (set by `addRateLimitHeaders()`).
- Exhaustion returns **429** from `rateLimitExceededResponse()` with a
  `Retry-After` header and body `{ error, message, retryAfter }`.

Endpoint-level details: [`../reference/SYNC_API.md`](../reference/SYNC_API.md).

---

## 3. Content Sanitization & Markdown Normalization (Data Safety & XSS Defense)

Documents in LUGX are stored and processed as pure UTF-8 Markdown text (`MarkdownSource`). Content integrity and safety are enforced at both the Markdown normalization layer and the HTML sanitization defense-in-depth layer.

### 3.1 Markdown Source Normalization (`src/lib/sync/etag-generator.ts`)
- **Universal Normalization (`normalizeMarkdownSource`)**: Canonical normalization converting `\r\n` and `\r` to LF (`\n`), applying Unicode NFC normalization, and stripping null bytes (`\0`) to guarantee PostgreSQL text encoding safety and deterministic cross-platform ETag generation.

### 3.2 Server Sanitization Chokepoint (`src/lib/sanitize.server.ts`)
- DOMPurify running against a jsdom window; used by AI preview formatting, live preview rendering, and exporter pipelines.
- Allow-listed tags (`SANITIZE_ALLOWED_TAGS`): `p, br, h1–h6, strong, em, u, s, strike, ul, ol, li, blockquote, code, pre, hr, a, img, table, thead, tbody, tr, th, td, div, span`.
- Allowed attributes (`SANITIZE_ALLOWED_ATTR`): `href, src, alt, title, class, id, target, rel`.
- `style` attributes are **deliberately excluded** — inline styles can smuggle `javascript:` URIs that DOMPurify does not reliably strip; any inline styling from imports/previews is discarded (fail-safe).

### 3.3 Browser Path (`src/lib/sanitize-client.ts`)
Same sanitization semantics using the native browser DOM (no jsdom in the client bundle). Package exports map `@/lib/sanitize` to the correct implementation per environment.

---

## 4. Local Data Encryption (`src/lib/sync/encryption.ts`)

Client-side encryption of IndexedDB payloads for sensitive documents:

- Algorithm: **AES-GCM 256-bit** with a random 12-byte IV per payload.
- Key derivation: **PBKDF2**, 100,000 iterations, SHA-256, random 16-byte salt
  (`deriveKeyFromPassword`).
- Output envelope (`EncryptedData`): `{ ciphertext, iv, algorithm, version: 1 }`
  to keep future algorithm migrations explicit.

---

## 5. Protected Maintenance Cron (`src/app/api/cron/purge-deleted/route.ts`)

Permanent purge of soft-delete tombstones past retention:

| Property | Value |
| :--- | :--- |
| Retention window | 30 days (`RETENTION_DAYS`) after `deleted_at` |
| Authorization | Shared secret: `Authorization: Bearer $CRON_SECRET`; fails closed with 401 when `CRON_SECRET` is unset or mismatched |
| Bounded batches | Deletes at most **500 rows per run** via a `WITH doomed AS (… LIMIT 500) DELETE … USING` CTE (Drizzle's builder has no `.limit()`) |
| Idempotency | Re-running only deletes rows already past the cutoff |
| Scheduling | Invoked externally (GitHub Actions daily workflow `.github/workflows/cron.yml`); failures never break the CI pipeline |

The application itself never hard-deletes user content outside this route — all
user-facing deletions are tombstones
([`records/test-database-safety.md`](../records/test-database-safety.md)).

---

## 6. Verification

```bash
npx vitest run src/test/auth-redirect.test.ts                  # open redirect & OAuth security
npx vitest run src/test/cross-user-ownership.test.ts           # cross-user isolation & atomic sync
npx vitest run src/app/api/files/[id]/route.putguard.test.ts   # auth + rate-limit + version guards
npx vitest run src/server/actions/file-ops.ownership.test.ts   # ownership isolation
npx tsc --noEmit                                               # type safety gate
```
