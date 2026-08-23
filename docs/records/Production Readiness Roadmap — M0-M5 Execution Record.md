# Production-Readiness Roadmap — Execution Record (M0–M5)

> **Point-in-time engineering record (branch `production-readiness`, 2026-08-16).**
> The companion file `EXECUTION_STATE.md` referenced below **no longer exists in
> the repository**; its deferred-work content has been consolidated into the
> living [`TECHNICAL_DEBT_REGISTER.md`](../TECHNICAL_DEBT_REGISTER.md).

**Branch:** `production-readiness` (based on `merge` @ `188c443`)
**Date:** 2026-08-16
**Verification status:** `tsc --noEmit` clean · 202/202 vitest passing · `next build` succeeds

This document records the full production-readiness roadmap executed on the LUGX codebase, milestone by milestone. For each milestone it covers what was broken or missing, why it mattered, how it was fixed, the engineering decision behind the solution, and the verification evidence. It is intended as a maintenance reference for future developers, and it complements the earlier fix-documentation record committed on the `merge` branch.

---

## 1. M0 — Baseline Establishment

**Severity:** P0 — no roadmap can be measured without a green baseline.

The first step was not a code change but a measurement discipline decision. The build, type-check, and test states of `origin/merge` were captured as the ground truth: `tsc --noEmit` at 0 errors, `vitest` at 184/184 passing, `next build` succeeding, and lint at 66 problems (20 errors / 46 warnings). Every subsequent milestone was then re-verified against this same baseline, and the lint number was re-checked after the final milestone to prove **no regression** — the same 66 problems, unchanged. This made it possible to distinguish defects introduced by the roadmap work from pre-existing lint debt that was deliberately out of scope.

---

## 2. M1 — Data-Layer Integrity: Atomic Quota Management and Index Hardening

**Files:** `src/server/actions/ai-ops.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrations/0003_integrity_constraints.sql`, `src/server/actions/ai-ops.integrity.test.ts`, `src/test/{db.setup,test-db}.ts`, `vitest.config.ts`, `vitest.setup.ts`, `drizzle.config.test.ts`
**Severity:** P1 — exploitable quota bypass under concurrency.

### The bug

`getTodayUsage` performed a `SELECT` of the current day's usage row and then a conditional `INSERT` — two separate round-trips with no atomicity. In addition, the `usage` table had **no unique index** on `(user_id, date)`, so nothing at the database level prevented two precisely concurrent requests from each creating their own daily row. The result is the same classic TOCTOU race documented in the earlier hardening record: two simultaneous requests at the limit could both pass the quota check and both consume words.

### The fix

The daily upsert was rewritten as a single atomic statement:

```ts
INSERT INTO usage (...) VALUES (...)
ON CONFLICT (user_id, date) DO UPDATE SET ...
```

Backed by a new **unique index on `usage(user_id, date)`** acting as the immutable database backstop: even if the application layer misbehaves, the index makes a second row for the same user-day physically impossible. The fix was proven with a dedicated integration test firing **50 concurrent upserts** against a real local PostgreSQL and asserting that exactly one row exists afterward.

### Index hardening

The migration `0003_integrity_constraints.sql` (idempotent, wrapped in `IF NOT EXISTS`) adds the table-level defenses:

| Index / Constraint | Purpose |
|---|---|
| `usage(user_id, date)` unique | One row per user per day — backstop for the atomic upsert |
| `idx_files_user_deleted` on `files(user_id, deleted_at)` | Fast soft-delete scans for listing and purging |
| `idx_files_parent_user` on `files(parent_folder_id, user_id)` | Folder-children queries without full scans |
| Partial unique `(user_id, parent_folder_id, title) WHERE deleted_at IS NULL` (with `COALESCE(nil-uuid)` for root) | Live duplicate filenames rejected; tombstoned names may be reused after purge |
| Self-referencing FK `files.parent_folder_id → files.id ON DELETE SET NULL` | Folder deletion never orphans children |

> **Precision bug found and fixed:** partial unique indexes silently **skip `NULL` key columns**. The root-folder case (`parent_folder_id IS NULL`) was therefore *not* unique-enforced — two root files with the same title could coexist. The index was corrected to `COALESCE(parent_folder_id, nil-uuid)::uuid`, which maps every root file to the same sentinel key and enforces uniqueness properly.

### Why this approach

A database-level guard is the only correct answer in a scaled environment: application-level locks or Redis counters require their own fault-tolerance machinery, while PostgreSQL's atomic `UPDATE`/`ON CONFLICT` is transactional by construction.

---

## 3. M2 — Stored-XSS Defense via DOMPurify Chokepoints

