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

## TD-07 — Real-browser E2E coverage for editor recovery & vault encryption journeys (deferred to Phase 19)

- **Debt:** Phase 11 closure proves reload-during-preview and
  navigation-during-commit semantics via jsdom integration suites
  (`editor-recovery-reload.test.ts`, extended `editor-orchestration.integration.test.ts`)
  plus a documented manual checklist. Similarly, Phase 18/Vault encryption journeys
  (vault unlock, 6-digit PIN verification, device trust enrollment/revocation,
  and cross-tab inactivity locking) are verified through comprehensive jsdom and WebCrypto
  integration tests (629 tests across 45 suites) — but there are no automated real-browser
  journeys yet (`@playwright/test` is intentionally introduced only in Phase 19).
- **Interim mitigation:** jsdom hard-reload simulation is semantically faithful
  (zero in-memory state survives; recovery runs from sessionStorage seeds), and
  the unload-warning path is asserted directly against `beforeunload`. Vault cryptographic
  integrity (AES-GCM-256, AAD binding, PBKDF2-HMAC-SHA256, and IndexedDB transactions)
  is verified deterministically with 100% pass rate in local Node/WebCrypto test environments.
- **Decision:** deferred by project lead (2026-08-24, reaffirmed for Vault in 2026-09-05). Unblocked when Phase 19
  adds Playwright + webServer harness; then port the manual checklists and end-to-end vault
  lifecycle scenarios into automated E2E specs.

## TD-08 — Database Driver Protocol Mismatch in CI Containers — ✅ RESOLVED (2026-08-29)

- **Debt:** `src/lib/db/index.ts` was hardcoded to `@neondatabase/serverless` (`neon-http`), which dispatches queries over HTTPS port 443. When running inside GitHub Actions CI service containers or local Docker (`postgres:16-alpine`), connections failed with `ECONNREFUSED ::1:443`.
- **Resolution:** Replaced with a Smart Hybrid Database Client in `src/lib/db/index.ts` that dynamically detects the target host: uses `neon-http` for Neon Cloud and standard `pg.Pool` (`drizzle-orm/node-postgres`) over TCP on port 5432 for local Docker and CI containers. All 6 stages of the CI pipeline pass deterministically.

## TD-09 — Rollup Mixed Exports and Vite ConfigLoader Native Deprecation Warnings — ✅ RESOLVED (2026-09-05)

- **Debt:** Running `npm run test` triggered two terminal warnings:
  1. `[MIXED_EXPORTS] Entry module "vitest.config.ts" is using named and default exports together.`
  2. `(!) Your Vite config uses features that are unsupported by 'configLoader: native'... ESM syntax in a file loaded as CommonJS...`
- **Resolution:**
  - Extracted shared test suite arrays (`LIVE_TEST_FILES`, `CLOUD_E2E_FILES`) into a dedicated Single Source of Truth (`vitest.constants.mts`), restricting config files strictly to default exports (`export default defineConfig(...)`).
  - Migrated configuration files to Native ESM (`vitest.config.mts` and `vitest.live.config.mts`), replaced CommonJS `__dirname` with standard `import.meta.dirname`, and specified explicit `.mjs` import extensions for TypeScript module resolution.
  - Silenced all terminal warnings with zero collateral impact on root Next.js CommonJS toolchains. All 44 test files and 617 tests execute cleanly with zero warnings.

## TD-10 — Offline Extraction of IndexedDB Device Trust Envelope (Accepted Risk for PIN / Mitigated via WebAuthn PRF)

- **Debt:** In "Trust This Device" mode when selecting the software 6-digit PIN option, the Master Key is wrapped via PBKDF2-HMAC-SHA256 (600,000 iterations) and persisted in browser `IndexedDB` (`device_trust_envelope`). While in-browser access is rate-limited and locked after 5 failed attempts (destroying the envelope), this protection is enforced exclusively by client-side JavaScript. If an adversary gains physical or local OS root access to the machine and extracts the browser's SQLite/LevelDB database files from disk, the software-level attempt counter does not apply offline. An attacker with dedicated GPU resources can brute-force the $10^6$ PIN keyspace offline.
- **Decision / Status:** **Accepted Risk for PIN / Progressive Enhancement Mitigated** (owner: project lead / architecture). In standard web browser environments without native OS secure hardware enclaves (TPM / Secure Enclave), web storage is inherently bound to host OS security. Implementing server-dependent rate-limiting for PIN entry would violate the application's offline-first architecture.
- **User Responsibility Invariant:** Physical and device hardware security rests 100% on the user when choosing to enable "Trust This Device" via software PIN. The UI mandates explicit user acknowledgment of this trust boundary before activation.
- **Implemented Mitigations & Dual Architecture:**
  - **Hardware-Bound Biometrics (WebAuthn PRF — ✅ IMPLEMENTED 2026-09-05):** Integrated W3C WebAuthentication Level 3 PRF extension (`src/lib/sync/webauthn-prf.ts`). Users on supported platforms (Windows Hello TPM 2.0, Apple Touch ID / Face ID Secure Enclave, Android Titan M2 / StrongBox) can choose Hardware Biometrics instead of a PIN. In this mode, the key encryption key is derived directly within the hardware security chip via HMAC-SHA-256 and HKDF, providing 100% physical immunity against offline `IndexedDB` disk extraction.
  - **Dual Selector in UI:** Both `TrustDeviceModal` and `VaultUnlockModal` (Password tab) present dual options: Hardware Biometrics (with dynamic hardware capability detection and diagnostic guidance) and 6-Digit PIN (software fallback).
  - **Default Zero-Trace Policy:** For high-threat environments, shared workstations, or untrusted hardware, users can remain on the default **Level 1: Strict Zero-Trace (Volatile RAM-Only)** mode, where no cryptographic key material or envelope is ever written to disk/storage.
  - **Remote Central Revocation:** Remote revocation via `deviceTrustEpoch` (backed by PostgreSQL migration `0009_add_device_trust_epoch.sql`) atomically invalidates both PRF and PIN device trust envelopes across all devices simultaneously from any authenticated session via cryptographic AAD binding.

## TD-11 — Full Repository ESLint Hygiene & Zero-Warning Determinism — ✅ RESOLVED (2026-09-07)

- **Debt:** Post-Vault implementation codebase accumulated 104 ESLint issues (3 errors, 101 warnings) across 23 files, primarily consisting of loose types (`@typescript-eslint/no-explicit-any`), dead imports/variables (`@typescript-eslint/no-unused-vars`), React 19 hook lifecycle purity violations (`react-hooks/refs`, `react-hooks/exhaustive-deps`, and `react-hooks/set-state-in-effect`), and syntax invariants (`prefer-const`).
- **Resolution:**
  - Strongly typed all cryptographic worker RPC action payloads (`CryptoWorkerResponsePayloads`), indexedDB vault profiles (`UserVaultProfile`), and database encryption metadata (`FileEncryptionMetadata`).
  - Pruned all unused imports, variables, and dead mocks across server actions, sync engines, UI modals, and test suites.
  - Resolved React 19 hook purity issues in `use-sync.ts` by leveraging a getter property to access `idbManagerRef.current` without executing during render phase.
  - Achieved `0 problems` (`0 errors, 0 warnings`) on `npm run lint` while preserving 100% test pass rate across all 45 test suites (629 tests green).