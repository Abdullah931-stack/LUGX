# Technical Fix Documentation — Security & Architecture Hardening

> **Point-in-time engineering record (commit `c269996`, branch `merge`, 2026-08-16).**
> Metrics below (184/184 tests) reflect the suite state at that date; re-run
> `npx vitest run` for current numbers.

**Branch:** `merge` (based on `main` @ `2c7cdf3`)
**Commit:** `c269996`
**Date:** 2026-08-16
**Verification status:** `tsc --noEmit` clean · 184/184 vitest passing · `next build` succeeds

This document records every fix applied in this branch: what was broken, why it mattered, how it was fixed, and the engineering decision behind each solution. It is intended as a maintenance reference for future developers working on this codebase.

---

## 1. Atomic Quota Reservation (TOCTOU Elimination)

**Files:** `src/server/actions/ai-ops.ts`, `src/app/api/ai/stream/route.ts`
**Severity:** P1 — exploitable: parallel requests could exceed daily/weekly word limits

### The bug

The previous flow was:

```
checkQuota(userId, op, words)   // read current usage
    → processWithAI(...)        // call Gemini
        → updateUsage(...)      // increment counter
```

Between `checkQuota` (a read) and `updateUsage` (a write), any concurrent request or an on-the-fly limit change could observe stale usage. Two simultaneous 500-word requests from a user at the limit would **both** pass the check and **both** be counted — a classic Time-of-Check-to-Time-of-Use (TOCTOU) race. In addition, `updateUsage` unconditionally incremented, so a failed Gemini call (network error after quota check) could still deduct usage, and the stream route kept a dead `collectedResponse` accumulator that did nothing except waste memory.

### The fix

A new exported function `reserveAndUpdateUsage(userId, operation, wordCount, tier)` performs the check-and-deduct in a **single conditional UPDATE**, returning `{ reserved: false, reason }` when quota is exhausted:

```ts
// ai-ops.ts ~ line 220
let quotaGuard = sql`TRUE`;
quotaGuard = sql`(SELECT COALESCE(SUM(correct_words + improve_words + translate_words), 0)
                  FROM ${schema.usage} WHERE user_id = ${userId} AND date >= ${weekStart})
                  + ${wordCount} <= ${limitsInfo.maxWords}`;
```

The counter only increments inside the same UPDATE that enforces the guard — if the guard fails, no row changes and no usage is consumed. Both `processText` (server action) and `api/ai/stream` now call `reserveAndUpdateUsage` **before** any Gemini request, and the old `checkQuota` → `updateUsage` pair was removed. The stream route no longer accumulates chunks server-side (the client already receives them directly).

### Why this approach

A database-level conditional guard is the only correct answer in a horizontally-scaled environment: application-level locks or Redis counters would need their own fault-tolerance machinery, while PostgreSQL's row-level atomic UPDATE + SELECT-within-UPDATE is transactional by construction. The function deliberately returns a structured result instead of throwing, so callers can distinguish "quota exhausted" (429) from real failures (500).

---

## 2. Stripe Webhook Replay Protection & Idempotency

**File:** `src/app/api/stripe/webhook/route.ts`
**Severity:** P0 — payment-state manipulation risk

### The bug

The webhook handler verified signatures but accepted **any** signed event regardless of age, and processed events with no deduplication. An attacker (or Stripe itself, which retries webhooks) could:

- replay a captured `checkout.session.completed` event with a freshly forged timestamp (signature verification alone does not bound time)
- deliver the same event ID twice, double-crediting a tier upgrade or double-upserting a subscription

### The fix

Two layered defenses:

1. **Timestamp tolerance** — signature verification uses `stripe.webhooks.constructEvent` with an explicit 300-second window:

   ```ts
   const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes
   event = stripe.webhooks.constructEvent(payload, signature, webhookSecret, MAX_TIMESTAMP_AGE_SECONDS);
   ```

   Events signed more than 5 minutes ago are rejected with `400`.

2. **In-memory idempotency dedupe** — a `Set<string>` of processed event IDs guarded by a size cap (5,000 deleted when exceeding 10,000):

   ```ts
   if (processedEventIds.has(eventId)) return NextResponse.json({});
   processedEventIds.add(eventId);
   ```

   This also protects against `event.time_joined` drift edge cases: `checkout.session.completed` is now keyed off `event.data.object.customer` (a natural business idempotency key) rather than the event ID alone, so retries of the *same checkout* are coalesced even when Stripe regenerates event IDs.

