# Test Database Isolation — Neon Branch (Phase 10)

Status: ✅ Implemented · Roadmap: Phase 10 of
[`docs/.Plans/خطة التنفيذ التقنية.md`](../.Plans/خطة%20التنفيذ%20التقنية.md) ·
Background incident:
[`records/test-database-safety.md`](../records/test-database-safety.md)

---

## 1. Contract

All Postgres-backed integration tests run **exclusively** against a dedicated
Neon branch (`TEST_DATABASE_URL`), never against the app's production main
branch. This replaces the earlier "isolation declined" posture (TD-01) whose
compensating controls (`cleanupTestUsers`, scoped deletes, placeholder UUIDs)
remain in place as a **second layer of defense**, not a substitute.

## 2. Architecture

| File | Role |
|---|---|
| `src/test/load-test-env.ts` | Pure env loader used by `vitest.setup.ts`. Priority: shell `TEST_DATABASE_URL` > `.env.test.local` > `.env.test` > `.env.local` > `.env`. Then hard-binds `DATABASE_URL = TEST_DATABASE_URL`. |
| `src/test/test-db-guard.ts` | Pure fail-closed guard (`assertSafeTestDatabaseUrl`) + identity helpers (`extractDbHost`, `extractNeonEndpointId`). No pg imports — unit-testable. |
| `src/test/test-db.ts` | Calls the guard BEFORE creating the pg Pool and prints the branch identity line. |
| `drizzle.config.test.ts` | `drizzle-kit push` target resolved from `TEST_DATABASE_URL ?? DATABASE_URL`. |
| `src/test/test-db.isolation.test.ts` | Unit tests for guard rejection paths and env-loader leak prevention. |
| `vitest.live.config.ts` | LIVE suite config. Owns `LIVE_TEST_FILES` — the single source of truth for suites requiring real environments (isolated Neon branch / live AI keys). |
| `vitest.live.global-setup.ts` | Fail-closed gate for `test:live`: verifies guard rules AND branch reachability up front; refuses to start otherwise (no silent skips). |
| `vitest.config.ts` | Default config — excludes every `LIVE_TEST_FILES` entry, so plain `npm run test` can structurally never touch a real environment. |

## 2.1 Test execution commands

| Command | Scope |
|---|---|
| `npm run test` | Unit/contract tests only (runs ONCE via `vitest run`; `test:watch` exists for watch mode). No DB, no external services. Fast, hermetic, and completely decoupled from network/cloud. |
| `npm run test:live` | The 15 hermetic LIVE suites against the isolated PostgreSQL service container / Neon branch. |
| `npm run test:all` | Both, sequentially. |

LIVE suites registered in `vitest.live.config.ts` (15 hermetic database suites):

1. `src/app/api/files/[id]/route.putguard.test.ts`
2. `src/server/actions/ai-ops.integrity.test.ts`
3. `src/server/actions/ai-ops.refund.test.ts`
4. `src/server/actions/file-ops.lostupdate.test.ts`
5. `src/server/actions/file-ops.ownership.test.ts`
6. `src/server/actions/file-ops.softdelete.test.ts`
7. `src/test/ai-atomic-commit.integration.test.ts`
8. `src/test/conflict-resolution.integration.test.ts`
9. `src/test/ai-quota-idempotency.live.test.ts`
10. `src/test/ai-server-atomic-commit.live.test.ts`
11. `src/test/editor-orchestration.live.test.ts`
12. `src/test/ai-preview-decision.live.test.ts`
13. `src/test/ai-reservation-status.live.test.ts`
14. `src/app/api/stripe/webhook/route.live.test.ts`
15. `src/test/cross-user-ownership.test.ts`

*(Note: The external cloud integration suite `src/test/ai-live-e2e.test.ts` is explicitly isolated to Stage 6 `live-provider-smoke` and requires live provider API secrets).*

### Formerly-mocked suites — LIVE twins now implemented (post Phase 10 follow-up)

The five suites below had fully-mocked persistence when inventoried; real-
branch live twins were added and registered in `vitest.live.config.ts`:

| Mocked contract suite | LIVE twin (added 2026-08-24) |
|---|---|
| `src/test/ai-quota-idempotency.test.ts` | `src/test/ai-quota-idempotency.live.test.ts` — incl. concurrent same-operationId race on real rows |
| `src/test/ai-server-atomic-commit.test.ts` | `src/test/ai-server-atomic-commit.live.test.ts` — only `getUser` mocked; real tx row-level assertions |
| `src/test/editor-orchestration.integration.test.ts` | `src/test/editor-orchestration.live.test.ts` — real file-ops actions; real 412 vs sibling write + merge resolution |
| `src/test/ai-preview-decision.test.ts` | `src/test/ai-preview-decision.live.test.ts` — hook-generated operationId settled against real reservation rows |
| `src/app/api/stripe/webhook/route.test.ts` | `src/app/api/stripe/webhook/route.live.test.ts` — REAL HMAC signature verification + persisted tier/subscription rows (durable-ledger dedupe deferred to Phase 13) |

### Smart Hybrid Database Client (`db` & `txDb`)

Database operations across the application and testing harness utilize an intelligent dual-driver architecture:
- **Standard Client (`db` in `src/lib/db/index.ts`):** Dynamically detects environment hosts:
  - **Neon Cloud (`neon.tech`):** Uses `@neondatabase/serverless` (`neon-http`) with `drizzle-orm/neon-http` for low-latency serverless HTTP execution.
  - **Local & CI PostgreSQL Containers (`localhost` / `127.0.0.1` on port 5432):** Automatically connects via `pg.Pool` (`node-postgres`) with `drizzle-orm/node-postgres`, eliminating `ECONNREFUSED ::1:443` port conflicts in Docker and CI runners.
- **Interactive Transactional Client (`txDb` in `src/lib/db/transactional.ts`):**
  - **Local & CI PostgreSQL (TCP):** Executes interactive ACID transactions (`BEGIN`, `COMMIT`, `ROLLBACK`) with zero WebSocket overhead.
  - **Neon Cloud (WebSocket):** Uses `@neondatabase/serverless` WebSocket Pool and `drizzle-orm/neon-serverless`.
  - **Dynamic Lazy Resolution:** `txDb` evaluates the active `DATABASE_URL` via a lazy proxy singleton, ensuring dynamic binding to `TEST_DATABASE_URL` during test execution without stale module-load bindings.

### Deterministic Namespaced User IDs & Concurrency Isolation

To guarantee 100% isolation when integration test suites run in parallel against a shared test database:
- Every suite is allocated a deterministic, non-overlapping placeholder UUID range matching `/^(\d{4})\1-\1-\1-\1-\1{3}$/` (e.g. `1111...` for `ai-ops.integrity`, `1313...`/`1414...` for `cross-user-ownership`, `1515...` for `editor-orchestration`, `1616...` for `ai-server-atomic-commit`, `2323...`/`2424...`/`2525...` for `stripe/webhook`).
- Suites seed their test user rows in `beforeEach` with `onConflictDoNothing()`, preventing cross-suite `CASCADE` deletions when sibling test suites tear down.

The Pool is never created unless **all** of the following hold:

1. `TEST_DATABASE_URL` is configured (mandatory locally AND in CI).
2. The effective `DATABASE_URL` equals `TEST_DATABASE_URL` exactly.
3. The target host is not listed in the optional comma-separated denylist
   `TEST_DB_FORBIDDEN_HOSTS` (defense against pasting the main-branch URL as
   the test URL; automatically normalizes `-pooler` connection endpoints).

Every vitest run prints the mandatory identity line, e.g.:

```
[test-db] Isolated test branch identity — endpointId: 'ep-xxxx-pooler' host: 'ep-xxxx-pooler.c-5.eu-central-1.aws.neon.tech'
```

This line is a required element of every phase-closure report (roadmap step 5).

## 4. Setup & operations

One-time branch creation (or after Neon plan limits delete it):

```bash
neonctl branches create --name test-suite --project-id <PROJECT_ID>
neonctl connection-string <BRANCH_ID> --project-id <PROJECT_ID> --pooled
# Put the result into .env.test.local (git-ignored):
#   TEST_DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
```

Schema application — re-run after EVERY change under `src/lib/db`:

```bash
npx drizzle-kit push --config drizzle.config.test.ts --force
```

Schema drift between branches blocks execution until re-applied (guard binds
to a live URL; push failures surface immediately).

## 5. Evidence of isolation

- **Unit test suite (`npx vitest run`):** **37 files / 488 tests — all passed (100% pass rate)**, zero LIVE files included.
- **Guard unit tests (`src/test/test-db.isolation.test.ts`):** **8/8 passed** (main-branch refusal, missing-URL refusal, mismatch refusal, loader leak prevention, shell-value precedence, and `-pooler` endpoint refusal).
- **Live run (`npm run test:live`):** 16 registered suites executed against isolated PostgreSQL container / Neon branch.
- Mandatory identity line printed at the start of every live run:
  `[test-db] Isolated test branch identity — endpointId: 'ep-soft-glade-b1hdcbwm-pooler' host: 'ep-soft-glade-b1hdcbwm-pooler.c-5.eu-central-1.aws.neon.tech'`
- Main-branch row counts before/after a full live run (2026-08-24, operator
  probe reading `.env.local` in-memory without exposing the URL) — **identical,
  zero rows touched**:

  | Table | Before | After |
  |---|---|---|
  | `users` | 4 | 4 |
  | `files` | 1 | 1 |
  | `usage` | 2 | 2 |
  | `ai_reservations` | 38 | 38 |
  | `subscriptions` | 1 | 1 |

### Known transient (out of Phase 10 scope)

`ai-live-e2e.test.ts` exercises the external Gemini provider and can exceed the
default 30 s vitest timeout when provider latency spikes (observed intermittently
on 2026-08-24; passed fully on other attempts). Unrelated to database isolation.
Follow-up: raise a dedicated `testTimeout` for the live config.

```bash
# Run manually BEFORE and AFTER a test session; compare counts.
node -e "
const { Pool } = require('pg'); require('dotenv').config({ path: '.env.local', override: true });
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  for (const t of ['users','files','usage','ai_reservations','subscriptions']) {
    const r = await p.query('select count(*)::int as n from ' + t);
    console.log(t, r.rows[0].n);
  }
  await p.end();
})();
"
```

## 6. Known limitations / follow-ups

- `scripts/db-testusers-probe.mjs` still resolves its own connection string;
  updating it to target the branch explicitly belongs to a separate cleanup.
- TD-01 in `docs/TECHNICAL_DEBT_REGISTER.md` must be rewritten (decision
  reversal) in a dedicated documentation session per the roadmap.

## 7. Multi-Stage CI/CD Pipeline Automation (`.github/workflows/ci.yml`)

The repository runs a deterministic multi-stage CI pipeline on GitHub Actions configured to strictly enforce concurrency integrity and database isolation across every pull request and branch push:

| Stage | Job Name | Isolation & Execution Guarantees |
|---|---|---|
| **1. Quality Gate** | `quality-gate` | Pure static verification: ESLint 9, TypeScript strictness (`tsc --noEmit`), and dependency vulnerability audits (`npm audit`). |
| **2. Pure Unit Contracts** | `unit-contracts` | Runs `npm run test` strictly excluding `LIVE_TEST_FILES` (zero database or network dependencies, < 20s runtime). |
| **3. Schema Integrity** | `migration-integrity` | Ephemeral `postgres:16-alpine` service container verifies sequential migration application (`scripts/verify-migrations.mjs`) and Drizzle schema sync (`drizzle-kit push --config drizzle.config.test.ts --force`). |
| **4. Concurrency & Isolation** | `concurrency-and-db-isolation` | Runs `npm run test:live` against isolated PostgreSQL 16 + Redis 7 service containers with `TEST_DB_FORBIDDEN_HOSTS` configured to reject production hosts, verifying lost-update guards, AI quota idempotency, and Stripe ledger deduplication. |
| **5. Production Build** | `build-verification` | Full Next.js 16 production build (`npm run build`) with asset compilation and route validation. |
| **6. Live Smoke (Gated)** | `live-provider-smoke` | Gated provider live smoke (`src/test/ai-live-e2e.test.ts`) executed only on `main` push or manual `workflow_dispatch`. |

