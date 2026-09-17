# Code-Grounded Technical Execution Plan

This master roadmap defines the 20 engineering phases of the LUGX platform, tracking technical contracts, direct implementation steps, edge-case exception handling, closure tests, and transition gates.

---

## [Phase 1: Sync Lifecycle & User Scoping] — Status: ✅ CLOSED

### Technical Objective
Transform the client-side synchronization layer into a strictly scoped, user-bound and file-bound lifecycle, closing all network, timer, and storage resources upon session termination or component unmount.

### Direct Implementation Steps
- **Step 1:** Refactor `src/lib/sync/sync-manager.ts` so each manager instance binds to an explicit, non-empty `userId`, eliminating global singletons that retain operations across distinct user sessions.
- **Step 2:** Enforce that every manager instance requires an explicit `userId` and `fileId` or workspace scope, immediately rejecting operations if identity is missing rather than propagating empty identifiers to IndexedDB or API endpoints.
- **Step 3:** Refactor `src/hooks/use-sync.ts` to suspend manager initialization until user session resolution completes, binding initialization and teardown within a clean `useEffect` lifecycle.
- **Step 4:** Integrate cleanup in `use-sync.ts` with `operations-gc.ts`, cancelling active timers, event listeners, AbortControllers, and retry loops upon unmount or logout.
- **Step 5:** Standardize sync state transitions into explicit enumerations: `idle`, `loading`, `queued`, `syncing`, `conflict`, `failed`, and `stopped`, preventing transitions to `syncing` post-teardown.
- **Step 6:** Namespace `src/lib/sync/indexeddb.ts` stores with user identity, preventing opening database instances containing another user's cached records.
- **Step 7:** Connect `src/lib/sync/connection-detector.ts` with the queue so network reconnection triggers exactly one queue consumer, avoiding redundant parallel consumers.
- **Step 8:** Utilize `src/lib/sync/concurrency-manager.ts` to block concurrent conflicting operations on the same file before serialization is established.

### Exception & Edge Case Handling
- **Missing Identity (`userId === null/undefined/""`):** Disallow local database instantiation; transition immediately to a displayable stopped state.
- **Logout During Active HTTP Request:** Abort in-flight network requests; retain operation as retryable only if bound to the same user, then tear down resources.
- **User Session Switch in Active Tab:** Completely destroy previous manager instance before initializing the new one, purging old callback references.
- **Rapid Component Re-Mounting:** Guard against listener, timer, or consumer proliferation.
- **Offline Ingestion:** Enqueue operations exactly once with an immutable `operationId`.
- **Multiple Consecutive Online Events:** Suppress duplicate parallel queue consumers via mutex.

### Closure Tests
- `src/hooks/use-sync.test.ts` validating mount/unmount lifecycles, user switching, and logout during active sync.
- `src/lib/sync/sync-manager.test.ts` and `concurrency-manager.test.ts` asserting consumer counts and operation serialization.
- `indexeddb.test.ts` proving complete isolation of records across distinct user IDs.
- Phase closure requires verified absence of GC leaks, dangling listeners, or cross-user operation pollution.

---

## [Phase 2: Completion of Queue, GC, and Rollback] — Status: ✅ CLOSED

### Technical Objective
Transition local pending operations into a durable, retriable queue with deterministic garbage collection and transactional rollback, preventing data loss or unsafe duplicate writes.

### Direct Implementation Steps
- **Step 1:** Define the operation schema in `src/lib/sync/idb-types.ts` including `operationId`, `userId`, `fileId`, `baseVersion`, `status`, `attempts`, `nextRetryAt`, and `lastError`.
- **Step 2:** Implement a single FIFO consumer in `src/lib/sync/sync-manager.ts` reading pending items from IndexedDB and dispatching them sequentially to `/api/files/sync`.
- **Step 3:** Enforce deterministic bounded exponential backoff, routing operations exceeding max retries to a dead-letter `failed` state instead of infinite loops.
- **Step 4:** Constrain `src/lib/sync/operations-gc.ts` by age and status; never purge active operations or those tied to unresolved conflicts.
- **Step 5:** Bind `src/lib/sync/rollback.ts` to server outcomes, restoring prior local snapshots upon commit failure and retaining records until rollback success is confirmed.
- **Step 6:** Leverage `src/lib/sync/error-handler.ts` to categorize network errors, 401/403, 404, 409/412, 429, and 5xx into retryable vs non-retryable actions.

