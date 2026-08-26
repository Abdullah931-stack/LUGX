# Phase 11 Closure Report — Editor, AutoSave & Sync Orchestration

Status: **CLOSED** (2026-08-24 · Amended in Markdown Migration Phase 2 & 3 with `MarkdownEditor` and `EditorAdapter`)
Session contract: Phase 9 session-execution template (one phase per session).
Derivation: Phase 10 closed (isolated Neon test branch, commit `60da9ac`).

## 1. Scope

Verification-and-completion phase: prove the single write path and suspension
policies hold under pressure, and close the remaining browser-behavior gaps.

## 2. What was verified (no changes required)

- **Single authoritative write path**: manual save, AI commit, conflict
  resolution and sync replay all route through `useEditorOrchestrator`
  (`WriteStateType`: idle / saving / ai_committing / resolving_conflict /
  syncing / stopped). Assertions added to
  `src/test/editor-orchestration.integration.test.ts`.
- **AutoSave suspension gate** (`canAutoSave`): proven inactive during
  `streaming`, `reserved`, `preview_ready`, `committing`, unresolved conflict,
  and programmatic updates. Runtime log evidence during tests:
  `[Orchestrator] Auto-save skipped due to active suspension gate invariant`.
- **Manual edit during streaming policy**: inside-range edit aborts the AI
  stream, clears the ghost and settles quota; outside-range edits retain the
  stream (existing tests, re-run green).
- **Single atomic undo after AI commit**: `editor-atomic-commit.test.ts`
  (Gate G8) re-run green.
- **No `editor-canvas` remnants**: recursive grep over `src/**/*.{ts,tsx}`
  returns **0** matches (step 6 of the phase). Historical mentions exist only
  in docs (CHANGELOG v1.5.x deletion note; stale tree in
  `docs/foundation/Project_Structure.md` is itself a FOUNDING planning artifact,
  intentionally immutable per owner decision; current-state truth lives in
  DESIGN_VS_REALITY.md).

## 3. Gaps closed in this phase

### Gap A - reload during preview had no durable operation identity (steps 4)

- New `src/lib/ai/pending-operation-store.ts`: sessionStorage-backed registry
  of pending AI operations (identifiers + phase only, never document content;
  tab-scoped; SSR-safe).
- `use-ai-stream.ts` now tracks each operation at stream start, advances it to
  `preview_ready`, clears it on every terminal settlement, and - on mount -
  recovers orphaned records left by a HARD reload (where React cleanup never
  runs). Recovery queries the server and settles per policy:
  - `preview_ready` orphan -> quota consumed (`commitAIReservation`, idempotent);
  - `generating` orphan -> `refundAIReservation(operationId, 'reload_recovery')`.
- The abandoned preview is NEVER applied to the document and NEVER treated as
  committed; the server document is re-fetched by the orchestrator's initial
  load pipeline as the single source of truth.
- Read-only server action `getAIReservationStatus(operationId)` added to
  `src/server/actions/ai-ops.ts`. User is derived from the server session and
  rows are filtered by ownership: a cross-user operationId is indistinguishable
  from a missing one (`found: false`) - no data leakage.

### Gap B - navigation during commit was unguarded by tests (step 5)

- The `beforeunload` guard already covered `isDirty || isCommitting || isSaving`.
- New assertions prove the warning fires while dirty AND while a commit is in
  flight, and that no autosave interleaves with an in-flight commit
  (single-write-path invariant).

## 4. Test execution evidence

Default suite (jsdom / mocked boundaries), single command:

```
npx vitest run src/test/editor-orchestration.integration.test.ts \
  src/test/editor-recovery-reload.test.ts \
  src/test/editor-atomic-commit.test.ts \
  src/test/ai-preview-decision.test.ts
=> Test Files 4 passed (4) | Tests 25 passed (25)
```

New suites:
- `src/test/editor-recovery-reload.test.ts` (5 tests): reload-during-preview,
  reload-during-generation, already-settled, unknown-id, SPA teardown tracking.
