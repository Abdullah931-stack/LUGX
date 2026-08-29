# Technical Debt Register

Living register of known technical debt, accepted risks, and deferred work.
Each entry records the decision owner and the mitigation currently in place.
Last reviewed: 2026-08-29 (post Node 22 upgrade & CI hermeticity round).

---

## TD-01 — Integration tests run against the live database — ✅ RESOLVED (2026-08-24)

- **Original debt:** `vitest.setup.ts` loaded `.env.local`, so DB integration suites executed
  against the same Neon instance as the app instead of an isolated test branch
  (`TEST_DATABASE_URL` / Neon branch).
- **Decision reversal:** the earlier "isolation declined" decision is REVERSED
  (owner: project lead). Phase 10 closed on 2026-08-24 with full isolation:
  every Postgres-backed suite now runs exclusively on a dedicated Neon branch
  (`TEST_DATABASE_URL`) behind a fail-closed guard, and unit/contract suites
  are structurally separated from LIVE suites (`npm run test` vs `npm run test:live`).
- **Second layer retained (not a substitute):** placeholder-pattern scoping,
  guarded `cleanupTestUsers()`, per-suite id ownership, and probe utility
  `scripts/db-testusers-probe.mjs` remain as defense-in-depth.
- Full architecture, guard rules and closure evidence:
  [`reference/test-database-isolation.md`](reference/test-database-isolation.md).
  Background incident: [`records/test-database-safety.md`](records/test-database-safety.md).

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

## TD-04 — Pre-existing lint errors in two legacy test files — ✅ RESOLVED (2026-08-25)

- **Debt:** `file-ops.ownership.test.ts` (3× `no-explicit-any`, unused import) and
  `ai-atomic-commit.integration.test.ts` (1× `no-explicit-any`, unused imports)
  fail strict ESLint rules.
- **Resolution:** fixed in the Phase 11 debt-cleanup round — cycle-detection maps now
  use a typed `CycleFolderRow` alias instead of `any`, unused imports pruned
  (`generateETagSync`, `and`, `isNull`), and the Supabase session mock cast via
  `Awaited<ReturnType<typeof getUser>>`. `npx eslint` exits clean on both files.

## TD-05 — Stop-action settlement latency

- **Debt:** "Stop Generation" awaits the quota settlement round-trip
  (~100–300 ms) before aborting the upstream stream, so the server-side
  disconnect refund deterministically no-ops with `already_committed`.
- **Status:** accepted trade-off for policy determinism
  ([`architecture/ai-quota-reservation-lifecycle.md`](architecture/ai-quota-reservation-lifecycle.md) §4-D).

## TD-06 — Dead `'error'` member in the `SyncStatus` union — ✅ RESOLVED (2026-08-25)

- **Debt:** `SyncStatus` (`src/lib/sync/sync-manager.ts`) declares an `| 'error'`
  state, but no code path ever calls `setStatus('error')`. The manager emits only
  `idle`, `loading`, `queued`, `syncing`, `conflict`, `failed`, `stopped`, and
  `offline`. The sync state-machine documentation therefore (correctly) omits it.
- **Impact:** none at runtime today; the dead union member invites future misuse
  and confuses consumers switching exhaustively on the status.
- **Resolution:** the dead member was removed in the Phase 11 debt-cleanup round.
  Repo-wide audit found zero producers/consumers of `SyncStatus['error']`; every
  other `'error'` literal belongs to the unrelated `FileOpResult.status` union.
  If a terminal sync-error state is ever needed, re-add it together with a real
  transition and consumer coverage.
  The exhaustive `Record<SyncStatus, ...>` display map in `sync-indicator.tsx`
  was trimmed of its dead `error` row accordingly.

## TD-07 — Real-browser E2E coverage for editor recovery journeys (deferred to Phase 19)

- **Debt:** Phase 11 closure proves reload-during-preview and
  navigation-during-commit semantics via jsdom integration suites
  (`editor-recovery-reload.test.ts`, extended `editor-orchestration.integration.test.ts`)
  plus a documented manual checklist — but there are no automated real-browser
  journeys yet (`@playwright/test` is intentionally introduced only in Phase 19).
- **Interim mitigation:** jsdom hard-reload simulation is semantically faithful
  (zero in-memory state survives; recovery runs from sessionStorage seeds), and
  the unload-warning path is asserted directly against `beforeunload`.
- **Decision:** deferred by project lead (2026-08-24). Unblocked when Phase 19
  adds Playwright + webServer harness; then port the three manual-checklist
  scenarios into automated E2E specs.

## TD-08 — Database Driver Protocol Mismatch in CI Containers — ✅ RESOLVED (2026-08-29)

- **Debt:** `src/lib/db/index.ts` was hardcoded to `@neondatabase/serverless` (`neon-http`), which dispatches queries over HTTPS port 443. When running inside GitHub Actions CI service containers or local Docker (`postgres:16-alpine`), connections failed with `ECONNREFUSED ::1:443`.
- **Resolution:** Replaced with a Smart Hybrid Database Client in `src/lib/db/index.ts` that dynamically detects the target host: uses `neon-http` for Neon Cloud and standard `pg.Pool` (`drizzle-orm/node-postgres`) over TCP on port 5432 for local Docker and CI containers. All 6 stages of the CI pipeline pass deterministically.