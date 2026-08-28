# Changelog - LUGX Project

All notable changes to the LUGX project will be documented in this file.

## [1.17.0] - 2026-08-28 (Complete Dead Code & HTML Converter Purge, TipTap Legacy Style Elimination)

### Removed - Complete Dead Code & HTML Converter Elimination
- **Deleted Dead HTML & Sanitizer Files:** Completely removed `src/lib/parsers/text-to-html.ts` (124 lines), `src/lib/sanitize-client.ts` (66 lines), `src/lib/sanitize.server.ts` (57 lines), and `src/lib/sanitize.test.ts` (72 lines).
- **Purged Unused HTML Converter Functions:** Removed `formatStreamOutputToHTML` and `sanitizePreviewChunk` from `src/lib/parsers/stream-markdown.ts`, and `htmlToPlainText` from `src/lib/exporters/utils/markdown-stripper.ts`.
- **Eliminated Dead CSS Styles (`src/app/globals.css`):** Removed 123 lines of legacy `.tiptap-editor` and `.ProseMirror` style declarations and obsolete text-direction utility classes.
- **Uninstalled Dead Dependency (`dompurify`):** Removed `dompurify` from `package.json` and cleaned up `serverExternalPackages: ["jsdom"]` from `next.config.ts`.
- **Cleaned Stream Hook (`src/hooks/use-ai-stream.ts`):** Removed unused `formatStreamOutputToHTML` import and dead `safeHtml` variable assignment.

### Changed - Test Modernization & Documentation Synchronization
- **Stream Parser Test Modernization (`src/test/ai-stream-parser.test.ts`):** Focused test suite strictly on `validateStreamMarkdownOutput` and NDJSON wire protocol framing.
- **Synchronized Documentation (`README.md`, `docs/`):** Updated technical stack tables, security definitions, and exporter guides to reflect pure UTF-8 Markdown single source of truth.

## [1.16.0] - 2026-08-27 (AI Stream Collision Guard, Non-Colliding Edit Tolerance & Clean Documentation Sync)

### Added - AI Stream Collision Guard & Dynamic Range Shifting

- **Collision-Aware Dynamic Selection Shifting (`src/components/editor/markdown/streaming-ghost.ts`):** `codeMirrorStreamingGhostField` tracks all document mutations via `tr.changes.iterChanges`. Non-overlapping edits occurring elsewhere in the document dynamically shift the AI generation bounds `[from, to]` via `mapPos(from, 1)` and `mapPos(to, -1)`, allowing the user to write and edit freely without interrupting AI generation.
- **Direct Collision Abort Protection:** Direct edits overlapping with the target generation range dismiss the ghost decoration and safely trigger `onStop()` to prevent text corruption.
- **Orchestrator Manual Edit Policy (`src/hooks/use-editor-orchestrator.ts`):** Updated `handleEditorChange` to query `adapter.getGhostRange()`, preserving active streaming sessions on non-colliding manual edits.

### Changed - Code Hygiene & Test Setup Modernization

- **Dead Code Elimination (`src/lib/sync/conflict-resolver.ts`):** Removed obsolete HTML tag scanning (`isHtml`) from the pure Markdown three-way merge tokenizer.
- **Centralized JSDOM CodeMirror Polyfills (`vitest.setup.ts`):** Centralized `Range.prototype.getClientRects` and `Range.prototype.getBoundingClientRect` polyfills in the central setup file for unified CodeMirror 6 testing reliability.
- **Documentation Modernization (`docs/`):** Purged obsolete TipTap and HTML references across `docs/architecture/` and `docs/specs/` to guarantee 100% synchronization with the source code.

## [1.15.0] - 2026-08-27 (Markdown Migration Phase 6: Complete TipTap Purge & Final Verification Closure)

### Removed - Complete TipTap & ProseMirror Dependency Purge