### Exception & Edge Case Handling
- **Browser Restart Mid-Sync:** Reset interrupted operations to `queued` unless confirmed by a terminal server status.
- **Duplicate Operation ID:** Server returns idempotent response without applying mutations twice.
- **Rollback Execution Failure:** Flag record as `rollback_failed` and exempt from automated GC.
- **File Deletion Concurrently with Pending Operations:** Resolve deletion decisions on the server via version/state without trusting stale local client cache.

### Closure Tests
- `parallel.test.ts` proving zero duplicate writes under concurrent queue dispatches.
- `rollback.test.ts` verifying snapshot restoration following simulated 4xx/5xx responses.
- Simulated system restart, GC cleanup cycles, and expiration verification using controlled clock mocks.

---

## [Phase 3: File Ownership, If-Match, and Versioning] — Status: ✅ CLOSED

### Technical Objective
Enforce server-side authentication, resource ownership, hierarchical parent validation, and optimistic concurrency on all file mutations, preventing lost updates and cross-tenant access.

### Direct Implementation Steps
- **Step 1:** Refactor `src/server/actions/file-ops.ts` and `/api/files/[id]` to derive user identity strictly from verified server session cookies, rejecting client-supplied `userId`.
- **Step 2:** Enforce parent folder ownership checks before create, move, or rename actions, verifying the parent folder is active, owned by the caller, and not a circular descendant.
- **Step 3:** Require `If-Match` headers or `expectedVersion` arguments on all updates, sync writes, and AI commits, exempting only initial file creation.
- **Step 4:** Execute version and ETag comparisons within a single database transaction, incrementing `version` and updating `etag` atomically.
- **Step 5:** Standardize HTTP status codes: 401 for unauthenticated requests, 403 for unauthorized resource access, 404 for missing entities, 409 for structural conflicts, 412 for stale precondition versions, 429 for rate limits, and 5xx for internal errors.
- **Step 6:** Unify soft delete and restore operations across `file-ops.ts` and `/api/files/sync`, preventing sync loops from reviving tombstoned entities without explicit restore commands.

### Exception & Edge Case Handling
- **Stale Precondition (`expectedETag` Mismatch):** Server rejects write without mutating content, returning current server state for conflict resolution.
- **Parent Folder Owned by Another User:** Return 403 without disclosing child existence.
- **Duplicate Update Mutation:** Return idempotent success if `operationId` matches.
- **Moving Folder Into Its Own Subtree:** Return 409 and abort transaction without partial updates.
- **Mutating Deleted File:** Return 404/409 without creating an implicit new document.

### Closure Tests
- Execute `/api/files/[id]/route.putguard.test.ts`.
- Execute `src/server/actions/file-ops.lostupdate.test.ts` and `file-ops.softdelete.test.ts`.
- Multi-user isolation integration tests on real PostgreSQL verifying cross-user parent rejection and stale `If-Match` rejection.

---

## [Phase 4: Three-Way Conflict Resolution] — Status: ✅ CLOSED

### Technical Objective
Anchor conflict resolution to verified base snapshots, implement structural 3-way text merges, and connect `ConflictDialog` directly to canonical persistence pipelines.

### Direct Implementation Steps
- **Step 1:** Refactor `src/lib/sync/conflict-resolver.ts` to require separate `base`, `local`, and `remote` content, rejecting merges when base snapshot is missing.
- **Step 2:** Persist base snapshot or base version alongside each local operation in IndexedDB prior to initiating edits.
- **Step 3:** Define deterministic merge outcomes for text, metadata, rename, move, delete, and restore actions.
- **Step 4:** Wire `src/components/sync/conflict-dialog.tsx` to render local, remote, and merged previews, passing user decisions to the editor controller.
- **Step 5:** Dispatch a single mutation with the incremented expected version upon user selection (local/remote/merge), updating IndexedDB and editor state only after server confirmation.
- **Step 6:** Block dialog dismissal or autosave execution while an unresolved conflict is active.

### Exception & Edge Case Handling
- **Corrupted or Missing Base Snapshot:** Escalate immediately to `manual_resolution_required`; disallow automated text merging.
- **Overlapping Range Collisions:** Insert explicit conflict markers; disallow silent overwriting.
- **Remote Delete vs Local Edit:** Present decision as delete vs restore; disallow automated resolution.
- **User Cancellation:** Retain dirty document state and prevent garbage collection of the pending operation.

### Closure Tests
- `src/lib/sync/conflict-resolver.test.ts` validating overlapping and non-overlapping merge ranges against real base snapshots.
- Browser interaction tests verifying `ConflictDialog` behavior under simulated 412 responses.
- Validation that resolved states persist accurately across page reloads.

---

## [Phase 5: Quota Reservation & Settlement] — Status: ✅ CLOSED