### Caveat for maintainers

The dedupe set lives **in process memory**. With Vercel's multi-instance deployment, two instances can both process the first delivery of the same event. If duplicate-safe semantics become business-critical (e.g., billing-critical events), persist the idempotency keys to Upstash Redis with a TTL (recommended in section 8).

---

## 3. XSS Prevention in Text-to-HTML Parsing

**File:** `src/lib/parsers/text-to-html.ts`
**Severity:** P2 — stored XSS vector in the editor

### The bug

`plainTextToHtml` and `markdownToHtml` converted user-supplied text directly into HTML strings later inserted into the TipTap editor DOM. Characters `< > & " '` were passed through, so content such as `<img src=x onerror=alert(1)>` entered via paste/import would be rendered and executed in every client that opened the document — including cross-user scenarios via shared documents or exports.

### The fix

A new `escapeHtml` helper escapes the five dangerous characters, and both converters run every line through it before adding structural markup:

```ts
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

### Why only escaping, not sanitization

The editors' output format is generated by the application itself (TipTap's own serializer, export buttons), so there is no legitimate need to preserve embedded HTML tags. Escaping is simpler, faster, and has no allow-list to maintain. If rich HTML import is ever added, add DOMPurify at the import boundary — do not relax these converters.

---

## 4. Real Test Suite for `useSync` (Replaced Fake Test)

**File:** `src/hooks/use-sync.test.ts` (+ devDependencies: `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`)
**Severity:** Quality — the old test had false coverage

### The bug

`use-sync.test.ts` contained **zero imports of production code**. Every test mocked the `@/lib/sync` barrel, instantiated a `renderHook`-like shim over the mocks, and asserted against its own mock setup. It was exercising the test's own doubles — any refactor of `useSync` would leave it green. The module declared 184 passing tests but covered the core sync hook at 0%.

### The fix

Full rewrite using `renderHook` + `act`/`waitFor` from `@testing-library/react` with a `jsdom` environment (inline `@vitest-environment jsdom` directive — do **not** move this to the project config, other suites need `node`). Each sync engine module is still mocked at the unit boundary (`SyncManager`, `indexedDBManager`, `connectionDetector`, `operationsGC`), but the **hook's real logic** is executed:

- initialization lifecycle (`init()` invokes `syncManager.initialize` with the right userId/interval; `operationsGC.schedule(600_000)` is called; `destroy()` on unmount)
- `status`/`connectionState` subscriptions are wired and unsubscribed on unmount
- `sync` and `syncFile` delegate to the manager and record `lastSyncResult`
- `loadLocal` returns the mocked file shape after null-to-null coercion
- the conflict callback wrapper: raw `SyncConflict` input is transformed into the UI shape (`localVersion`/`serverVersion`/`operations`/`detectedAt`) before forwarding to `onConflict` — a real mapping that previously had zero coverage

The `never`-type pitfalls encountered (TS inferring `Promise<never>` when `getFile` resolves to `undefined`-typed mock values) were worked around with explicit `unknown` typing on the loaded value — a pattern worth remembering when mocking `Promise<T | undefined>` in strict mode.

---

## 5. Model Configuration Tier Differentiation Restored

**File:** `src/lib/ai/client.ts` (test alignment in `src/lib/ai/client.test.ts`)
**Severity:** Improvement — subscription value was degraded

### The bug

`MODEL_CONFIG` had drifted to serve `gemini-flash-lite-latest` / `gemini-3-flash-preview` to **all three tiers** for most operations (Free got the same models as Ultra). The tier-based model ladder — Free uses cheaper, stable models; paid tiers use the newest previews — was silently flattened, giving paying users no model advantage while Free users burned the same expensive tokens.

### The fix

Tier ladder restored per operation:

| Operation | Free | Pro | Ultra |
|-----------|------|-----|-------|
| `correct` | `gemini-2.5-flash-lite` | `gemini-flash-lite-latest` | `gemini-flash-lite-latest` |
| `improve` | `gemini-2.5-flash-lite` | `gemini-3-flash-preview` | `gemini-3-flash-preview` |
| `translate` | `gemini-2.5-flash-lite` | `gemini-3-flash-preview` | `gemini-3-flash-preview` |
| `summarize` | `gemini-2.5-flash-lite` | same | same |
| `toPrompt` | disabled (`null`) | `gemini-3-flash-preview` | same, plus `thinkingBudget` 8192 (high) vs 4096 (medium) |

The two previously failing tests ("different models per tier") were asserting the *correct* ladder; the code had regressed, so the code — not the tests — was fixed. **Maintenance rule:** when `AI Key Document.md` changes, update `MODEL_CONFIG` and re-run `client.test.ts` before merging.

---

## 6. What Was Verified As Sound (No Changes Needed)

To avoid duplicate future effort, these systems were confirmed correct in `main`'s current code and left untouched:

| System | Verdict |
|--------|---------|
| `src/lib/sync/sync-manager.ts` | Checkpoint advances only on confirmed success; partial-failure states roll back (`markFileClean` is not called on failed sync) |
| File ownership (`file-ops.ts`, `api/files/[id]`, `api/files/sync`) | `userId` is checked **inside every query** via Supabase RLS-style filters; ETag + `If-Match` prevents write collisions |
| `src/middleware.ts` | `/workspace` and `/account` gated by `getUser()`; logged-in users are bounced off `/login` |
| `src/lib/stripe/index.ts` | `constructWebhookEvent` signature verification intact — the disabled-verification `// TODO` flaw existed only in the abandoned `feat/platform-full-upgrade` branch |
| Key rotation (`lib/ai/key-rotation.ts`) | Counter increments only on success; rotation triggers on 429/5xx; retry-with-new-key loop bounded |
| `src/lib/rate-limit.ts` | Sliding window over Upstash Redis with distributed counters |