- `src/test/editor-orchestration.integration.test.ts` extended with 4 tests:
  streaming suspension, preview_ready suspension, committing block + unload
  warning + single-write restoration, dirty unload warning.

LIVE suite on the isolated Neon branch:

```
npx vitest run --config vitest.live.config.ts src/test/ai-reservation-status.live.test.ts
=> [test-db] Isolated test branch identity - endpointId: 'ep-soft-glade-b1hdcbwm-pooler'
   host: 'ep-soft-glade-b1hdcbwm-pooler.c-5.eu-central-1.aws.neon.tech'
=> Test Files 1 passed (1) | Tests 4 passed (4)
```

Covers: owner snapshot of a reserved operation, committed-transition read,
cross-user denial (not_found), unknown-id not_found.

Type safety: `npx tsc --noEmit` exit code 0.

## 5. Deferred with explicit decision

Real-browser E2E scenarios for this phase (Playwright reload/navigation
journeys) are DEFERRED to Phase 19 tooling, recorded as **TD-07** in
`docs/TECHNICAL_DEBT_REGISTER.md` (owner decision, 2026-08-24). Interim
coverage: jsdom hard-reload simulation via sessionStorage seeding + fresh hook
mount (semantically equivalent to a reload: zero in-memory state survives),
plus the manual browser checklist below.

## 6. Manual browser checklist (operator verification)

1. Start an AI operation, leave it in preview, press F5 -> document shows no
   preview text; next mount settles the reservation as consumed.
2. Trigger Accept (commit) and immediately close the tab -> browser shows the
   unload warning; reservation row remains queryable via
   `getAIReservationStatus`.
3. Edit manually and reload within the autosave debounce window -> warning
   shown; text recovered from IndexedDB on remount.

## 7. Modified files

- `src/hooks/use-editor-orchestrator.ts` (+3): expose `canAutoSave` for gating
  assertions.
- `src/hooks/use-ai-stream.ts` (+50): pending-operation tracking/clearing +
  mount recovery effect.
- `src/server/actions/ai-ops.ts` (+54): read-only `getAIReservationStatus`.
- `src/lib/ai/pending-operation-store.ts` (new).
- `src/test/editor-orchestration.integration.test.ts` (+198): Phase 11 closure
  assertions.
- `src/test/editor-recovery-reload.test.ts` (new).
- `src/test/ai-reservation-status.live.test.ts` (new, LIVE bucket).
- `vitest.live.config.ts` (+1): register the live suite.

## 8. Addendum - root cause of the aborted full-suite sweep

A post-closure regression attempt was launched as `npm run test`. The script is
defined as bare `vitest`, i.e. WATCH MODE: it runs the suite and then stays
alive forever waiting for file changes. Piped through a tail buffer, it produced
no output and appeared hung; it was terminated after ~70 minutes. This was an
invocation mistake (watch mode), NOT a Neon connectivity issue and NOT a leaked
live test:

- The default bucket structurally excludes every LIVE suite:
  `vitest.config.ts` sets `exclude: [...configDefaults.exclude, ...LIVE_TEST_FILES]`,
  and `src/test/ai-reservation-status.live.test.ts` is registered exclusively in
  `LIVE_TEST_FILES` (single source of truth in `vitest.live.config.ts`).
- All 14 suites importing `@/test/test-db` (the only Neon consumers) are members
  of `LIVE_TEST_FILES`; the default bucket therefore never touches Postgres.
- Even inside vitest, `load-test-env.ts` hard-binds `DATABASE_URL = TEST_DATABASE_URL`
  (priority: shell > .env.test.local > .env.test > .env.local > .env) and
  `test-db-guard.ts` throws BEFORE any Pool is created on any mismatch - the main
  branch is unreachable by construction.

Non-interactive reproduction (executed post-fix, all green):