- **Uninstalled 4 `@tiptap/*` packages:** Completely removed `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, and `@tiptap/extension-placeholder` from `package.json` and `package-lock.json` (63 packages removed).
- **Deleted Legacy TipTap Extensions:** Deleted `src/lib/extensions/direction-extension.ts` and `src/lib/extensions/streaming-ghost-extension.ts` along with the `src/lib/extensions` directory.
- **Deleted Obsolete HTML Server Converter:** Deleted `src/lib/parsers/text-to-html.server.ts`.

### Added - Standalone CodeMirror 6 Plugins & Comprehensive E2E Tests

- **Standalone Streaming Ghost Plugin (`src/components/editor/markdown/streaming-ghost.ts`):** Encapsulated CodeMirror 6 `StateField`, `WidgetType`, `StateEffect`, and dynamic range tracking with zero external/TipTap dependencies.
- **Comprehensive Markdown Editor E2E Test Suite (`src/test/markdown-editor-e2e.test.ts`):** Established comprehensive test suite covering file hydration (NFC/LF), rapid typing, remote pull cursor preservation, offline caching & 3-way merge resolution, AI streaming preview & explicit decision flow, and pure Markdown/Text import/export fidelity.

### Changed - Type Modernization & Test Hardening

- **Enforced `EditorAdapter` Across AI Stream Hook (`src/hooks/use-ai-stream.ts`):** Removed all `@tiptap/react` imports and ProseMirror transaction branches; unified `EditorInstance` on `EditorAdapter`.
- **Modernized Legacy Test Suites:** Upgraded `editor-recovery-reload.test.ts`, `editor-atomic-commit.test.ts`, `ai-preview-decision.test.ts`, `ai-preview-decision.live.test.ts`, and `ai-transaction.test.ts` to pure `EditorAdapter` and CodeMirror 6.
- **Fixed Live Test Database Isolation:** Fixed user seeding and file title collision handling in `src/test/editor-orchestration.live.test.ts` and `src/test/ai-reservation-status.live.test.ts`.
- **Full Verification Passed:** 100% test pass rate across 546 total automated tests (477 unit + 69 live) and 0 TypeScript compilation errors with passing Next.js production build.

## [1.14.0] - 2026-08-27 (Markdown Migration Phase 5: Markdown AI Streaming, Direct Exporters & Unified Inline Preview)

### Added - Unified Inline Interactive Streaming Widget & CodeMirror 6 StateField

- **Unified Inline Interactive Preview Card (`CMStreamingGhostWidget` in `src/lib/extensions/streaming-ghost-extension.ts`):** Redesigned the inline ghost widget into a cohesive, high-performance Dark Glassmorphism interactive card (`bg-zinc-900/95 border-emerald-500/40`) positioned at the exact document mutation offset.
- **Embedded Decision Controls:** Embedded interactive action buttons directly inside the inline card header: `Stop Generation` during active streaming, and the 3 decision buttons (`Accept / Apply`, `Reject`, `Retry`) upon stream completion (`preview_ready`).
- **Layout Thrashing Elimination (`updateDOM` at 60fps):** Implemented `updateDOM(dom)` on `CMStreamingGhostWidget` to update text and action states in-place, eliminating DOM destruction/recreation overhead during rapid token streaming.
- **Dynamic Position & Range Tracking (`codeMirrorStreamingGhostField`):** StateField utilizing `tr.changes.mapPos(from, 1)` and `mapPos(to, -1)` to dynamically shift the preview replacement coordinates when concurrent edits occur elsewhere in the document, preventing `RangeError` and offset drift.
- **Optimistic Concurrency Lock Self-Healing (`src/server/actions/ai-commit.ts`):** Added self-session healing to `commitAIFileOperation`. If `currentFile.version !== expectedVersion` but `currentFile.content` matches the baseline `originalContent`, the server adopts the current version without triggering spurious 412 conflicts. Added ETag normalization to strip quotation differences.
- **AutoSave Cancellation on AI Launch (`src/hooks/use-editor-orchestrator.ts`):** Added `.cancel()` method to `debounce` in `src/lib/utils.ts` and invoked `debouncedAutoSave.cancel()` on AI start to prevent background save race conditions.
- **Live Version Reading at Commit (`src/hooks/use-ai-stream.ts`):** Supported `getLatestVersion` and `getLatestETag` getters in `useAIStream` to query live orchestrator versions at commit time.

### Changed - Streaming Pipeline & Exporters

- **Eliminated Top Static Preview Panel (`src/app/workspace/editor/[fileId]/page.tsx`):** Permanently removed the redundant top fixed `<AIStreamPreview />` panel to eliminate UI duplication and focus distraction.
- **Pure Markdown AI Streaming Model (`src/lib/ai/stream-session.ts` & `src/lib/parsers/stream-markdown.ts`):** Converted session FSM and validator to operate on `originalMarkdown` and `resultMarkdown`. Added `validateStreamMarkdownOutput`.
- **Pure Markdown Exporters (`src/lib/exporters/`):**
  - `MarkdownExporter`: Generates `.md` Blobs directly from raw Markdown text without intermediate HTML parsing, guaranteeing 100% fidelity for tables, code blocks, blockquotes, and Arabic RTL text.
  - `TextExporter`: Strips Markdown syntax directly from source while preserving all code block contents and text structures.
  - `sanitizeFilename`: Strips control characters `\x00-\x1F\x7F` and enforces a 200-character ceiling.
- **Comprehensive Test Suites:** Added `src/test/markdown-exporters.test.ts` (6 tests) and updated `src/test/ai-preview-decision.test.ts` and `src/test/ai-server-atomic-commit.test.ts` (469 total tests passing 100%).

## [1.13.0] - 2026-08-26 (Markdown Migration Phase 4: Markdown Sync, Diff3 Syntax Integrity & 3-Way Conflict Resolution)

### Added - Markdown-Native Diff3 Engine & Conflict Handling

- **Pure Markdown 3-Way Merge (`src/lib/sync/reconciliation.ts` & `conflict-resolver.ts`):** Migrated 3-way conflict resolution engine to operate natively on Markdown text via line-based Diff3 algorithms, eliminating HTML serialization artifacts.
- **Markdown Structural Boundary Preservation:** Diff3 syntax integrity guards preserve Markdown list numbering, table rows, and fenced code block delimiters during merges.
- **Reconciliation Policy Matrix:** Standardized cold-start and background reconciliation policies (`bootstrap_server`, `apply`, `adopt_metadata`, `keep_local`) on raw Markdown baseline snapshots.

## [1.12.0] - 2026-08-26 (Markdown Migration Phase 3: Content Model, Storage & Internal Import Transformation)

### Added - Universal Markdown Normalization & ETag Determinism

- **Unified Normalization Function (`normalizeMarkdownSource` in `src/lib/sync/etag-generator.ts`):** Canonical normalization converting `\r\n` / `\r` to LF (`\n`), stripping null bytes (`\0`) for PostgreSQL text safety, and applying Unicode NFC normalization before ETag hashing and storage. Prevents spurious 412 Precondition Failed conflicts across operating systems (Windows/macOS/Linux) and Unicode composite encodings.
- **Deterministic ETag Hashing (`generateETag` / `generateETagSync`):** Integrated `normalizeMarkdownSource` into both asynchronous and synchronous ETag generators to guarantee identical SHA-256 digests across platforms.
- **Exported `MarkdownSource` Type Definition (`src/lib/sync/idb-types.ts` & `src/lib/sync/index.ts`):** Defined `MarkdownSource` type representing canonical UTF-8 Markdown text across client hooks, IndexedDB layers, operations log, and API payloads.
- **Dedicated Import Test Suite (`src/server/actions/import-file.test.ts`):** Created 9 automated tests validating pure Markdown extraction for MD, TXT, and PDF files, correct word counting, ETag stability, parent folder checks, 10MB payload size limit rejection, and single-query title collision resolution.

### Changed - Storage & Import Pipeline

- **Purged HTML Conversion from File Imports (`src/server/actions/import-file.ts`):** Removed `smartConvertToHTML`. MD and TXT imports decode base64 directly to normalized Markdown. PDF text extraction applies linear text extraction policy without artificial HTML conversion.
- **Collision-Free File Import (`import-file.ts`):** Implemented single-query in-memory title deduplication (`Title (1)`, `Title (2)`) preventing database `23505 unique_violation` exceptions on live partial unique index `idx_files_user_parent_title_live`. Added defense-in-depth base64 payload size validation.
- **Normalized Server Actions & REST API Updates (`file-ops.ts` & `/api/files/[id]/route.ts`):** `createFile`, `updateFileContent`, and `PUT /api/files/[id]` apply `normalizeMarkdownSource` before optimistic locking checks, ETag generation, and PostgreSQL persistence.
- **IndexedDB & Sync Layer Normalization (`use-sync.ts` & `use-editor-orchestrator.ts`):** `saveLocal` normalizes document text and operation snapshots in IndexedDB. Removed unused `sanitizeHtml` import from `use-editor-orchestrator.ts`.
- **Editor Adapter AI Stream Support (`src/hooks/use-ai-stream.ts`):** Added native support for `EditorAdapter` (`getSelection`, `getSelectedText`, `getValue`, `replaceRange`) alongside backward-compatible TipTap fallback.
- **Integration Test Modernization (`src/test/editor-orchestration.integration.test.ts`):** Updated 13 integration tests to use Markdown `EditorAdapter` mocks and pure Markdown strings.

## [1.11.0] - 2026-08-26 (Markdown Migration Phase 2: TipTap Replacement & Editor Tooling Integration)

### Changed - Primary Editor Surface & Tooling Integration

- **Replaced TipTap with Standalone MarkdownEditor (`src/app/workspace/editor/[fileId]/page.tsx`):** Purged `@tiptap/react`, `StarterKit`, `Placeholder`, `AutoDirectionExtension`, and `StreamingGhostExtension` from the workspace editor page. Substituted with `MarkdownEditor` and engine-agnostic `EditorAdapter`.
- **Pure Markdown Event Loop & Stats:** Replaced `editor.getHTML()` and `editor.on("update")` with synchronous `onChange(markdownText)` and raw Markdown text stats computation (Unicode/RTL-safe word and character counting).
- **Multi-Range Transaction Search & Replace (`src/components/editor/search-replace.tsx`):** Upgraded `SearchReplace` to operate on exact UTF-16 document offsets from `adapter.getValue()`. Replaced destructive string-rebuilding `replaceAll` with atomic `adapter.replaceRanges()` Multi-Range Transactions in CodeMirror 6, preserving the undo tree and preventing offset drift.
- **Markdown-Native Toolbar Formatting (`src/components/editor/ai-toolbar.tsx`):** Added native Markdown formatting operations (Headings, Bold, Italic, Inline Code, Lists, Blockquotes, Links) with intelligent cursor placement when selections are empty, plus a Live Preview vs Raw Source mode switcher.
- **Orchestrator Adapter Support (`src/hooks/use-editor-orchestrator.ts`):** Upgraded `useEditorOrchestrator` to interface with `EditorAdapter`, securing programmatic writes with `isProgrammaticUpdateRef` and dynamic editability toggles (`setEditable`).

## [1.10.0] - 2026-08-26 (Phase 14: Supabase Storage Removal & Database Schema Cleanup)

### Removed - Dead Code Elimination & Schema Cleanup

- **Removed `src/lib/supabase/storage.ts`:** Permanently removed the unused Supabase Storage client wrapper (`uploadFile`, `deleteFile`, `getFileUrl`, `downloadFile`, `assertSafeStoragePath`). All file imports (PDF/MD/TXT) continue to extract text directly into Neon PostgreSQL via `importFile` without storing raw binary files in cloud storage.
- **Dropped `storage_path` Database Column (`src/lib/db/migrations/0007_drop_storage_path.sql` & `src/lib/db/schema.ts`):** Removed the legacy `storagePath` column from Drizzle ORM schema and added an SQL migration to drop `storage_path` from the PostgreSQL `files` table.
- **Test Suite Clean-up:** Purged obsolete storage path traversal tests from `src/test/cross-user-ownership.test.ts` and removed `storagePath: null` field mock fixtures across `editor-orchestration.integration.test.ts`, `file-ops.softdelete.test.ts`, `file-ops.lostupdate.test.ts`, and `route.putguard.test.ts`.
- **Environment & Architecture Documentation Sync:** Updated `.env.example` to reflect Supabase usage solely for Authentication (`@supabase/ssr` / `@supabase/supabase-js`), and synchronized architectural references across `security-and-rate-limiting.md` and `file-ownership-and-versioning.md`.

## [1.9.0] - 2026-08-26 (Phase 13: Stripe Webhook, Durable Idempotency & Subscriptions Hardening)

### Added - Durable Event Ledger & Database Migration (`subscription_events`)

- **Durable Webhook Idempotency Ledger (`src/lib/db/migrations/0006_subscription_events.sql` & `src/lib/db/schema.ts`):** Created the `subscription_events` PostgreSQL table with a unique index on `event_id` (`idx_subscription_events_event_id`). Deduplication is now backed authoritatively by the database ledger, surviving server restarts, worker restarts, and serverless cold starts. Fast-path in-memory caching is retained with zero-allocation Set iteration eviction bounded at 10,000 entries.
- **Transactional Atomic Transitions (`executeSubscriptionTransition` in `subscription-actions.ts`):** Wrapped user tier updates, subscription upserts, and event recording within single atomic database transactions, guaranteeing complete All-or-Nothing ACID semantics.
- **Terminal State Protection:** In `handleSubscriptionUpdated`, incoming events attempting to transition a `canceled` subscription back to `active` are rejected and recorded as `ignored_stale`, preventing delayed out-of-order webhook packets from reviving terminated subscriptions.
- **Local DB Invoice Reconciliation:** `handleInvoicePaymentFailed` queries the user's subscription directly from local PostgreSQL database state by `userId`, eliminating external Stripe API network round-trips and rate limit consumption.

### Fixed - Subscription Billing Period Normalization (3-Location Invariant)

- **Decoupled Period Extraction (`extractPeriod`):** Fixed the legacy defect where `start_date` was duplicated into both `currentPeriodStart` and `currentPeriodEnd`. Billing periods are now accurately extracted from `SubscriptionItem` (`item.current_period_start/end`) or associated `Invoice` line items (`invoice.lines.data[0].period.start/end`), strictly enforcing the invariant `currentPeriodEnd > currentPeriodStart`.
- **Fail-Closed Unmapped Status Handling:** Any unrecognized subscription status triggers fail-closed error handling, logging the discrepancy without mutating or corrupting the user's tier in the database.
- **Live Test Suite Expansion (`src/app/api/stripe/webhook/route.live.test.ts`):** Added 6 live integration tests on the isolated Neon test branch verifying real HMAC signatures, durable restart deduplication, period date invariants, fail-closed unmapped status isolation, and live terminal state protection.

## [1.8.0] - 2026-08-25 (Phase 12: Authentication, OAuth & Operation Ownership Hardening)

### Added - Security Hardening & Safe Redirection (`src/lib/auth/safe-redirect.ts`)

- **Deterministic Safe Redirect Path Resolver (`resolveSafeRedirectPath`):** Universal protection against Open Redirect and Host Header Injection vulnerabilities. Enforces `MAX_URL_LENGTH = 2048`, universal backslash rejection, `NFKC` Unicode homograph rejection, control/null-byte stripping, 3-pass decoding, and scheme/pseudo-protocol rejection (`javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, `about:`, `mailto:`, `tel:`, `sms:`, `urn:`).
- **OAuth Callback Hardening (`/auth/callback`):** Enforces canonical trusted origin resolution (`NEXT_PUBLIC_APP_URL || origin`) and ignores spoofable `x-forwarded-host` headers.
- **Deep Link & Search Parameter Preservation (`src/middleware.ts`):** Preserves pathname and query string (`${pathname}${search}`) on unauthenticated login redirects, ensuring seamless return to active editor documents.
- **Atomic UPSERT User Synchronization (`syncUserToDatabase`):** Eliminates race conditions during concurrent OAuth logins with atomic `onConflictDoUpdate` on `users.id` and `onConflictDoNothing` on `(user_id, date)` usage rows.

