# Execution State — Production-Readiness Roadmap

## Repo: /home/ubuntu/lugx_verify (branch: production-readiness @ 188c443 base)

## Environment setup (important!)
- Local Postgres running: `postgresql://lugx:lugx_test@localhost:5432/lugx_test`
- `.env.test` contains DATABASE_URL above (vitest.setup.ts loads .env then .env.test with override=true)
- vitest 4 does NOT support envFile in config — use `setupFiles: ['./vitest.setup.ts']` in vitest.config.ts
- Neon HTTP driver unreachable in sandbox → integration tests use pg driver via `src/test/test-db.ts`
- Vitest: `npx vitest run` | tsc: `npx tsc --noEmit` | build: `npm run build`
- `npm install --save-dev dotenv pg @types/jsdom @vitest/coverage-v8` + deps `dompurify jsdom` installed

## Commits so far
- 0120f9d M1: usage integrity
  - src/lib/db/schema.ts: unique index usage(user_id, date), sync indexes on files,
    partial unique index (user_id, parent_folder_id, title) WHERE deleted_at IS NULL,
    self-referencing FK files.parent_folder_id -> files.id ON DELETE SET NULL
  - src/lib/db/migrations/0003_integrity_constraints.sql (idempotent IF NOT EXISTS)
  - src/server/actions/ai-ops.ts: getTodayUsage → INSERT ... ON CONFLICT DO NOTHING
  - src/server/actions/ai-ops.integrity.test.ts: 3 race tests (50 concurrent upserts → 1 row)
  - src/test/{db.setup,test-db}.ts, drizzle.config.test.ts, vitest.setup.ts
- a1ba689 M2: DOMPurify
  - src/lib/sanitize.server.ts (jsdom), src/lib/sanitize-client.ts (native window)
  - src/lib/parsers/text-to-html.server.ts (smartConvertToHTML server-only)
  - src/lib/parsers/text-to-html.ts (client-safe, no jsdom)
  - editor page sanitizes server + IndexedDB content via sanitize-client
  - next.config.ts: serverExternalPackages: ["jsdom"]
  - src/lib/sanitize.test.ts: 6 XSS tests pass

## Next: M4 — AI content-loss protection
Location: src/app/workspace/editor/[fileId]/page.tsx handleAIOperation (lines 210-316)

### Current flawed design
1. Deletes selection/content BEFORE fetching AI (stream prep), no history
2. Streams raw text into editor (no history)
3. Final: deletes streamed text, re-inserts original text at selectionStart using
   `text` (plain text via insertContent), then selects [selectionStart, selectionStart+text.length]
   and replaces with html.
### Bugs:
- `text.length` ≠ character count in ProseMirror nodes (textBetween inserts spaces
  between block nodes → length mismatch → final selection wrong → partial content loss)
- `selectionEnd = doc.content.size - 1` may exceed content size in empty doc
- selectionStart=1 assumes first text pos is 1 (usually 0 after doc node)
- streamEndPos computed from editor.state.selection.from AFTER streaming, but streaming
  inserts may move selection unpredictably
- catch block: only `editor.commands.undo()` — leaves mid-stream mess if streaming failed
- No cleanup: editor.setEditable(false) until finally
### Fix plan (in page.tsx):
- Snapshot `originalHtml = editor.getHTML()` at start
- Do NOT pre-delete; stream into a temp variable only (or append at selection with addToHistory:false)
- On completion: ONE history action = replace original range with new HTML (transaction)
- On failure/mid-flight: transaction rollback setContent(originalHtml)
- Extract helpers: runAITransaction / rollback
- Keep sanitize of AI html? AI output is text→convertTextToHTML (already escaped) ✓

## M4 implementation details (being written)
- Handle: src/app/workspace/editor/[fileId]/page.tsx handleAIOperation (lines 210-316)
- Fix: snapshot originalHtml at start, don't pre-delete; stream into temp var; on success single transaction replace; on failure rollback setContent(originalHtml); extract helpers runAITransaction/rollback + tests

## M3 context (from code reading)
- files table already has deletedAt (line 32 in schema.ts) + partial unique index on (userId, parentFolderId, title) WHERE deleted_at IS NULL + indexes idx_files_user_deleted, idx_files_parent_user (all from M1 commit)
- deleteFile currently HARD deletes (file-ops.ts lines 133-159) with cascade comment
- Need: deleteFile → soft delete (UPDATE deleted_at = NOW), restoreFile server action,
  verify all file queries filter deletedAt IS NULL (getFile, getFolderChildren, listFiles?),
  30-day purge job (cron route /api/cron/purge-deleted or documented cleanup)
- check: getFile (line ~?), getFolderChildren, copyFile (uses getFile ok), list queries in sidebar

## M5 FINAL STATE (ALL GREEN — ready to push + report)
- Branch production-readiness off merge (188c443): commits 0120f9d M1, a1ba689 M2,
  0ca2601 M4, d3c9779 M3
- FINAL CHECKS: tsc exit 0 (0 errors); vitest 15 files / 202 tests ALL PASS
  (incl. 3 ai-ops integrity [Postgres real], 5 file-ops softdelete [Postgres real],
  6 sanitize XSS, 4 ai-transaction); build ✓ Compiled successfully 4.8s;
  lint 66 problems (20 err/46 warn) = IDENTICAL to merge baseline — no regression
