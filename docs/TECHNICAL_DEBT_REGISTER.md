# Technical Debt Register

Living register of known technical debt, accepted risks, and deferred work.
Each entry records the decision owner and the mitigation currently in place.
Last reviewed: 2026-08-23 (release 1.6.0).

---

## TD-01 — Integration tests run against the live database

- **Debt:** `vitest.setup.ts` loads `.env.local`, so DB integration suites execute
  against the same Neon instance as the app instead of an isolated test branch
  (`TEST_DATABASE_URL` / Neon branch).
- **Decision:** isolation **declined** for now (owner: project lead).
- **Mitigations in place:** all destructive test statements are scoped to
  placeholder-pattern accounts; guarded `cleanupTestUsers()`; per-suite id
  ownership; probe utility `scripts/db-testusers-probe.mjs`.
  Full background: [`records/test-database-safety.md`](records/test-database-safety.md).

## TD-02 — Quota TTL sweeper is not wired to any scheduler

- **Debt:** `expireStaleReservations()` (`ai-ops.ts`) transitions abandoned
  `reserved` rows to `expired` and restores counters, but nothing in production
  invokes it (no cron, no route). Abandoned reservations linger as `reserved`.
- **Impact:** cosmetic row accumulation only — quota accounting already deducts at
  reservation time and refunds/settlements are explicit.
- **Note:** safe to wire later (cron/route). Under the Explicit Settlement Policy,
  user-settled reservations are `committed` and therefore immune to the sweeper.

## TD-03 — No audit trail for destructive database operations

- **Debt:** there is no audit log capturing who/what triggered deletions or
  tombstones (a trigger-based `files_audit` table was proposed).
- **Decision:** **declined** for now (owner: project lead) to avoid extra write
  load on Neon for prevention of a since-resolved issue.

## TD-04 — Pre-existing lint errors in two legacy test files

- **Debt:** `file-ops.ownership.test.ts` (3× `no-explicit-any`, unused import) and
  `ai-atomic-commit.integration.test.ts` (1× `no-explicit-any`, unused imports)
  fail strict ESLint rules.
- **Status:** open; pre-dates release 1.6.0 and left untouched intentionally.

## TD-05 — Stop-action settlement latency

- **Debt:** "Stop Generation" awaits the quota settlement round-trip
  (~100–300 ms) before aborting the upstream stream, so the server-side
  disconnect refund deterministically no-ops with `already_committed`.
- **Status:** accepted trade-off for policy determinism
  ([`architecture/ai-quota-reservation-lifecycle.md`](architecture/ai-quota-reservation-lifecycle.md) §4-D).

## TD-06 — Dead `'error'` member in the `SyncStatus` union

- **Debt:** `SyncStatus` (`src/lib/sync/sync-manager.ts`) declares an `| 'error'`
  state, but no code path ever calls `setStatus('error')`. The manager emits only
  `idle`, `loading`, `queued`, `syncing`, `conflict`, `failed`, `stopped`, and
  `offline`. The sync state-machine documentation therefore (correctly) omits it.
- **Impact:** none at runtime today; the dead union member invites future misuse
  and confuses consumers switching exhaustively on the status.
- **Decision:** open — either wire a genuine terminal-error transition or remove
  the member in a future cleanup pass. Do not document `'error'` as a live state
  until one of the two happens.