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
- `src/test/sync/use-sync.test.ts` validating mount/unmount lifecycles, user switching, and logout during active sync.
- `src/test/sync/sync-manager.test.ts` and `concurrency-manager.test.ts` asserting consumer counts and operation serialization.
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
- Execute `src/test/server/file-ops.lostupdate.test.ts` and `file-ops.softdelete.test.ts`.
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
- `src/test/sync/sync-conflict-resolver.test.ts` validating overlapping and non-overlapping merge ranges against real base snapshots.
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
- `src/test/ai/ai-ops.integrity.test.ts` and `ai-ops.refund.test.ts`.
- `src/test/ai/ai-quota-idempotency.test.ts` running on live PostgreSQL validating concurrent transactions and rollback recovery.

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
- `src/test/ai/ai-client.test.ts` and `src/test/ai/ai-key-rotation.test.ts`.
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
- `src/test/ai/ai-stream-parser.test.ts` and `src/test/ai/ai-stream-session.test.ts`.
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
- `src/test/ai/ai-server-atomic-commit.test.ts` and `src/test/editor/editor-atomic-commit.test.ts` against real database branch.
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
Completed. Full resolution of Open Redirect and Host Header Injection vulnerabilities, verified atomic user synchronization, and strict 404 error mapping preventing resource enumeration. Documented in `docs/records/closures/phase-11-to-15-core-infrastructure/phase-12-auth-ownership-closure.md`.

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
- `src/test/auth/auth-redirect.test.ts` (21 tests) and `src/test/server/cross-user-ownership.test.ts` (14 tests).
- Verifying complete rejection of protocol-relative (`//evil.com`) and encoded redirect vectors.

---

## [Phase 13: Stripe Webhooks & Subscriptions] — Status: ✅ CLOSED

### Current State
Completed. Dedicated `subscription_events` table deployed, durable deduplication verified, period intervals derived from Stripe invoices, and ASCII diagrams upgraded to Mermaid. Documented in `docs/records/closures/phase-11-to-15-core-infrastructure/phase-13-stripe-webhooks-subscriptions-closure.md`.

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
- `src/test/api/stripe-webhook.test.ts` covering duplicate events, restart scenarios, and invoice period extraction.

---

## [Phase 14: Unused Supabase Storage Removal] — Status: ✅ CLOSED

### Current State
Completed. Deprecated storage utilities and `storage_path` database columns purged; documents persist as text in Neon. Documented in `docs/records/closures/phase-11-to-15-core-infrastructure/phase-14-supabase-storage-removal-closure.md`.

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
Completed. Server-side 10MB text payload ceiling and PostgreSQL null-byte scrubbing (`\0`) enforced in `importFile`, disguised binary headers (PE/ELF/Mach-O/ZIP) rejected via `isDisguisedBinary` in `file-validator.ts`, filename path traversal sanitized via `sanitizeFilename`, and end-to-end round-trip fidelity verified across complex Arabic RTL, spatial GFM tables, code blocks, and adversarial payloads (`export-import-roundtrip.integration.test.ts`). Fully documented in [`phase-15-sanitization-import-export-closure.md`](../records/closures/phase-11-to-15-core-infrastructure/phase-15-sanitization-import-export-closure.md).

> **Architectural Note:** The client-side Web Worker PDF extraction, 2D spatial clustering table generation (`pdf-table-extractor.ts`), pure TypeScript Arabic Unicode normalization (`arabic-normalizer.ts`), on-demand bilingual OCR engine (`pdf-ocr-engine.ts`), PUA font corruption detection (`pdf-corruption-detector.ts`), and direct Zero-Knowledge vault import were completed and closed as an independent milestone documented in [`pdf-worker-extraction-and-vault-import-closure.md`](../records/closures/extensions/pdf-worker-extraction-and-vault-import-closure.md).

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
- `src/test/parsers/parser-file-validator.test.ts`, `src/test/server/import-file.test.ts`, `src/test/parsers/export-import-roundtrip.integration.test.ts`, and full repository test suite (776 tests passed across 62 suites).

### Transition Gate
- **Status:** `CLOSED` ✅ (Fully verified and hardened under Phase 15 closure report).
- Transition gate to **Phase 17 (Monitoring, Rate Limiting & Errors)** is open.