### Changed - Unified Anti-Enumeration Error Mapping (404 vs 403)

- **Unified 404 Not Found Semantics:** `createFile`, `copyFile`, `moveFile`, `getFile`, `updateFileContent`, `deleteFile`, `restoreFile`, and `importFile` return `404 Not Found` for unauthorized or foreign parent/file resources to prevent attacker resource enumeration.
- **AI Streaming Route Payload & Ownership Validation (`/api/ai/stream`):** Enforces non-empty string type validation on `fileId` (400 Bad Request on invalid format) and verifies session ownership against database records before quota reservation (404 Not Found if missing/foreign).
- **Tenant-Isolated Storage Paths (`src/lib/supabase/storage.ts`):** Enforces `${userId}/` path prefix via `assertSafeStoragePath` and blocks directory traversal (`..`) sequences.
- **Dead Code Cleanup:** Permanently removed unused legacy email authentication functions (`signInWithEmail`, `signUpWithEmail`, `normalizeAuthKey`) from `src/server/actions/auth-actions.ts`.
- **Subscription Server Action Encapsulation:** Removed `'use server'` directive from `src/server/actions/subscription-actions.ts` to restrict DB mutation helpers to server-internal usage only.
- **Hierarchy Traversal Cycle Guards:** Added `visited` set guard in `getDescendantIds` and `restoreFile` BFS queues to prevent infinite loops on cyclic parent structures.