```bash
npx vitest run        # full default bucket (watch-free)
npm run test:live     # LIVE bucket on the isolated branch
```

## 9. Full default-bucket sweep - PASSED

After switching the invocation to non-interactive `vitest run` and normalizing
the npm scripts (`test` -> `vitest run`, new `test:watch`), the complete default
bucket executed successfully:

```
Test Files  29 passed (29)
     Tests  343 passed (343)
  Duration  ~33s
```

File count (29, not 30) additionally confirms the live suite is excluded from
the default bucket; the empirical filter probe returned "No test files found"
for `src/test/ai-reservation-status.live.test.ts` under the default config.

## 10. Post-closure debt-cleanup round (same session, owner-directed)

| Debt | Action | Verification |
|---|---|---|
| TD-04 lint errors in two legacy suites | Typed CycleFolderRow maps, pruned unused imports, any-free session mock cast | npx eslint on both files: exit 0 |
| TD-06 dead SyncStatus error member | Removed from the union AND the exhaustive display row in sync-indicator.tsx | tsc --noEmit exit 0 catches any missed consumer |
| Unload-guard gap: undecided preview abandonment was silent | Guard condition now includes preview_ready state; new jsdom assertion proves warning when clean and release after explicit decision | suite green |
| Watch-mode trap in default test script | Scripts normalized to vitest run for test; added test:watch | full sweep green via npm scripts |

Post-round verification: tsc --noEmit exit 0; full default bucket **29 files / 344 tests passed**.
Deferred by owner decision (unchanged): TD-02 (Phase 17 cron wiring), TD-03 (declined), TD-07 (Phase 19 Playwright).
Commit intentionally withheld — the owner will issue it explicitly at final closure.

## 11. Post-9642816 hotfix - Hydration Lifecycle, Offline-First Contract & UI Integration (owner-reported)

Owner bug: file lost locally while present in DB never rendered; save dot stayed red.

ROOT CAUSES fixed structurally:
1. Reconciliation contract fabricated a baseline (v1/null) on cold start, so a
   server v1 file misclassified as remote_not_newer -> editor stayed empty.
   Contract now takes `localBaseline: LocalBaseline | null` and owns two new
   closed-matrix actions: `bootstrap_server` (clean) and
   `adopt_metadata_keep_edits` (eager edits preserved, anchors only).
2. No lifecycle existed for loading. Added `hydration: hydrating | ready |
   fatal`; the editor surface is FROZEN (`setEditable(false)`) until settle -
   sync-before-write is structural, with cheap defense gates in
   handleEditorChange / executeServerWrite / canAutoSave.
3. Pipeline resilience & identity stability:
   - `loadedFileIdRef` tracks active document identity, ensuring clean file switching without unmounting.
   - `useEffect` cleanup returns `cancelled = true`, preventing unmounted state leakage on aborted fetches.
4. UI Layer Integration (`page.tsx`):
   - Animated backdrop blur loader during active hydration (`Loader2`).
   - Fatal error state card with direct workspace recovery routing.
   - Real-time status bar sync indicator (`Syncing...`).
5. markServerPersisted(updatedAt) unified save-dot semantics across
   bootstrap / apply / adopt_metadata (red-dot-after-open defect eliminated).

OFFLINE-FIRST CONTRACT (owner refinement): a TRANSPORT failure during
hydration NEVER freezes the editor - only a server-ANSWERED missing-file
response (no local snapshot, no eager edits) is fatal. Offline composition
completes locally as durable dirty IndexedDB snapshots, reconciling later via
the standard optimistic-locking path. Covered by test OFFLINE-FIRST:
unreachable server with no local snapshot unlocks local composition.

Verification: reconciliation 10/10 - orchestration integration 15/15 -
tsc --noEmit exit 0 - full default bucket **29 files / 349 tests passed**.
Changes across reconciliation.ts and its tests, use-editor-orchestrator.ts,
page.tsx, and integration tests are verified and ready.