---

## [Phase 16: Zero-Knowledge Hybrid Encryption & Vault] — Status: ✅ CLOSED

### Current State
Completed. Dual-tier hybrid encryption active: transparent local at-rest encryption in IndexedDB, 600K PBKDF2 Web Worker offloading, 12-word BIP-39 recovery seed, non-blocking conflict queue (`CONFLICT_LOCKED`), post-merge syntax integrity check, direct encrypted import pipeline in `sidebar.tsx`, and AI gatekeeper. Detailed in `HYBRID_ENCRYPTION_AND_VAULT_PLAN.md` and [Phase 16 Reference](../records/closures/phase-16-vault-encryption/).

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
- 10-scenario closure matrix in `src/test/vault/vault-crypto.test.ts`, `vault-recovery.test.ts`, `file-conversion.test.ts`, `ai-gatekeeper.test.ts`, `sync-encrypted-conflict.test.ts`, and `src/test/vault/vault-import.integration.test.ts`.

---

## [Phase 17: Monitoring, Rate Limiting & Errors] — Status: ✅ CLOSED

### Current State
Dual-mode rate limiting documented and active (`rate-limit.ts`); fail-open for standard endpoints, fail-closed for AI quotas; correlation IDs tracked via `X-Correlation-ID` across routes/actions; zero-allocation structured AI telemetry logging implemented; Zero-Knowledge log sanitizer hardened with boundary checks; automated cron `/api/cron/expire-reservations` scheduled via GitHub Actions, resolving TD-02.

### Derivation Constraint
Phases 1 through 16.

### Technical Objective
Deploy structured operational telemetry, standardize correlation IDs across routes, and register automated cron sweepers for expired reservations.

### Direct Implementation Steps
- **Step 1:** Document dual-mode rate limiting: fail-open for file/sync/auth endpoints, fail-closed for AI quotas in `ai-ops` (`docs/architecture/security/security-and-rate-limiting.md`).
- **Step 2:** Add server-side AI telemetry: reservation latency, TTFT, stream duration, provider failure, refund failure, and commit conflict via zero-allocation structured logging.
- **Step 3:** Inject `correlationId` and `operationId` into structured error payloads, API response headers (`X-Correlation-ID`), and NDJSON stream frames.
- **Step 4:** Deploy cron route `/api/cron/expire-reservations` protected by `CRON_SECRET` and register in GitHub Actions (resolving TD-02).
- **Step 5:** Harden `log-sanitizer.ts` with strict token-boundary isolation to prevent secret leakage without false-positive key redactions.

### Exception & Edge Case Handling
- **Redis Outage:** Maintain fail-open on standard sync; maintain fail-closed on AI quota reservation.
- **Rate Limit Clock Skew:** Rely on Redis server time with in-memory fallback.
- **Unhandled Exceptions:** Return generic safe error codes with correlation IDs and internal stack trace isolation.

### Closure Tests
- Unit and contract suites passing: `rate-limit.test.ts`, `correlation.test.ts`, `cron-expire-reservations.test.ts`, `log-sanitizer.test.ts`, `vault-sync-ai-gate.test.ts`, and `sync-manager.test.ts`.

### Transition Gate
- **Status:** `CLOSED` ✅. Ready to proceed to Phase 18 upon explicit user approval.

---

## [Phase 18: Multi-System Integration Testing] — Status: CLOSED ✅

### Current State
Fully verified and officially closed: 19 hermetic live integration suites (89 live tests) execute against the isolated Neon test branch (`ep-dry-rain-b1kfmpgk-pooler`) via `npm run test:live`, governed under `singleFork: true` serialization in `vitest.live.config.mts`. 100% reproducible across two consecutive runs with zero partial mutations and zero flakiness.

### Derivation Constraint
Phases 10 through 17.

### Technical Objective
Validate end-to-end multi-system contracts combining authentication, sync, conflict, AI streaming, encryption, and billing across real PostgreSQL and Redis services.