- Test files created: src/server/actions/ai-ops.integrity.test.ts, src/server/actions/
  file-ops.softdelete.test.ts, src/lib/ai-transaction.test.ts, src/lib/sanitize.test.ts
- Infra: src/test/db.setup.ts, src/test/test-db.ts, vitest.setup.ts (.env→.env.test),
  drizzle.config.test.ts (pg driver), local Postgres 16.14 db lugx_test (user lugx)
- Key decisions: soft-delete partial unique index w/ COALESCE nil-uuid; purge route
  uses CTE-bounded DELETE (prepared stmts reject parameterized LIMIT);
  sanitize split client (native DOMPurify) / server (jsdom, serverExternalPackages),
  smartConvertToHTML moved to parsers/text-to-html.server.ts
- Remaining: git push origin production-readiness + Arabic final report
  (report file LUGX_Production_Roadmap_Execution_AR.md in repo root)
- Deliverable report structure: executive summary, per-milestone sections (M0-M5),
  tests table (202 tests, 18 new), known limitations, merge PR recommendation

## M3 progress (in flight) — LATEST STATE
- file-ops.ts DONE: deleteFile → soft delete, restoreFile added,
  getFile/getUserFiles/getRootFiles/getFolderChildren filter isNull(deletedAt),
  updateFileContent/renameFile/moveFile REJECT tombstoned rows (isNull guard + rowCount check)
- purge route created: src/app/api/cron/purge-deleted/route.ts (CRON_SECRET Bearer auth,
  30-day retention, BATCH_LIMIT=500). IMPORTANT BUG FOUND: DELETE ... LIMIT $2 parameterized
  fails in pg prepared statements (syntax error) — must use fixed LIMIT literal:
  await db.execute(sql`DELETE FROM files WHERE deleted_at <= ${cutoff} LIMIT 500`)
- schema.ts fix: unique partial index now uses COALESCE(parent_folder_id, nil-uuid)::uuid
  (Postgres partial unique ignores NULL keys, so root-folder files were NOT unique-enforced)
- 0003 SQL + local DB (lugx_test) both updated with COALESCE index
- TEST BUG FOUND: fileOf() omits storagePath/etag explicitly with ''/0 causing wrong param
  count (drizzle insert lists all 12 cols incl. 'default' for storage_path —
  fix test: include storagePath: null and etag: null in fileOf, or use drizzle columns correctly)
- M3 test file: src/server/actions/file-ops.softdelete.test.ts (3/5 pass;
  2 fail: unique-name test params bug + purge LIMIT param bug)
- After fixes: tsc clean, vitest full suite, build, commit M3, then M5

## M3 progress (previous)
- file-ops.ts DONE: deleteFile → soft delete (UPDATE deletedAt), restoreFile added
  (ownership check + purged-row guard), getFile/getUserFiles/getRootFiles/
  getFolderChildren now filter isNull(deletedAt)
- Remaining M3: updateFileContent filter? (writes, ok), createFile (ok),
  copyFile (reads via getFile ok), renameFile/moveFile (should reject/restore tombstones?
  — moveFile/renameFile currently UPDATE without deletedAt guard — tombstoned row
  can be moved/renamed; add isNull guard)
- Need: purge route /api/cron/purge-deleted (DELETE WHERE deleted_at < NOW()-30d)
  + auth check (cron secret env var CRON_SECRET)
- Need tests: file-ops.integrity.test.ts with local postgres (use src/test/test-db.ts
  pattern from ai-ops.integrity.test.ts + src/test/db.setup.ts runMigrations)
- Commits: 0120f9d M1, a1ba689 M2, 0ca2601 M4 (M4 = ai-transaction.test.ts, 4 tests)
- M4 done: snapshot + single-transaction apply + rollback in editor page.tsx
- M5 then: final tsc/vitest/build/lint + git push origin production-readiness + Arabic report
- Report deliverable: Arabic markdown with exec summary, per-milestone details, tests table

## Remaining phases
- M3: soft-delete lifecycle (tombstone + restoreFile action + 30-day purge job)
  Files: src/server/actions/file-ops.ts (deleteFile hard-deletes!), src/lib/db/schema.ts (files has deleted_at? verify), maybe src/cron or a new route
- M5: final sweep + push to origin + report (report file: Arabic markdown attached)

## Roadmap doc: M0-M5 in LUGX_Production_Roadmap_Execution_AR.md (earlier session)
## Base commit tip of merge branch: 188c443

## M6 UI (RESTORE SURFACE) — DONE @ cfdc4f1
- file-ops.ts: new getDeletedFiles() (isNotNull deletedAt, newest-first, ownership via getUser)
- sidebar.tsx: Trash section (collapsible Deleted Files row + badge, load-on-open),
  TrashFileRow (muted, strike-through title, retention hint Today/Yesterday/Nd left/30d+),
  reuses FileContextMenu with isDeleted flag
- file-context-menu.tsx: isDeleted prop; tombstone mode shows ONLY Restore (RotateCcw,
  indigo-400); Delete/Copy/Move/Rename hidden for tombstones; Restore → restoreFile + refresh both lists
- FINAL: tsc 0 errors; vitest 202/202 (15 files); build Compiled successfully
- docs/Production Readiness Roadmap — M0-M5 Execution Record.md created (this round's doc)
- Remaining: commit UI + doc, push origin production-readiness, deliver tar.gz + Arabic report