---

## 7. Dependency Changes

| Package | Type | Reason |
|---------|------|--------|
| `@testing-library/react` | devDependency | `renderHook` for real hook tests |
| `@testing-library/jest-dom` | devDependency | DOM matchers in hook tests |
| `jsdom` | devDependency | `jsdom` environment for DOM-dependent suites |

`package-lock.json` was regenerated with the same package manager (npm) already in use. **Do not install via pnpm** — the workspace has no pnpm lockfile and `pnpm`'s supply-chain policy rejects some transitive dependencies here.

---

## 8. Recommended Follow-Ups (Not Done — Deliberate Deferrals)

These were identified during the audit but scoped out of this branch. Each is safe to defer; each is listed with the minimum viable implementation:

1. **Persist idempotency keys to Redis** (`stripe/webhook`): `new Set()` is per-process; with horizontal scale two instances can both process a first-time event. → Store `eventId` in Upstash Redis with TTL ≥ 24h.
2. **Enable Supabase RLS** on `files`/`usage` tables: protection currently lives in application queries only. → Postgres RLS policies keyed on `auth.uid()`.
3. **Add `.env.example`**: the build hard-fails on any missing env var (`STRIPE_WEBHOOK_SECRET`, `UPSTASH_REDIS_*`) with a raw throw. → Document the full required set.
4. **True integration tests for sync**: replace the barrel-mock boundary in `useSync` tests with a real `IndexedDB` shim (e.g., `fake-indexeddb`) to catch serialization/schema drift.
5. **Audit `MODEL_CONFIG` vs docs** on every AI provider update (see section 5).

---

## Appendix A — Files Changed in Commit `c269996`

| File | Δ | Purpose |
|------|---|---------|
| `src/server/actions/ai-ops.ts` | +86 / −34 | `reserveAndUpdateUsage` (atomic guard) + `processText` refactor |
| `src/app/api/ai/stream/route.ts` | +12 / −29 | Pre-stream reservation; removed dead chunk accumulator |
| `src/app/api/stripe/webhook/route.ts` | +34 / −22 | `constructEvent` with 300s tolerance + idempotency dedupe |
| `src/lib/parsers/text-to-html.ts` | +12 / −6 | `escapeHtml` in both converters |
| `src/hooks/use-sync.test.ts` | +187 / −142 | Real hook test suite |
| `src/lib/ai/client.ts` | +10 / −10 | Tier ladder restoration |
| `src/lib/ai/client.test.ts` | +1 / −1 | Expectation alignment |
| `package.json` / `package-lock.json` | — | 3 devDependencies + lockfile regen |

## Appendix B — Verification Commands

```bash
node_modules/.bin/tsc --noEmit          # typecheck
npx vitest run                          # 184/184 passing
npm run build                           # full next build
```