### Test Suites (7 Multi-System Suites)
- **Files & Sync Lifecycle Suite:** File creation, offline edit in IndexedDB, queue flush, reconnect, stale If-Match, 412 conflict, 3-way Diff3 merge, deterministic ETag, reload recovery, and correlation header propagation.
- **AI Happy Path & Atomic Commit Suite:** Auth session, Redis/Postgres reservation, streaming NDJSON with correlationId, ghost preview in CodeMirror 6, atomic ACID commit (file update + version bump + reservation settlement + usage counter), and reload.
- **AI Failure & Quota Sweeper Suite:** Provider failure, client abort signal, single-refund idempotency, and automated reservation expiration sweeper (`/api/cron/expire-reservations` - TD-02).
- **Stripe Billing & Durable Ledger Suite:** Live signed HMAC webhook verification (`route.live.test.ts`), ACID event ledger (`subscription_events`), restart replay idempotency, period mapping, and terminal status protection.
- **Encrypted Vault & Zero-Knowledge Security Suite:** BIP-39 12-word seed, transparent local AES-GCM-256 encryption, deterministic AAD binding `vault:file:${userId}:${fileId}`, locked conflict isolation (`CONFLICT_LOCKED`), unlock & safe merge, Zero-Knowledge AI gatekeeper HTTP 403, and cross-user tenant isolation (`src/test/vault/vault-sync.live.test.ts`).
- **Document Ingestion, Normalization & Export Suite:** Client-side Web Worker PDF extraction, magic bytes disguised binary rejection (PE/ELF/ZIP), path traversal & null-byte scrubbing, CodeMirror 6 BiDi/RTL rendering, and 100% round-trip pure Markdown export (`src/test/server/document-pipeline.live.test.ts`).
- **Tenant Isolation & Authorization Boundary Suite:** Cross-user resource isolation on files, folders, and AI streams with 404 anti-enumeration error masking, and atomic concurrent user synchronization (`syncUserToDatabase`).
- **Consolidated Multi-System Lifecycle:** End-to-end 8-stage verification uniting all platform subsystems under concurrent transactional execution (`src/test/infrastructure/multi-system-lifecycle.live.test.ts`).

### Exception & Edge Case Handling
- All integration suites execute on isolated Neon test branch (`TEST_DATABASE_URL`) guarded fail-closed by `test-db-guard.ts` under `singleFork: true` serialization in `vitest.live.config.mts`.
- Zero mock workarounds permitted for database or Redis operations.

### Closure Condition
All 7 multi-system suites pass repeatedly on the isolated branch with zero partial mutations. (VERIFIED: 19 test files, 89 live tests passing 100% across two consecutive runs; zero type errors under `npx tsc --noEmit`).

### Transition Gate
- **Status:** `CLOSED` ✅. Transition to Phase 19 requires explicit user authorization pursuant to the single-phase session protocol and technical debt item TD-07. Phase 19 must not begin until this phase is closed.

---

## [Phase 19: Browser-Driven E2E Testing (Playwright)] — Status: ✅ CLOSED (2026-09-19)

### Current State
100% verified and closed on 2026-09-19. Full automated browser testing infrastructure built with `@playwright/test` v1.63.0 and Chromium headless browser engine. 14 test specification suites covering all 15 scenarios were implemented under `e2e/specs/` and verified against the isolated Neon test branch (`TEST_DATABASE_URL`). Two consecutive validation test runs achieved 100% pass rates with zero flakiness (Run 1: 15/15 passed in 2.4m, Run 2: 15/15 passed in 2.1m). Technical debt item TD-07 is officially resolved.

### Derivation Constraint
Phase 18 completion (verified).

### Technical Objective
Validate complete user journeys in real browser instances across Next.js App Router, Supabase Auth, Neon database branch, Redis, and Stripe sandbox.

### Tooling Setup
- **Step 0:** Install `@playwright/test`, generate `playwright.config.ts`, and configure isolated test server environments.