## [1.7.0] - 2026-08-25 (Phase 11: Editor Sync Orchestration, Hydration Lifecycle & Reload Recovery)

### Added - Hydration Lifecycle & Sync-Before-Write (`useEditorOrchestrator`)

- **Three-state hydration lifecycle (`hydrating` | `ready` | `fatal`):** TipTap editor surface begins frozen (`setEditable(false)`), and `handleEditorChange` / `canAutoSave` / `executeServerWrite` guard against pre-hydration writes until the initial load pipeline settles.
- **Offline-First Contract:** A transport/network failure during hydration never freezes the editor (`ready`); offline composition completes locally into durable dirty IndexedDB snapshots, reconciling later through standard optimistic locking. Fatal is strictly reserved for server-answered missing files with no local snapshots.
- **Tab-Scoped SessionStorage Reload Recovery (`pending-operation-store.ts`):** Tracks in-flight and preview operations across hard page reloads. Remount queries `getAIReservationStatus(operationId)` to settle orphaned quotas idempotently without applying abandoned preview text.
- **UI Hydration Integration (`page.tsx`):** Added subtle backdrop loader during initial sync, fatal error recovery card with workspace navigation, and real-time status bar sync indicator (`Syncing...`).
- **Single-Flight Document Switching:** Identity-stable execution keyed on `loadedFileIdRef` with unmount cancellation cleanup (`cancelled = true`).