### Technical Objective
Implement an idempotent daily quota reservation lifecycle linked to AI operations via a fixed `periodKey` and atomic state transitions.

### Direct Implementation Steps
- **Step 1:** Align `src/lib/db/schema.ts` with `0005_ai_reservations.sql` columns: `operationId`, `reservationId`, `periodKey`, `status`, `reservedUnits`, `committedUnits`, `refundedUnits`, and `expiresAt`.
- **Step 2:** Refactor `src/server/actions/ai-ops.ts` enforcing unique constraints across `userId + operationId + periodKey`, returning existing reservation records on duplicate requests.
- **Step 3:** Fix `periodKey` at reservation creation time; never recalculate upon refund, commit, or retry.
- **Step 4:** Enforce strict state transitions: `reserved -> committed`, `reserved -> refunded`, `reserved -> expired`, preventing conflicting terminal states.
- **Step 5:** Make refunds strictly idempotent across reservation records and daily usage counters.
- **Step 6:** Tie AI failure, client abort, or 412 conflict to a single refund transaction, and successful completions to a single commit transaction.

### Exception & Edge Case Handling
- **Concurrent Identical Requests:** Enforce single row reservation and single quota deduction.
- **Refund After Commit:** Prohibit blind refunds against committed quota.
- **Reservation Expiration During AI Call:** Disallow commit if reservation expired; refund or fail closed.
- **Crossing UTC Midnight:** Maintain reservation locked to original `periodKey`.
- **Database Failure Post-Reservation:** Re-query database before creating duplicate reservations.

### Closure Tests
- `src/server/actions/ai-ops.integrity.test.ts` and `ai-ops.refund.test.ts`.
- `src/test/ai-quota-idempotency.test.ts` running on live PostgreSQL validating concurrent transactions and rollback recovery.

---

## [Phase 6: AI Client, Key Rotation & Circuit Breaker] — Status: ✅ CLOSED

### Technical Objective
Implement concurrent, fail-safe Gemini API key rotation and circuit breakers backed by Redis without quota leakage or credential exposure.

### Direct Implementation Steps
- **Step 1:** Define explicit key states: `healthy`, `exhausted`, `cooldown`, and `disabled`, including TTL and transition reasons.
- **Step 2:** Ensure key selection and counter increments are atomic under high concurrency via Redis commands.
- **Step 3:** Implement circuit breaker states: `closed`, `open`, and `half-open`, incorporating backoff delays and single-request probes in half-open state.
- **Step 4:** Categorize Gemini API errors (quota, timeout, transient, invalid request, auth); do not trigger key failover for unrecoverable request errors.
- **Step 5:** Scrub raw API keys, user prompts, and raw responses from application logs and structured error messages.
- **Step 6:** Propagate `AbortSignal` to the upstream provider client, returning cancellation status to the route without reporting success.

### Exception & Edge Case Handling
- **Redis Unavailable:** Fail-closed for quota-governed operations; prevent local unmetered execution.
- **All Keys in Cooldown:** Return structured retryable error containing `retryAfter` timestamp.
- **Provider Fails Mid-Stream:** Terminate session, trigger quota refund, and disallow partial content commits.
- **Multiple Requests in Half-Open Circuit:** Allow only a single probe request through.

### Closure Tests
- `src/lib/ai/client.test.ts` and `src/lib/ai/key-rotation.test.ts`.
- Concurrency tests for key selection, Redis disconnect handling, and TTL expiration.
- Live provider smoke test validating payload streaming through real client.

---

## [Phase 7: NDJSON Streaming & Session State Machine] — Status: ✅ CLOSED

### Technical Objective
Standardize the NDJSON streaming protocol between the stream route, client hooks, and session handlers without partial document corruption.

### Direct Implementation Steps
- **Step 1:** Standardize NDJSON message schemas: `start`, `chunk`, `metadata`, `done`, `error`, and `cancelled`.
- **Step 2:** Harden the parser in `stream-handler.ts` against UTF-8 boundary splits, newline fragmentations, multi-chunk JSON, incomplete EOFs, and unknown messages.
- **Step 3:** Enforce session state transitions in `stream-session.ts`: `idle -> reserving -> streaming -> preview_ready -> committing -> committed`, with terminal `aborted`, `failed`, and `conflict` states.
- **Step 4:** Isolate incoming chunks from document storage; stream tokens render strictly into ephemeral preview buffers and ghost decorations.
- **Step 5:** Bind generation counters and AbortControllers ensuring stale stream callbacks cannot mutate newer sessions.
- **Step 6:** Structure route handlers to handle provider failure, aborts, and network disconnects gracefully while settling quota reservations.
- **Step 7:** Maintain fallback buffered execution paths when streaming is explicitly disabled.