### User Journey Scenarios (15 Comprehensive End-to-End Journeys)
1. Authentication & Session Lifecycle: login, SSR cookie verification, cross-tab persistence, reload recovery, and clean logout storage teardown.
2. File System, Folder Tree & Trash Lifecycle: nested folders, drag-and-drop move/copy, rename, soft deletion, duplicate name coexistence, restore to root, and permanent purge.
3. Native CodeMirror 6 Markdown & BiDi RTL: pure Markdown editing, automatic Arabic RTL detection via bidi plugin, LTR code block locking, multi-range search & replace, and debounced autosave.
4. Offline-First Sync & Interactive Conflict Resolution: offline editing in IndexedDB queue, reconnect, 412 trigger, interactive ConflictDialog diff inspection, and 3-way Diff3 merge.
5. Client-Side PDF Ingestion & OCR: disguised binary rejection via magic bytes, pdf-extract-dialog flow, 2D spatial table reconstruction, OCR toggle, and 100% roundtrip Markdown export.
6. AI Streaming, Dynamic Ghost Preview & Atomic Commit: text selection, NDJSON streaming with correlationId, CMStreamingGhostWidget typing offset tracking, and atomic one-click acceptance.
7. User-Initiated AI Stream Abort (No Refund): mid-stream stop button click, immediate connection abort, zero text leakage, and quota settled as consumed (No Refund) for incurred compute costs.
8. User-Initiated AI Preview Rejection (No Refund): preview rejection/undo, document left untouched, and quota settled as consumed (No Refund) preventing free regeneration exploits.
9. System AI Provider Failure (Full Refund): simulated upstream 500 or key exhaustion, safe generic error banner display, and automated full quota refund for system faults.
10. AI Concurrent Edit Collision (412): concurrent edit in sibling tab, commit rejected with 412 Precondition Failed, preventing partial text overwrite with user conflict prompt.
11. Zero-Knowledge Vault Creation: CreateVaultModal setup, 12-word BIP-39 mnemonic, 3-word randomized challenge, 600K PBKDF2 Web Worker key derivation, and cloud ciphertext sync.
12. Vault Auto-Lock, Multi-Modal Unlock & Device Trust: inactivity auto-lock, SessionKeyStore volatile wipe, password unlock, BIP-39 seed recovery, and WebAuthn PRF / 6-digit PIN device trust.
13. Vault AI Gatekeeper & Encrypted Conflict Quarantine: encrypted note opens with amber AI shield badge, AI route blocked with HTTP 403, and locked conflict quarantined in CONFLICT_LOCKED.
14. Stripe Subscription Checkout & Durable Ledger: upgrade button, Stripe Sandbox checkout redirect, live webhook processing into subscription_events, and instant real-time tier upgrade.
15. Cross-User Tenant Isolation & Anti-Enumeration: foreign file/folder access blocked via direct URL navigation or API with strict 404 Anti-Enumeration error masking.

### Exception & Edge Case Handling
- Zero flaky tests permitted for closure.
- Clean namespace isolation between scenario runs using designated prefix ranges (`9999...`).
- Any state discrepancy between browser UI and persistent database/IndexedDB fails the journey immediately.

### Closure Condition
All 15 user journeys pass twice consecutively on CI pipeline with zero partial mutations, zero data leakage, and strict adherence to the AI quota settlement policy.

---

## [Phase 20: Final Verification & Plan Completion Gates] — Status: ✅ CLOSED (Technical Plan Fully Completed)

### Current State
Phase 20 is 100% closed and verified on 2026-09-19. All 11 critical verification gates for full technical plan completion have been empirically validated through deep line-by-line source code audits and complete test execution:
- TypeScript static typecheck (`npx tsc --noEmit`): 0 errors (Exit Code: 0).
- ESLint code quality gate (`npm run lint`): 0 problems, 0 errors, 0 warnings (Exit Code: 0).
- Unit test suite (`npm test`): 65 test files, 793 tests passed (100%).
- Multi-system live integration suite (`npm run test:live`): 19 suites, 89 tests passed (100%) against isolated Neon PostgreSQL test branch.
- Browser-driven E2E suite (`npx playwright test`): 14 suites, 15 user journeys passed (100%) in Chromium with `retries: 0`.
- CI Pipeline Integration: Playwright E2E browser testing officially integrated as Stage 6 of `.github/workflows/ci.yml` with failure artifact uploads.
- Production build compilation (`npm run build`): 17 static and dynamic routes compiled successfully in 53s.
The official Final Verification Dossier is published in [`docs/reference/phase-20-production-readiness-dossier.md`](../records/closures/phase-17-to-20-production-readiness/phase-20-production-readiness-dossier.md).

### Derivation Constraint
- Official `CLOSED` state recorded for Phase 18 (Multi-System Integration Testing). (Verified ✅)
- Official `CLOSED` state recorded for Phase 19 (Playwright E2E User Journeys). (Verified ✅)