### Changed - Honest Cold-Start Reconciliation (`reconciliation.ts`)

- `classifyRemoteUpdate` now operates over `localBaseline: LocalBaseline | null`, eliminating fabricated `v1/null` comparisons.
- Introduced `bootstrap_server` (clean cold start) and `adopt_metadata_keep_edits` (eager in-flight typing preserved).
- Unified `markServerPersisted(updatedAt)` across bootstrap, apply, and metadata adoption to eliminate persistent red save dot on cold opens.

### Fixed - Technical Debt & Suite Governance

- **TD-04 Resolved:** Fixed legacy test ESLint violations with typed `CycleFolderRow` maps and pruned unused imports.
- **TD-06 Resolved:** Removed dead `SyncStatus['error']` union member and updated `sync-indicator.tsx`.
- **Test Scripts Normalized:** Converted default `npm test` to non-interactive `vitest run` to eliminate watch-mode hangs, adding `test:watch` for interactive development.

## [1.6.0] - 2026-08-23 (AI Preview Explicit Decision Model & Data-Safety Hardening)

### Added - Explicit Preview Decision Model (`useAIStream`)

Stream completion no longer auto-commits. The sanitized AI output is parked in
`preview_ready`, and the user decides via three explicit actions in `AIStreamPreview`
(`src/hooks/use-ai-stream.ts`, `src/components/editor/ai-stream-preview.tsx`,
`src/app/workspace/editor/[fileId]/page.tsx`):

- **Accept (`commitPreview`)** — server-first atomic commit (`commitAIFileOperation`)
  then a single atomic ProseMirror transaction replacing `[from, to]`. Handles the
  existing 412 conflict rollback path unchanged. The preview panel hides on Accept
  exactly like on Reject (`setPreviewText` cleared on commit success).
- **Reject (`rejectPreview`)** — ghost dismantled, document untouched, session released.
- **Retry (`retryPreview`)** — settles the current preview exactly like a rejection,
  then starts a brand-new stream with identical inputs (`lastParamsRef`).

### Changed - Quota Policy: Explicit Settlement for User Decisions

Refunds are now reserved strictly for **system failures** (stream startup/mid-stream
errors, client exceptions, 412 conflicts). Any **user-driven outcome** settles the
reservation as consumed via idempotent `commitAIReservation(operationId)` — no document
write, pinned against the TTL sweeper and stray refunds (`already_committed`):

| Outcome                                                   | Quota action                    |
| --------------------------------------------------------- | ------------------------------- |
| Stream failure / startup error / exception / 412 conflict | Refund                          |
| Reject completed preview                                  | Settle as consumed              |
| Retry (old session; new session reserves fresh quota)     | Settle as consumed              |
| Stop a running generation (`stopStream`)                  | Settle as consumed BEFORE abort |
| Teardown/unmount while preview awaits decision            | Settle as consumed              |

Key ordering guarantee: `stopStream` awaits the settlement round-trip **before**
aborting the fetch, so the server-side disconnect refund handler (`cancel()` in
`/api/ai/stream/route.ts`) deterministically no-ops with `already_committed` instead
of winning the race. Full matrix: `docs/architecture/ai-quota-reservation-lifecycle.md` §4-D.
Autosave suspension gate (`canAutoSave`) extended to cover `preview_ready`.

### Fixed - Sync & Restore Data-Safety

- **`pullFile` tombstone guard (`sync-manager.ts`)** — a server tombstone no longer
  silently deletes a local copy carrying unsaved edits (`isDirty`); the case escalates
  to an explicit conflict instead of discarding user content.
- **`restoreFile` full cascade (`file-ops.ts`)** — restoring a folder now clears
  tombstones across the entire descendant tree (BFS including deleted nodes),
  symmetric with the cascading delete depth.

### Changed - Autosave Debounce Constant

- Extracted `EDITOR_AUTOSAVE_DEBOUNCE_MS = 1000` into `src/config/editor.config.ts`
  (behavioral no-op; documents the earlier 400ms -> 1000ms decision).

### Fixed - Test Database Safety (Root Cause of the Data-Loss Incident)

**Incident:** files created through the app vanished permanently from both the UI and
the database after a period away. Root cause (closed): integration-test `afterAll`
hooks in `ai-ops.integrity.test.ts` and `file-ops.softdelete.test.ts` executed
**unscoped** `DELETE FROM usage` / `DELETE FROM files` statements, and since
`vitest.setup.ts` loads `.env.local`, they ran against the **live Neon database** —
wiping every user's rows on every full test run. No production code was at fault.

Remediation (`docs/records/test-database-safety.md`):