### Exception & Edge Case Handling
- **Empty Stream Chunk:** Ignore without triggering state transitions.
- **Corrupted JSON Chunk:** Emit `error` and terminate session without committing text.
- **Client Disconnect Prior to Done:** Abort upstream provider request, discard preview, and refund reserved quota.
- **Abort Triggered Post-Done Before Commit:** Honor abort; discard preview and refund quota.
- **Duplicate Done Event:** Accept first terminal event; drop subsequent duplicates.
- **Connection Closed Without Done Marker:** Transition to `failed_incomplete_stream`.

### Closure Tests
- `src/test/ai-stream-parser.test.ts` and `src/test/ai-stream-session.test.ts`.
- Integration tests over live HTTP route validating NDJSON framing.
- Browser verification confirming ghost preview remains isolated from stored content until accepted.

---

## [Phase 8: AI Atomic Commit] — Status: ✅ CLOSED

### Technical Objective
Execute verified atomic commits linking AI generation results, document versioning, and quota settlement without intermediate partial mutations.

### Direct Implementation Steps
- **Step 1:** Refactor `src/server/actions/ai-commit.ts` to validate user session, file ownership, reservation ownership, `operationId`, and `expectedETag` before opening transactions.
- **Step 2:** Execute version/ETag verification, document content mutation, and reservation commitment within a single Neon transaction.
- **Step 3:** Enforce idempotency on `operationId`, returning the confirmed commit result on retry without reapplying text mutations.
- **Step 4:** Defer local editor state mutation until server transaction returns success.
- **Step 5:** Suspend autosave and sync cycles during active `committing` state, resuming only after new version tags are applied.

### Exception & Edge Case Handling
- **HTTP 412 Precondition Failed:** Abort document write, do not commit quota, and return current server state for conflict handling.
- **Invalid Reservation Record:** Reject commit even if AI text generation succeeded.
- **Database Failure Inside Transaction:** Abort commit; ghost preview remains uncommitted.
- **Network Retry Following Unknown Outcome:** Query status via `operationId` before initiating new commit operations.

### Closure Tests
- `src/test/ai-server-atomic-commit.test.ts` and `src/test/editor-atomic-commit.test.ts` against real database branch.
- Simulated failure injections between document update and reservation settlement verifying rollback.
- Live 412 conflict handling verification in browser.

---

## [Phase 9: Session Execution Template Contract] — Status: ⚡ ACTIVE

### Current State
Mandatory procedural execution standard governing all implementation sessions in this repository.

### Derivation Constraint
First operational contract active across all work sessions.

### Technical Objective
Enforce deterministic single-phase session lifecycles, rigorous scoping, and verifiable closure reporting.

### Direct Implementation Steps
- **Step 1:** Formally define the phase identifier and whitelist permitted file modification boundaries.
- **Step 2:** Inspect existing call sites and test suites prior to mutating code.
- **Step 3:** Restrict modifications strictly within permitted phase boundaries.
- **Step 4:** Execute all automated unit and integration tests against the isolated Neon database branch without broad mock workarounds.
- **Step 5:** Audit local diffs to verify zero unintended side effects.
- **Step 6:** Emit final closure report declaring `CLOSED` or `BLOCKED` with active database branch ID, halting further phase execution in the same session.

### Exception & Edge Case Handling
- **Non-Runnable Test:** Document exact test identifier, root cause blocker, and required unblock conditions.
- **Out-of-Scope Failure:** Mark phase as `BLOCKED`; do not conceal or bypass failures.
- **Out-of-Scope File Edits:** Revert immediately or provide explicit engineering rationale.
- **Legacy Documentation Conflict:** Verified local code and test execution serve as ground truth.
- **Unintended Production Database Connection:** Halt immediately and re-bind environment to isolated branch.

### Closure Tests
- Produce standard closure report verifying branch isolation on every phase.

---

## [Phase 10: Neon Branch Test Database Isolation] — Status: ✅ CLOSED

### Current State
Completed. The test suite operates on an isolated Neon branch (`ep-plain-glitter-a4v9k614`) completely detached from production.

### Derivation Constraint
Phase 9 session governance.

### Technical Objective
Isolate all database integration tests onto dedicated Neon branches with fail-closed guards preventing tests from touching the production database.