**Files:** `src/lib/sanitize.server.ts`, `src/lib/sanitize-client.ts`, `src/lib/parsers/text-to-html.server.ts`, `src/lib/parsers/text-to-html.ts`, `src/app/workspace/editor/[fileId]/page.tsx`, `next.config.ts`, `package.json`, `src/lib/sanitize.test.ts`
**Severity:** P0 — stored XSS: user-authored HTML was rendered into the TipTap editor without sanitization.

### The bug

Markdown/HTML import paths converted raw input into HTML and injected it into the editor. Any payload containing `<script>`, `onerror="..."`, or `javascript:` URI schemes would execute in the author's own browser session — a textbook stored-XSS vector with access to the user's editor content and any authenticated actions.

### The fix

A **split sanitization architecture** places DOMPurify chokepoints on both sides of the bundle boundary:

- **Server chokepoint** (`sanitize.server.ts`): DOMPurify backed by `jsdom`, using a TipTap allow-list; `<style>` tags are excluded because they carry the `javascript:` URI vector. This is where server-side conversions happen (e.g., raw HTML import).
- **Client chokepoint** (`sanitize-client.ts`): DOMPurify over the browser's native `window` — **zero jsdom bytes in the client bundle**, preserving load performance.

`smartConvertToHTML` was moved to `parsers/text-to-html.server.ts` so the heavy conversion path runs server-only, and the editor page sanitizes both server-fetched content and IndexedDB content before calling `setContent`. `next.config.ts` declares `jsdom` in `serverExternalPackages` because jsdom requires Node's `fs` and cannot be client-bundled under Turbopack.

### Why this approach

The split keeps the security property (everything HTML entering the editor is sanitized) while respecting the bundle-size constraint (jsdom is ~several MB and cannot be shipped to the browser). The six-unit test corpus verifies DOMPurify corpus vectors are neutralized, non-string input fails closed, converter output is idempotent under repeated sanitization, and TipTap's tag vocabulary survives the allow-list.

---

## 4. M4 — AI Operation Content Safety: Snapshot-Rollback Lifecycle

**Files:** `src/app/workspace/editor/[fileId]/page.tsx`, `src/lib/ai-transaction.test.ts`
**Severity:** P0 — the editor could permanently lose document content on AI failure.

### The bug

The legacy `handleAIOperation` flow was a cascade of un-recoverable mutations:

1. It **deleted** the selection/content *before* the AI response arrived (no history, no snapshot).
2. It streamed raw text directly into the document.
3. On completion it deleted the streamed text and re-inserted using `selectionStart + text.length` anchoring — but `text.length` does **not** equal the character count in ProseMirror's node model (`textBetween` inserts spaces between block nodes), so the final selection anchored at the wrong position and replaced the wrong range: **partial content loss**.
4. `selectionEnd = doc.content.size - 1` could exceed content size on an empty document; `selectionStart = 1` assumed the first text position.
5. The `catch` block only called `editor.commands.undo()` — leaving half-streamed content behind when streaming itself had failed.

### The fix

A snapshot-rollback contract:

1. **Snapshot** `originalHtml = editor.getHTML()` before any network call; the document is never mutated before the AI arrives.
2. AI output streams into a temporary variable, not the document.
3. **Success:** a single undoable transaction (select range → delete → insert AI HTML) replaces the target range — one `Ctrl+Z` fully restores the pre-operation document.
4. **Failure** (network, quota, non-ok response, empty output, abort): exact rollback via `setContent(originalHtml)`.

The new helper layer (`runAITransaction` / rollback) is covered by four tests using a **real TipTap `Editor` instance on jsdom**: full-document replacement restores exactly on one undo; partial-range replacement preserves surrounding text; explicit rollback restores the exact pre-operation snapshot; an empty AI response triggers rollback instead of blanking the document.

---

## 5. M3 — Soft-Delete Lifecycle: Tombstones, Restoration, and 30-Day Purge

**Files:** `src/server/actions/file-ops.ts`, `src/app/api/cron/purge-deleted/route.ts`, `src/server/actions/file-ops.softdelete.test.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrations/0003_integrity_constraints.sql`

### The bug

`deleteFile` performed a hard `DELETE` with a cascade comment. File content was unrecoverable the instant deletion was confirmed, and — more dangerously for a system with live sync — concurrent sync operations replaying stale state could resurrect or mutate "deleted" data because nothing marked a row as deleted in the first place.

### The fix

**Tombstones instead of deletion.** `deleteFile` now sets `deleted_at = NOW()` (idempotent — re-deleting merely refreshes the timestamp and extends the restoration window). The lifecycle is closed on all sides:

| Surface | Behavior |
|---|---|
| Live reads (`getFile`, `getUserFiles`, `getRootFiles`, `getFolderChildren`) | Filter `deleted_at IS NULL` — tombstones are invisible |
| Live writes (`updateFileContent`, `renameFile`, `moveFile`) | `isNull(deletedAt)` guard + row-count check — **reject** tombstoned rows, preventing stale sync replay from mutating or resurrecting deleted data |
| `restoreFile` | Ownership check + purged-row guard; idempotent (no-op on live rows); restoring a folder also clears tombstones on its children |
| `getDeletedFiles` *(added with the UI)* | Lists user's tombstones newest-first for the Trash view |
| `/api/cron/purge-deleted` | 30-day retention; `CRON_SECRET` Bearer auth; `DELETE WHERE deleted_at <= cutoff` bounded by a **fixed literal `LIMIT 500`** — pg prepared statements reject a *parameterized* `LIMIT $2` (syntax error), so a hardcoded bound with batched re-invocation is used instead |

> **Precision bugs found and fixed during testing:** (1) the test helper `fileOf()` explicitly supplied `storagePath: ''` / `etag: 0`, producing a wrong parameter count against Drizzle's 12-column insert — corrected to include `storagePath: null` / `etag: null`; (2) the parameterized `LIMIT` in the purge route was discovered to be unexecutable in pg and replaced with the fixed-literal batched delete.

The accompanying migration extended the schema from M1: the partial unique name index was amended with the `COALESCE(nil-uuid)` sentinel (so a deleted file's name may be legally reused once purged), and the `idx_files_user_deleted` index accelerates the purge query. Five integration tests against real PostgreSQL cover the tombstone lifecycle, read invisibility, write rejection, name reuse after delete, and purge semantics.

### Why this approach

Soft-delete is the only design that reconciles instant user-visible deletion, sync reconciliation (a tombstone row can be replicated to peers), and recoverability, while the hard purge job keeps storage bounded. The 30-day window and the auth-gated cron route follow standard practice for destructive-background operations.

---

## 6. UI — Restore Surface: Trash Section and Restore Action

**Files:** `src/server/actions/file-ops.ts` (`getDeletedFiles`), `src/components/layout/sidebar.tsx`, `src/components/files/file-context-menu.tsx`

### The gap

After M3, deleted files were permanently invisible in the UI — there was no way for a user to reach the restoration action added at the server level.

### The fix

A **Trash section** in the sidebar, matching the site's design system (Tailwind zinc palette, Lucide icons, existing `custom-scrollbar` and hover semantics):

- A collapsible **Deleted Files** row (Trash icon) under the file list with a count badge; the tombstone query runs only when the section is first opened (no load-time cost on fresh sessions).
- Tombstoned items render with muted styling, a strike-through title, and a remaining-retention hint (`Today`, `Yesterday`, `Nd left`, `30d+`) derived from `deleted_at`.
- Each row opens the shared `FileContextMenu` with the new `isDeleted` flag. In tombstone mode the menu shows **only Restore** — rename, copy, move, and delete are disabled for dead rows; Restore calls `restoreFile`, then refreshes both the tree and the Trash list.
- For live items the menu now conditionally renders Delete/Copy/Move and the Restore option is hidden.

Server-side, `getDeletedFiles` lists the user's tombstones newest-first with ownership enforced by the existing `getUser()` guard.

---

## 7. Verification Summary

| Gate | Result after M5 + UI |
|---|---|
| `tsc --noEmit` | 0 errors |
| `vitest` | 15 files, **202/202 passing** (18 new tests across the roadmap) |
| `next build` | Compiled successfully |
| Lint | 66 problems — identical to the `merge` baseline, no regression |

New test files: `ai-ops.integrity.test.ts` (3), `file-ops.softdelete.test.ts` (5), `ai-transaction.test.ts` (4), `sanitize.test.ts` (6), plus the test infrastructure (`src/test/db.setup.ts`, `src/test/test-db.ts`, `vitest.setup.ts`, `drizzle.config.test.ts`).

## 8. Known Limitations and Deferred Items

The following were deliberately documented as out-of-scope improvements and remain in `EXECUTION_STATE.md` for future work. `getTodayUsage`'s daily row lookup still performs a separate `SELECT` before the atomic upsert (acceptable at current scale; the unique index already makes duplication impossible). The purge route is invoked by cron rather than self-scheduling. The partial unique index relies on Drizzle's SQL generation, and the `COALESCE` sentinel is a Drizzle-version-dependent pattern that should be re-verified on dependency upgrades.

## 9. Merge Recommendation

All roadmap work lives on `production-readiness` (tip commits: M1 `0120f9d`, M2 `a1ba689`, M4 `0ca2601`, M3 `d3c9779`, UI `cfdc4f1`). The branch is based on `merge` `188c443`, every gate is green, and no test was removed. Merge via GitHub Pull Request (no force-push) to carry this into `main`.