- Both wipes are now scoped to their `TEST_USER_ID`.
- New guarded helper `cleanupTestUsers(ids, { emailPattern? })` deletes ONLY
  placeholder-pattern test accounts; wired into all 8 user-seeding suites with
  per-suite ids (parallel-worker safe). Refund suite id de-conflicted to `1212…`.

### Added - Tooling

- `scripts/db-testusers-probe.mjs` — live-DB probe reporting placeholder test
  accounts vs real users (`node scripts/db-testusers-probe.mjs`).

### Tests

- New suite `src/test/ai-preview-decision.test.ts`: preview_ready parking (no commit,
  no mutation), reject/settle-no-refund, accept/server-first commit + panel hide,
  retry settle + fresh session, mid-generation stop settle-no-refund.
- New `sync-manager.test.ts` cases: clean-copy tombstone deletion preserved;
  dirty-copy tombstone escalates to conflict without deletion.
- Full suite green: 36 test files / 371 tests.

## [1.5.0] - 2026-08-23 (Runtime Remediation: AI Streaming & Local-First Editor Sync)

### Fixed - AI Streaming Deadlock & Invisible Ghost Preview

Root-cause remediation for four compounding runtime defects; full analysis in
`docs/specs/AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md` (§5a) and
`docs/reference/UI_STREAMING_ARCHITECTURE_IMPLEMENTATION.md` (§6.3):

- **Detached async completion (`stream-handler.ts`)** — rejections inside the async commit
  pipeline are now routed into `onError`, guaranteeing exactly one terminal callback per
  session (previously an unhandled promise rejection stranded the session, leaked the quota
  reservation, and permanently locked the in-flight trigger mutex).
- **Provider abort propagation (`client.ts`)** — the downstream `AbortSignal` is forwarded
  into Gemini SDK request options so user cancellation and client disconnects terminate the
  upstream socket instead of pinning `reader.read()` until generation finishes server-side.
- **Runtime watchdogs (`stream-handler.ts`)** — first-chunk (20s) and absolute-duration
  (120s) ceilings fail closed with structured errors instead of hanging the editor session.
- **Preview buffer integrity (`use-ai-stream.ts`)** — only the latest delta is appended to
  the ephemeral buffer (the previous accumulated append grew it quadratically).
- **Feature-flag enforcement (G10)** — `/api/ai/stream` now branches on
  `AI_STREAMING_ENABLED` with `processWithAI` as the buffered NDJSON fallback.

### Fixed - UI-Blocking Synchronization (Text Vanishing Mid-Typing)

Full policy specification in `docs/architecture/editor-sync-orchestration.md` (§6a):

- **Stable orchestrator lifecycle** — the navigation callback identity no longer re-triggers
  the initial-load effect on every render; the IDB-paint + background-fetch + reconciliation
  pipeline runs exactly once per mounted `fileId`.
- **Deterministic reconciliation policy** (`src/lib/sync/reconciliation.ts`) replacing the
  blind content overwrite:
  - `apply` — fast-forward when local is clean and the remote revision is verified-newer
    (version advanced + ETag changed + corroborating timestamps), i.e. built on our state;
  - `adopt_metadata` — identical payload adopts authoritative version/ETag silently;
  - `keep_local` — dirty divergence or non-newer remote retains local truth without
    advancing anchors, surfacing a genuine `412` through explicit three-way conflict flow.
- **Programmatic transaction guard wiring** — AI atomic commits and rollbacks are wrapped by
  `onProgrammaticTransaction` so post-commit autosave races are eliminated.

### Tests

- New: `reconciliation.test.ts` (8 decision-matrix tests),
  `ai-stream-completion-terminality.test.ts` (3 terminality/watchdog tests),
  `ai-client-abort-propagation.test.ts` (SDK request-options assertion).
- Regression verified clean: parser, session FSM, ai-transaction, editor atomic commit,
  use-sync (45/45); `tsc --noEmit` 0 errors.

---

## [1.4.0] - 2026-08-21 (Phase 9: TipTap Editor, Auto-save & Sync Orchestration)

### Added - Centralized Editor Orchestration & Authoritative Write Controller

#### Core Architecture & Controller

- **Centralized Editor Orchestrator Hook** (`src/hooks/use-editor-orchestrator.ts`)
  - Decomposes editor state into 6 isolated state slices: Document, Preview, Dirty, Server Version, Conflict, and Write State.
  - Acts as the single authoritative write gateway for manual saves, AI commits, conflict resolutions, and sync replays.
  - Strict AutoSave suspension invariants: auto-save is paused during active streaming (`streaming`, `reserved`), committing (`committing`), active conflicts (`conflict`), sync stoppage (`stopped`), and programmatic updates (`setContent`).
  - Target-scoped manual edit policy: user modifications inside the active AI streaming selection abort generation, refund quota, and clear ghost decorations immediately; edits to other paragraphs outside the target range proceed without interrupting the AI stream (coordinates mapped automatically via ProseMirror `tr.mapping`).

- **Unified Editor Workspace Page** (`src/app/workspace/editor/[fileId]/page.tsx`)
  - Refactored page component to delegate all state and write management to `useEditorOrchestrator`.
  - Integrated `AIStreamPreview`, `AIStreamStatus`, `ConflictDialog`, and `SyncIndicator` directly with the centralized orchestrator.
  - Sibling tab version synchronization for clean tabs with optimistic version precondition locking for dirty tabs.
  - Page unload & navigation guards (`beforeunload`) protecting dirty or in-flight committing states.