### Direct Implementation Steps
- **Step 1:** Provision dedicated Neon test branch, saving connection strings in `.env.test.local` / `.env.test` (untracked in git).
- **Step 2:** Configure `vitest.setup.ts` to load `.env.test` with highest priority, binding `DATABASE_URL = TEST_DATABASE_URL`.
- **Step 3:** Deploy database schema to test branch via `drizzle-kit push --config drizzle.config.test.ts`.
- **Step 4:** Embed fail-closed guard in `src/test/test-db.ts` comparing connection host against production endpoints and halting test startup on match.
- **Step 5:** Log active database branch endpoint at the start of every integration test run.
- **Step 6:** Update technical debt registers reflecting permanent Neon branch isolation.

### Exception & Edge Case Handling
- **Branch Creation Failure:** Mark dependent phases as `BLOCKED`; never fallback to production.
- **Branch Expiration or Deletion:** Re-provision branch and apply schema before running tests.
- **Accidental Write to Production:** Immediate circuit breaker trip and incident response.
- **Schema Drift Across Branches:** Re-run migration push prior to test execution.

### Closure Tests
- Run integration suites on isolated branch while asserting zero row count changes on production.
- Deliberately inject production connection string to verify fail-closed guard halts execution.

---

## [Phase 11: Editor Orchestration & Single Write Path] — Status: ✅ CLOSED

### Current State
Completed. `useEditorOrchestrator` governs the single write path with dirty tracking, autosave suspension, and conflict dialog coordination.

### Derivation Constraint
Phase 9 contract and Phase 10 database isolation.

### Technical Objective
Verify that all document mutations pass through a single serialized write path under strict autosave suspension policies.

### Direct Implementation Steps
- **Step 1:** Audit all write pathways (manual save, AI commit, conflict merge, sync replay), verifying they serialize through `useEditorOrchestrator` via `WriteStateType`.
- **Step 2:** Enforce autosave suspension while states are `streaming`, `reserving`, `committing`, `conflict`, `stopped`, or `preview_ready`.
- **Step 3:** Verify single atomic undo history following AI commit operations.
- **Step 4:** Implement browser tests for reload events during preview states (verifying preview is not committed).
- **Step 5:** Validate navigation guards when navigating away during active commits.
- **Step 6:** Audit codebase verifying zero residual references to deprecated canvas components.

### Exception & Edge Case Handling
- **User Navigation During Commit:** Trigger warning and preserve operation state in queue.
- **Page Reload During Preview:** Query operation ID; do not treat preview as committed content.
- **Manual Typing During Stream:** Abort generation and refund quota.

### Closure Tests
- `editor-orchestration.integration.test.ts` and `editor-atomic-commit.test.ts`.
- Browser automation verifying reload, navigation, and atomic undo behaviors.

---

## [Phase 12: Authentication, OAuth & Operation Ownership] — Status: ✅ CLOSED

### Current State
Completed. Full resolution of Open Redirect and Host Header Injection vulnerabilities, verified atomic user synchronization, and strict 404 error mapping preventing resource enumeration. Documented in `docs/reference/phase-12-auth-ownership-closure.md`.

### Derivation Constraint
Phases 9, 10, and 11.

### Technical Objective
Prevent open redirects and cross-user resource access across all server routes, API endpoints, and OAuth callback flows.

### Direct Implementation Steps
- **Step 1:** Harden `src/app/auth/callback/route.ts` with strict allowlists for internal redirects, rejecting untrusted host headers and binding to `NEXT_PUBLIC_APP_URL`.
- **Step 2:** Extract `resolveSafeRedirectPath` utility, applying it across OAuth initiation and callback handlers.
- **Step 3:** Audit server actions and route handlers to derive user identity strictly from verified server sessions, checking parent/file/reservation ownership.
- **Step 4:** Standardize error mapping so cross-user access attempts return 404 rather than 403, preventing resource enumeration.

### Exception & Edge Case Handling
- **Missing Redirect Parameter:** Route to `/dashboard`.
- **Conflicting Forwarded Headers:** Discard forwarded headers; enforce canonical origin.
- **Expired Session Mid-Action:** Return 401 without executing mutations.
- **Accessing Another User's Resource:** Return 404 without leaking existence.

### Closure Tests
- `src/test/auth-redirect.test.ts` (21 tests) and `src/test/cross-user-ownership.test.ts` (14 tests).
- Verifying complete rejection of protocol-relative (`//evil.com`) and encoded redirect vectors.

---

## [Phase 13: Stripe Webhooks & Subscriptions] — Status: ✅ CLOSED

### Current State
Completed. Dedicated `subscription_events` table deployed, durable deduplication verified, period intervals derived from Stripe invoices, and ASCII diagrams upgraded to Mermaid. Documented in `docs/reference/phase-13-stripe-webhooks-subscriptions-closure.md`.

### Derivation Constraint
Phases 9, 10, and 12.

