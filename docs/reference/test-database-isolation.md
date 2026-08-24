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
| `npm run test` | Unit/contract tests only (334 tests across 28 files). No DB, no external services. |
| `npm run test:live` | The 14 LIVE suites against the isolated Neon branch (+ live AI keys for the e2e smoke). |
| `npm run test:all` | Both, sequentially. |

LIVE suites currently registered in `vitest.live.config.ts`:

1. `src/app/api/files/[id]/route.putguard.test.ts`
2. `src/server/actions/ai-ops.integrity.test.ts`
3. `src/server/actions/ai-ops.refund.test.ts`
4. `src/server/actions/file-ops.lostupdate.test.ts`
5. `src/server/actions/file-ops.ownership.test.ts`
6. `src/server/actions/file-ops.softdelete.test.ts`
7. `src/test/ai-atomic-commit.integration.test.ts`
8. `src/test/conflict-resolution.integration.test.ts`
9. `src/test/ai-live-e2e.test.ts`
10. `src/test/ai-quota-idempotency.live.test.ts`
11. `src/test/ai-server-atomic-commit.live.test.ts`
12. `src/test/editor-orchestration.live.test.ts`
13. `src/test/ai-preview-decision.live.test.ts`
14. `src/app/api/stripe/webhook/route.live.test.ts`

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

jsdom-based live suites route interactive transactions through the pg-backed
`testDb` (`txDb` mock), since the Neon-serverless WebSocket pool cannot open
without a WebSocket global — the precedent set by
`ai-atomic-commit.integration.test.ts`.


## 3. Guard rules (fail-closed)

The Pool is never created unless **all** of the following hold:

1. `TEST_DATABASE_URL` is configured (mandatory locally AND in CI).
2. The effective `DATABASE_URL` equals `TEST_DATABASE_URL` exactly.
3. The target host is not listed in the optional comma-separated denylist
   `TEST_DB_FORBIDDEN_HOSTS` (defense against pasting the main-branch URL as
   the test URL).

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

- Default run (`npx vitest run`): **28 files / 334 tests — all passed**, zero
  LIVE files included.
- Live run (`npm run test:live`) on the isolated branch: **14/14 files / 62 tests
  passed** — including all five live twins of formerly-mocked suites (see §2.1).
- Guard unit tests → 7/7 passed (main-branch refusal, missing-URL refusal,
  mismatch refusal, loader leak prevention, shell-value precedence).
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