- **Cleanup of Redundant Editor Instances**
  - Removed unused duplicate canvas component (`src/components/editor/editor-canvas.tsx`) ensuring zero competing editor paths.

- **Technical Architecture Documentation** (`docs/architecture/editor-sync-orchestration.md`)
  - Full architectural specifications, state slicing, AutoSave suspension invariants, and target-scoped manual edit policy.

#### Automated Integration Test Suite (48 Tests Passing, 100% Rate)

- `src/test/editor-orchestration.integration.test.ts` (7 Integration tests)
- `src/test/editor-atomic-commit.test.ts` (4 Editor Atomic Commit tests)
- `src/hooks/use-sync.test.ts` (13 Sync Hook tests)
- `src/test/conflict-resolution.integration.test.ts` (3 Conflict Resolution tests)
- `src/test/ai-stream-session.test.ts` (12 Session tests)
- `src/test/ai-server-atomic-commit.test.ts` (10 Server Commit tests)

---

## [1.3.0] - 2026-08-21 (Phase 8: AI Atomic Commit & Transactional Settlement)

### Added - AI Atomic Commit Architecture & Real PostgreSQL Verification

#### Core Transactional Architecture

- **Transactional Database Client** (`src/lib/db/transactional.ts`)
  - WebSocket-enabled Neon Serverless Pool for interactive SQL transactions (`BEGIN` / `COMMIT` / `ROLLBACK`).
  - Hardened connection limits and timeout boundaries (`max: 5`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`) preventing orphaned reservations.

- **Atomic Commit Server Action** (`src/server/actions/ai-commit.ts`)
  - Atomic transaction executing file content update (`files` table), version increment, ETag calculation, and quota reservation settlement (`aiReservations` table -> `committed`) inside a single database transaction.
  - Server-side optimistic locking with explicit `412 Conflict` on concurrent modifications (`WHERE version = expectedVersion`).
  - Production transactional invariant: hard-fails if transaction client is unavailable in production.
  - Idempotent retries via `operationId` returning current persisted document state.
  - Lean conflict payload omitting large unneeded document bodies.

- **Editor Server-First Commit Invariant** (`src/hooks/use-ai-stream.ts`)
  - Server-first transaction: TipTap editor modifications applied as a single history step only after server transaction confirmation.
  - Ephemeral ghost preview cleanly removed on conflict or error, preserving pristine document state.

- **Technical Architecture Documentation** (`docs/architecture/ai-atomic-commit-architecture.md`)
  - Comprehensive specification of invariants, sequence diagram, test suites, and technical debt.

#### Automated Test Suite (44 Tests Passing, 100% Rate)

- `src/test/ai-atomic-commit.integration.test.ts` (6 Real PostgreSQL integration tests)
- `src/test/ai-server-atomic-commit.test.ts` (10 Unit / Contract tests)
- `src/lib/ai-transaction.test.ts` (5 Editor Unit tests)
- `src/test/editor-atomic-commit.test.ts` (4 Editor Invariant tests)
- `src/test/ai-quota-idempotency.test.ts` (8 Quota tests)
- `src/server/actions/ai-ops.refund.test.ts` (5 Real Quota Refund tests)
- `src/server/actions/ai-ops.integrity.test.ts` (6 Real Concurrency Integrity tests)

---

## [1.2.0] - 2026-08-21 (Phase 7: NDJSON Streaming & Session State Machine)

### Added - AI NDJSON Streaming & Finite State Machine

#### Core Streaming Architecture

- **Resilient NDJSON Stream Parser** (`src/lib/ai/stream-handler.ts`)
  - Canonical event framing: `start`, `chunk`, `metadata`, `done`, `error`, `cancelled`.
  - Multi-byte UTF-8 boundary preservation via `TextDecoder({ stream: true })`.
  - Incomplete EOF stream detection as `failed_incomplete_stream`.
  - Duplicate `done` protection and unknown frame resilience.
  - `MAX_LINE_BUFFER_CHARS` (256KB) line buffer flooding ceiling (ADV-01).
  - Single terminal callback emission guarantee (ADV-05).

- **Deterministic Session State Machine** (`src/lib/ai/stream-session.ts`)
  - Canonical state flow: `idle -> reserving -> streaming -> preview_ready -> committing -> committed`.
  - Terminal failure & cancellation states: `aborted`, `failed`, `conflict`, `rolled_back`.
  - Editor generation and version mismatch integrity guards (`assertSessionIntegrity`).
  - Double-decision prevention on late cancellations.

- **Route Handler Hardening & Quota Protection** (`src/app/api/ai/stream/route.ts`)
  - Emits structured NDJSON event frames with zero prompt/sensitive text leakage in headers.
  - Automatic quota reservation before stream dispatch and idempotent refund on client abort or mid-stream exceptions.
  - Strict payload validation and `MAX_INPUT_CHARS = 100,000` ceiling (ADV2-01).

- **Ephemeral Preview & Atomic Commit Hook** (`src/hooks/use-ai-stream.ts`)
  - Zero TipTap document mutation during streaming (appends strictly to `EphemeralPreviewBuffer` and ghost decoration layer).
  - Dynamic ProseMirror mapped selection coordinate resolution (`streamingGhostPluginKey`) preventing selection drift (ADV-04).
  - Non-abortable committing state guard preventing client/server version desynchronization (ADV2-02).

- **DOM XSS Sanitization in TipTap Ghost Widget** (`src/lib/extensions/streaming-ghost-extension.ts`)
  - DOM node construction via `document.createElement` and `textContent` (ADV-06).

- **AI Stream Status Indicator** (`src/components/editor/ai-stream-status.tsx`)
  - Accurate cancellation UI state reflecting non-abortable server transactions (ADV2-03).

- **Technical Documentation** (`docs/architecture/ai-streaming-protocol.md`)
  - Comprehensive specification of NDJSON framing, state transitions, adversarial edge cases, and quota lifecycle.

#### Automated Test Suite

- `src/test/ai-stream-parser.test.ts` (11 unit tests passed)
- `src/test/ai-stream-session.test.ts` (12 unit tests passed)

---

## [1.0.0] - 2026-01-27

### Added - Stripe Integration

#### Core Infrastructure

- **Stripe Library Wrapper** (`src/lib/stripe/index.ts`)
  - Customer management functions
  - Checkout session creation
  - Webhook signature verification
  - Subscription cancellation

- **Stripe Configuration** (`src/lib/stripe/config.ts`)
  - Price ID mappings for Pro and Ultra tiers
  - Tier validation utilities

#### API Routes

- **Create Checkout Endpoint** (`src/app/api/stripe/create-checkout/route.ts`)
  - User authentication and validation
  - Tier upgrade validation
  - Stripe customer creation/retrieval
  - Secure checkout session creation

- **Webhook Handler** (`src/app/api/stripe/webhook/route.ts`)
  - Signature verification for security
  - Event processing:
    - `checkout.session.completed` - Updates user tier on successful payment
    - `customer.subscription.updated` - Syncs subscription status
    - `customer.subscription.deleted` - Handles cancellations
  - Comprehensive error logging

#### Server Actions

- **Subscription Actions** (`src/server/actions/subscription-actions.ts`)
  - `updateUserTier()` - Updates user subscription tier
  - `updateUserStripeCustomerId()` - Links Stripe customer to user
  - `upsertSubscription()` - Creates/updates subscription records
  - `cancelUserSubscription()` - Handles subscription cancellation

#### UI Components

- **UpgradeButton Component** (`src/components/subscription/upgrade-button.tsx`)
  - Interactive upgrade button with loading states
  - Error handling with toast notifications
  - Smart disabled states based on tier hierarchy
  - Auto-redirect to Stripe Checkout

#### Documentation

- `STRIPE_SETUP.md` - Complete setup guide
- `FINAL_DOCUMENTATION.md` - Comprehensive technical documentation
- `CHANGELOG.md` - This file

### Changed

- **Account Page** (`src/app/account/page.tsx`)
  - Replaced static upgrade button with interactive `UpgradeButton` component
  - Added dual button display for Pro and Ultra tiers
  - Conditional rendering based on current tier:
    - Free: Shows both Pro and Ultra buttons
    - Pro: Shows Ultra button only
    - Ultra: Shows no buttons (highest tier)

- **Environment Configuration** (`.env`)
  - Added `STRIPE_PRO_PRICE_ID`
  - Added `STRIPE_ULTRA_PRICE_ID`

### Fixed

#### Fix #1: Non-functional Upgrade Button

- **Issue**: Upgrade buttons had no event handlers
- **Solution**: Created complete Stripe integration with API routes and webhook handling
- **Status**: ✅ Resolved

#### Fix #2: Webhook Configuration

- **Issue**: Webhooks not reaching correct endpoint
- **Root Cause**: Stripe CLI forwarding to wrong path (`/api/webhooks/stripe` instead of `/api/stripe/webhook`)
- **Solution**: Corrected Stripe CLI command and added detailed logging
- **Status**: ✅ Resolved

#### Fix #3: Tier Upgrade Flow

- **Issue**: Pro users unable to upgrade to Ultra
- **Root Causes**:
  - Restrictive disabled logic in UpgradeButton
  - Missing Ultra button in UI
  - API validation preventing Pro→Ultra upgrades
- **Solutions**:
  - Implemented tier hierarchy system (Free=0, Pro=1, Ultra=2)
  - Added both Pro and Ultra buttons with smart conditional rendering
  - Updated button text to show target tier
  - Fixed API validation logic
- **Status**: ✅ Resolved

### Security

- ✅ PCI-DSS Compliant (no card data storage)
- ✅ Webhook signature verification
- ✅ Server-side validation for all operations
- ✅ HTTPS required for production webhooks
- ✅ No hardcoded secrets (environment variables only)

### Supported Upgrade Paths

#### Allowed ✅

- Free → Pro ($0 → $12/month)
- Free → Ultra ($0 → $120/month)
- Pro → Ultra ($12 → $120/month)

#### Blocked ❌

- Same tier upgrades (Pro → Pro, Ultra → Ultra)
- Downgrades (Ultra → Pro, Ultra → Free, Pro → Free)

---

## Testing

### Test Mode Setup Required

1. Create Products in Stripe Dashboard (Test Mode)
2. Update Price IDs in `.env`
3. Run Stripe CLI: `stripe listen --forward-to http://localhost:3000/api/stripe/webhook`

### Test Card

- Number: 4242 4242 4242 4242
- Expiry: Any future date
- CVC: Any 3 digits
- ZIP: Any 5 digits

---

## Production Deployment Checklist

- [ ] Create Products in Stripe Live Mode
- [ ] Obtain Live API Keys (Secret + Publishable)
- [ ] Update production environment variables
- [ ] Configure production webhook endpoint
- [ ] Test in staging environment
- [ ] Deploy to production
- [ ] Monitor webhook events in Stripe Dashboard

---

**Version:** 1.0.0  
**Status:** Production Ready (after production keys setup)  
**Last Updated:** 2026-01-27