### Technical Objective
Establish durable, idempotent Stripe webhook handling with accurate subscription periods derived from associated invoice objects.

### Direct Implementation Steps
- **Step 1:** Establish `/api/stripe/webhook` as canonical handler, documenting `/api/webhooks/stripe` as alias.
- **Step 2:** Deploy `subscription_events` table tracking received event IDs with unique constraints.
- **Step 3:** Eliminate reliance on transient in-memory sets as sole deduplication mechanism.
- **Step 4:** Verify webhook signatures and timestamps prior to parsing payloads.
- **Step 5:** Correct period assignment: derive `current_period_start/end` from associated Invoice lines rather than copying `start_date`.
- **Step 6:** Make payment failure, cancellation, and reactivation transitions idempotent.

### Exception & Edge Case Handling
- **Duplicate Event After Server Restart:** Query database event ledger; skip mutation without error.
- **Database Failure Post-Receipt:** Do not commit event record; allow Stripe webhook retry.
- **Out-of-Order Webhook Delivery:** Compare event timestamps; do not downgrade newer subscription states.
- **Stale Signature:** Reject immediately prior to database access.

### Closure Tests
- `src/app/api/stripe/webhook/route.test.ts` covering duplicate events, restart scenarios, and invoice period extraction.

---

## [Phase 14: Unused Supabase Storage Removal] — Status: ✅ CLOSED

### Current State
Completed. Deprecated storage utilities and `storage_path` database columns purged; documents persist as text in Neon. Documented in `docs/reference/phase-14-supabase-storage-removal-closure.md`.

### Derivation Constraint
Authentication and file ownership closure.

### Technical Objective
Decommission unused Supabase Storage wrappers, removing dead code while preserving Supabase Auth and database capabilities.

### Direct Implementation Steps
- **Step 1:** Verify Supabase storage bucket is empty and unreferenced.
- **Step 2:** Delete `src/lib/supabase/storage.ts` and related path assertions.
- **Step 3:** Purge storage-specific environment variables and documentation claims.
- **Step 4:** Confirm PDF import parses text directly into Neon without persisting binary objects in object storage.

### Exception & Edge Case Handling
- **Non-Empty Bucket:** Abort deletion until assets are migrated.
- **Hidden Call Sites:** Static audit across codebase confirming zero imports.

### Closure Tests
- `tsc --noEmit` and full test suite confirming clean removal without broken imports.

## [Phase 15: Sanitization, Import & Export] — Status: ✅ CLOSED

### Current State
Completed. Server-side 10MB text payload ceiling and PostgreSQL null-byte scrubbing (`\0`) enforced in `importFile`, disguised binary headers (PE/ELF/Mach-O/ZIP) rejected via `isDisguisedBinary` in `file-validator.ts`, filename path traversal sanitized via `sanitizeFilename`, and end-to-end round-trip fidelity verified across complex Arabic RTL, spatial GFM tables, code blocks, and adversarial payloads (`export-import-roundtrip.integration.test.ts`). Fully documented in [`phase-15-sanitization-import-export-closure.md`](../reference/phase-15-sanitization-import-export-closure.md).

> **Architectural Note:** The client-side Web Worker PDF extraction, 2D spatial clustering table generation (`pdf-table-extractor.ts`), pure TypeScript Arabic Unicode normalization (`arabic-normalizer.ts`), on-demand bilingual OCR engine (`pdf-ocr-engine.ts`), PUA font corruption detection (`pdf-corruption-detector.ts`), and direct Zero-Knowledge vault import were completed and closed as an independent milestone documented in [`pdf-worker-extraction-and-vault-import-closure.md`](../reference/pdf-worker-extraction-and-vault-import-closure.md).

### Derivation Constraint
Phases 9 through 14.

### Technical Objective
Harden single secure content pipeline across import, normalization, editor preview, and export modules, establishing end-to-end integration verification.

### Direct Implementation Steps
- **Step 1:** Implement cross-system integration test verifying full round-trip `import → normalize → export` with adversarial content and Arabic RTL text (`export-import-roundtrip.integration.test.ts`).
- **Step 2:** Implement in-memory magic bytes and disguised binary detector (`file-validator.ts`).
- **Step 3:** Enforce filename directory traversal sanitization using `sanitizeFilename` (`import-file.ts`).
- **Step 4:** Document pure-Markdown security invariants replacing legacy DOMPurify (`phase-15-sanitization-import-export-closure.md`).