### Technical Objective
Verify and close all 11 critical execution criteria with empirical engineering proof, zero architectural contradictions, resilient fault isolation, and full platform integrity, formally completing the 20-phase technical plan in full.

### Direct Implementation Steps
- **Step 1:** Confirm closure of Phases 9 and 10 (session governance and Neon branch isolation).
- **Step 2:** Confirm closure of Phases 11 and 12 (native CodeMirror 6 pure-markdown editor and tenant isolation via 404 Anti-Enumeration).
- **Step 3:** Confirm closure of Phases 13 and 14 (durable Stripe event ledger and complete decommissioning of Supabase Storage enforcing Zero Binary Cloud Storage).
- **Step 4:** Confirm closure of Phases 15, 16, and 17 (magic bytes file validation, client-side Web Worker PDF extraction, Zero-Knowledge AES-GCM-256 encrypted vault with deterministic AAD binding, distributed `X-Correlation-ID` tracking, dual-mode rate limiter, and cron sweeper TD-02).
- **Step 5:** Execute and validate 100% pass rate across the 7 multi-system integration suites in Phase 18 on the isolated Neon branch.
- **Step 6:** Execute and validate 100% pass rate across the 15 browser-driven Playwright user journeys in Phase 19 run twice consecutively with zero flakiness.
- **Step 7:** Compile the Final Verification Dossier detailing active database branch identity, applied migrations, clean static type and vulnerability audit results, and disaster recovery rollback plans.

### Exceptional Case Handling
- Critical gate failure: Transition status immediately to `BLOCKED`; halt any progression until unblocked.
- Migration or transaction anomaly: Abort execution immediately and revert to the verified recovery snapshot; undocumented manual patching is strictly prohibited.
- Environmental discrepancy: The active source code and live deterministic test outputs serve as the sole authoritative truth.

### Final Plan Completion Invariants (11 Essential Gates for Full Plan Closure)
Final plan completion is officially certified when all 11 closure criteria are verified with concrete digital evidence:
1. **Resource Ownership & Optimistic Locking:** Full enforcement of `If-Match` and `version` headers returning 412/428 across all mutation routes.
2. **Sync Lifecycle & Durable Queue:** Deterministic IndexedDB transaction handling, atomic rollbacks, and leak-free garbage collection.
3. **Native CodeMirror 6 & Arabic RTL:** Pure-Markdown data layer, automated BiDi text direction, 3-way Diff3 conflict merging, and AST syntax validation.
4. **AI Quota Settlement & Sweeper Policy (§4-D):** Streamed NDJSON with correlation tracing, automated sweeper cron (`TD-02`), and strict quota settlement: user-initiated abort (`stopStream`) or preview rejection (`rejectPreview`) after stream commencement settles quota as consumed (`status = committed`, `refundedUnits = 0`) with zero refund, reserving automated refunds strictly for upstream/system failures.
5. **Durable Stripe Billing Ledger:** Live HMAC signature verification, idempotent event recording in `subscription_events`, and strict protection against reviving canceled subscriptions.
6. **Zero-Knowledge Encrypted Vault:** Client-side AES-GCM-256 with PBKDF2 (600,000 iterations), deterministic AAD binding (`vault:file:${userId}:${fileId}`), BIP-39 recovery mnemonic validation, WebAuthn PRF/PIN device trust, and instant HTTP 403 AI gating.
7. **Zero Binary Cloud Storage:** Client-side Web Worker PDF text and table extraction, strict magic bytes binary rejection, and complete absence of cloud bucket binary storage or signed URLs.
8. **Tenant Isolation & Security Guard:** Consistent 404 Anti-Enumeration masking across all unauthorized resource access attempts.
9. **Distributed Tracing & Dual-Mode Rate Limiting:** Propagation of `X-Correlation-ID` headers across all responses and streaming frames, with dual IP/User rate limiting.
10. **Phase 18 Integration Pass:** 100% pass rate across all 7 multi-system test suites on the isolated Neon test branch under `singleFork: true`.
11. **Phase 19 E2E Journey Pass:** 100% pass rate across all 15 Playwright browser user journeys run twice consecutively in CI with zero flaky tests.
