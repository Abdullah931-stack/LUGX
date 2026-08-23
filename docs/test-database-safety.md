# Test Database Safety — Incident Record & Cleanup Architecture

Status: ✅ Closed (2026-08-23) · Related: `TECHNICAL_DEBT_REGISTER.md` (TD-01), `ai-quota-reservation-lifecycle.md`

---

## 1. Incident Summary

**Reported symptom:** a file created through the app disappeared permanently from
both the workspace UI **and** the Neon database after the session/device was closed
for a while and the user logged back in.

**Root cause (confirmed, closed):** integration-test cleanup hooks executed
**unscoped table-wide deletes against the live production database**:

| File | Statement | Effect |
|---|---|---|
| `src/server/actions/ai-ops.integrity.test.ts` (`afterAll`) | `testDb.delete(schema.usage)` + `testDb.delete(schema.files)` | Wiped the ENTIRE `usage` table and EVERY file row of EVERY user |
| `src/server/actions/file-ops.softdelete.test.ts` (`afterAll`) | `testDb.delete(schema.files)` | Same full-table wipe |

**Why it hit production data:** `vitest.setup.ts` loads `.env.local`
(`override: true`) before tests run, so the pg-backed `testDb` connects to the same
live Neon `DATABASE_URL` the app uses. Every `npx vitest run` physically hard-deleted
all file rows and all daily quota counters. Production code paths were never at fault
— all app-side deletions are soft tombstones; the only production hard-delete is the
secret-protected 30-day purge cron.

---

## 2. Remediation Applied

### A. Scoped destructive statements
Both unscoped wipes are now conditioned on their fixed test user:
```ts
await testDb.delete(schema.usage).where(eq(schema.usage.userId, TEST_USER_ID));
await testDb.delete(schema.files).where(eq(schema.files.userId, TEST_USER_ID));
```

### B. Guarded account cleanup — `cleanupTestUsers()` (`src/test/test-db.ts`)
```ts
cleanupTestUsers(ids: readonly string[], options?: { emailPattern?: string })
```
- Deletes ONLY rows matching:
  - placeholder UUIDs passed explicitly by the calling suite, validated by
    `assertPlaceholderUserIds()` against `PLACEHOLDER_UUID_PATTERN`
    (`/^(\d{4})\1-\1-\1-\1-\1{3}$/` → `1111…`, `1212…`, …), and/or
  - emails under the RFC 2606-reserved `.test` domain (used by suites that mint
    random per-run accounts).
- Schema FKs (`files`, `usage`, `ai_reservations`) reference `users.id` with
  `ON DELETE CASCADE`, so dependents are removed in the same statement.
- Wired into all 8 user-seeding suites in their `afterAll`, **each passing exactly
  its own ids**.

### C. Per-suite id ownership (parallel-worker safety)
Vitest runs suites in parallel workers against the same DB. During rollout, a global
allowlist cleanup deleted another suite's seeded user mid-run and broke its tests.
Rule adopted: **a suite may only clean up the accounts it seeds itself.**
Consequently the refund suite's constant was de-conflicted from `2222…` (shared with
softdelete tests) to `1212…`.

---

## 3. Rules for Future Tests

1. NEVER issue a `DELETE` / `UPDATE` without a `WHERE` scoped to a placeholder test
   id (or an owned `.test` email pattern). Full-table wipes are forbidden.
2. New seeded accounts MUST use either a placeholder-pattern UUID or an
   `<anything>.test` email, and MUST be removed via `cleanupTestUsers([ownIds])`.
3. Never add a real-looking UUID to any cleanup call — the guard will reject it,
   and the suite will fail loudly instead of deleting live data.
4. Remember suites run in parallel: touch only your own rows.

## 4. Verification Utility

```bash
node scripts/db-testusers-probe.mjs
```
Reports `PLACEHOLDER_IDS`, `DOT_TEST_EMAILS`, `TOTAL_USERS`, and lists leftovers.
Post-fix verification across a full parallel run: `0 / 0`, real users untouched.

## 5. Recovery of Historically Lost Rows

Rows destroyed by the incident were hard-deleted. If anything valuable was lost,
Neon Console → **Restore / Point-in-Time Reset** to a timestamp preceding the last
unscoped test run remains the only recovery path.