### Exception & Edge Case Handling
- **Oversized File / Text:** Reject server-side with standardized error (exceeding 10MB).
- **Disguised Executable / Archive:** Reject with explicit format error (`disguised binary detected`).
- **Path Traversal in Filename:** Strip traversal tokens (`../`) and illegal filesystem characters.
- **Corrupted Font / Scanned PDF:** Detect PUA characters or empty text and suggest on-demand OCR (handled in PDF extraction milestone).
- **Adversarial Injections (JavaScript URLs, Event Handlers, Malformed UTF-8):** Sanitized and preserved as inert Markdown text.

### Closure Tests
- `src/lib/parsers/file-validator.test.ts`, `src/server/actions/import-file.test.ts`, `src/test/export-import-roundtrip.integration.test.ts`, and full repository test suite (776 tests passed across 62 suites).

### Transition Gate
- **Status:** `CLOSED` ✅ (Fully verified and hardened under Phase 15 closure report).
- Transition gate to **Phase 17 (Monitoring, Rate Limiting & Errors)** is open.

---

## [Phase 16: Zero-Knowledge Hybrid Encryption & Vault] — Status: ✅ CLOSED

### Current State
Completed. Dual-tier hybrid encryption active: transparent local at-rest encryption in IndexedDB, 600K PBKDF2 Web Worker offloading, 12-word BIP-39 recovery seed, non-blocking conflict queue (`CONFLICT_LOCKED`), post-merge syntax integrity check, direct encrypted import pipeline in `sidebar.tsx`, and AI gatekeeper. Detailed in `HYBRID_ENCRYPTION_AND_VAULT_PLAN.md` and [Phase 16 Reference](../reference/phase-16/).

### Derivation Constraint
Phases 1 through 15 closure.

### Technical Objective
Integrate client-side Zero-Knowledge vault encryption with authenticated key envelopes, recovery seeds, direct encrypted import, and non-blocking sync conflict isolation.

### Direct Implementation Steps
- **Step 1:** Define key hierarchy separating master key, password KEK, and recovery seed KEK.
- **Step 2:** Standardize `EncryptedEnvelope` format: `version`, `algorithm`, `keyId`, `iv`, `salt`, `ciphertext`, and `kdfIterations`.
- **Step 3:** Bind `AAD` to `${userId}:${fileId}` preventing envelope swapping.
- **Step 4:** Implement Web Worker offloading for 600,000 PBKDF2 iterations and memory sanitization via `.fill(0)`.
- **Step 5:** Quarantine encrypted sync conflicts in `CONFLICT_LOCKED` during locked vault states without blocking standard files.
- **Step 6:** Validate Markdown syntax integrity post-merge before re-encrypting.
- **Step 7:** Implement direct vault import in `sidebar.tsx` via `cryptoWorkerBridge` with deterministic AAD and optimistic IndexedDB write.

### Exception & Edge Case Handling
- **Missing Key or AAD Mismatch:** Fail-closed; return zero partial plaintext.
- **Corrupted Ciphertext:** Reject immediately without leaking decrypted buffers.

### Closure Tests
- 10-scenario closure matrix in `src/test/vault-crypto.test.ts`, `vault-recovery.test.ts`, `file-conversion.test.ts`, `ai-gatekeeper.test.ts`, `sync-encrypted-conflict.test.ts`, and `src/test/vault-import.integration.test.ts`.

---

## [Phase 17: Monitoring, Rate Limiting & Errors] — Status: ⏳ IN PROGRESS

### Current State
`rate-limit.ts` enforces sliding-window tracking via Upstash Redis; fail-open for public routes, fail-closed for AI quotas; reservation expiration cron pending deployment.

### Derivation Constraint
Phases 1 through 16.

### Technical Objective
Deploy structured operational telemetry, standardize correlation IDs across routes, and register automated cron sweepers for expired reservations.

### Direct Implementation Steps
- **Step 1:** Document dual-mode rate limiting: fail-open for file/sync/auth endpoints, fail-closed for AI quotas in `ai-ops`.
- **Step 2:** Add server-side AI telemetry: reservation latency, TTFT, stream duration, provider failure, refund failure, and commit conflict.
- **Step 3:** Inject `correlationId` and `operationId` into all structured error payloads.
- **Step 4:** Deploy cron route `/api/cron/expire-reservations` protected by `CRON_SECRET` and register in GitHub Actions (resolving TD-02).
- **Step 5:** Verify zero credential, prompt, or plaintext leakage in application logs.

### Exception & Edge Case Handling
- **Redis Outage:** Maintain fail-open on standard sync; maintain fail-closed on AI quota reservation.
- **Rate Limit Clock Skew:** Rely on Redis server time.
- **Unhandled Exceptions:** Return generic safe error codes with correlation IDs.

### Closure Tests
- Concurrency rate limit tests, telemetry metric assertions, and verified cron reservation sweeper execution.

---

## [Phase 18: Multi-System Integration Testing] — Status: ⏳ PARTIALLY DONE

### Current State
15 hermetic live integration suites execute against the isolated Neon test branch (`npm run test:live`). Consolidated multi-system lifecycle test pending.

### Derivation Constraint
Phases 10 through 17.

### Technical Objective
Validate end-to-end multi-system contracts combining authentication, sync, conflict, AI streaming, encryption, and billing across real PostgreSQL and Redis services.

### Test Suites
- **Files & Sync Suite:** File creation, offline edit, queue, reconnect, stale If-Match, 412, conflict, merge, and reload.
- **AI Happy Path Suite:** Auth session, reserve, stream NDJSON, preview, atomic commit, version/ETag bump, and reload.
- **AI Failure Suite:** Provider failure, abort, disconnect, expired reservation, duplicate operation, failed commit, and single refund.
- **Stripe Suite:** Signed webhook, event ledger, restart deduplication, period mapping, and tier transition.
- **Encrypted Vault Suite:** Setup, local encryption, cloud sync, locked conflict isolation, unlock, and 3-way merge.
- **Sanitization & Content Suite:** Malicious import, server sanitize, editor render, AI preview, and export.

### Exception & Edge Case Handling
- All integration suites execute on isolated Neon test branch under `singleFork` serialization.
- Zero mock workarounds permitted for database or Redis operations.

### Closure Condition
All 6 multi-system suites pass repeatedly on the isolated branch with zero partial mutations.

---

## [Phase 19: Browser-Driven E2E Testing (Playwright)] — Status: ⏸️ PENDING

### Current State
Deferred under technical debt register item TD-07 pending backend stabilization.

### Derivation Constraint
Phase 18 completion.

### Technical Objective
Validate complete user journeys in real browser instances across Next.js App Router, Supabase Auth, Neon database branch, Redis, and Stripe sandbox.

### Tooling Setup
- **Step 0:** Install `@playwright/test`, generate `playwright.config.ts`, and configure isolated test server environments.

### User Journey Scenarios
1. User login, document creation, rich text editing, and page reload.
2. Cross-user authorization isolation on documents and folders.
3. Offline editing, network reconnection, and manual conflict resolution dialog.
4. AI streaming ghost preview, keystroke offset tracking, and atomic acceptance.
5. AI stream cancellation at start, mid-flight, and pre-commit.
6. HTTP 412 handling during AI commit without partial text leaks.
7. Graceful degradation when all AI provider keys are exhausted.
8. Stripe subscription checkout, webhook handling, and tier upgrades.
9. Malicious file import, sanitization, and clean export.
10. Vault creation, 12-word seed recovery, and locked conflict resolution.

### Exception & Edge Case Handling
- Zero flaky tests permitted for closure.
- Clean namespace isolation between scenario runs.

### Closure Condition
All 10 user journeys pass twice consecutively on CI pipeline.

---

## [Phase 20: Final Production Verification & System Readiness Gates] — Status: ⏸️ PENDING

### Current State
Pre-release verification gates pending completion of Phases 17, 18, and 19.

### Derivation Constraint
Successful completion of Phases 1 through 19.

### Technical Objective
Enforce strict production readiness criteria before declaring the system ready for deployment.

### Direct Implementation Steps
- **Step 1:** Confirm closure of Phases 9 and 10 (session governance and Neon isolation).
- **Step 2:** Confirm closure of Phases 11 and 12 (editor orchestration and auth ownership).
- **Step 3:** Confirm closure of Phases 13 and 14 (Stripe billing and storage decommissioning).
- **Step 4:** Confirm closure of Phases 15, 16, and 17 (sanitization, vault encryption, and telemetry).
- **Step 5:** Validate 100% pass rate across Phase 18 integration and Phase 19 E2E suites.
- **Step 6:** Generate final deployment dossier detailing test results, active database branch, applied migrations, and rollback procedures.

### Final Readiness Invariant
The platform status `READY` will only be issued when all closure criteria are verified:
- Resource ownership and optimistic locking (`If-Match`) fully enforced.
- Sync lifecycle, durable queue, and garbage collection verified.
- 3-way conflict merges validated with structural syntax integrity checks.
- AI quota reservation and refunds idempotent with automated cron cleanup.
- AI streaming incorporates dynamic offset mapping and atomic commits.
- Stripe processing backed by durable database event ledger.
- Zero-Knowledge client-side vault encryption bound by AAD and BIP-39 recovery.
- Zero test failures across unit, integration, and browser E2E suites with zero flaky tests.
