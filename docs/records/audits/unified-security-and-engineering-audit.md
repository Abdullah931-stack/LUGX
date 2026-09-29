# Unified Security and Engineering Audit Report for LUGX

> **Point-in-time engineering record (v1.32.4 / commit `d2d60a7`).** Verification metrics,
> findings, and code references reflect the repository snapshot at the time of audit;
> active production code and current tests serve as the authoritative baseline.

| Item | Value |
|---|---|
| Repository | `/home/user/workspace/lugx` |
| Version | v1.32.4 |
| Commit | `d2d60a7` |
| Report Inputs | Seven module reports: `audit/{sync,ai,vault,backend,editor,docs,infra}.md`, and three independent verification reports: `audit/verify-v1.md` (Sync & Editor), `audit/verify-v2.md` (AI & Vault), and `audit/verify-v3.md` (Backend, Infra & Docs) |
| Repository State | No repository files were modified during the audit or verification; all empirical experiments were executed in isolated external temporary copies |

---

## 1. Executive Summary

### 1.1 Summary

The audit reveals **183 consolidated findings**, comprising **5 Critical**, **23 High**, **69 Medium**, and **86 Low**. These numbers derive from 204 original findings across module audit reports, refined through independent verification verdicts, and subsequently consolidated across duplicates (21 merges). The critical findings concentrate in three core domains:

1. **AI Quota Bypass:** The refund procedure is exposed to the client without authentication or ownership verification, the operation identifier is replayable, and final quota settlement is deferred to the browser.
2. **Silent User Data Loss:** Conflicts are prematurely marked clean prior to user resolution, allowing the concurrent pull cycle to overwrite local modifications with the remote server version.
3. **Zero-Knowledge Guarantee Breakage:** Plaintext is uploaded to the remote server tagged as ciphertext. Concurrently, the BIP-39 recovery phrase never unlocks the vault due to an AAD mismatch, rendering forgotten passwords a permanent data loss event.

### 1.2 Counts by Final Severity and Module

Each consolidated finding is attributed to the module of the first original finding identifier referenced within it.

| Module | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Sync | 1 | 8 | 13 | 17 | 39 |
| AI | 2 | 3 | 5 | 9 | 19 |
| Vault | 1 | 1 | 5 | 10 | 17 |
| Backend | 0 | 3 | 12 | 16 | 31 |
| Editor & UI | 1 | 7 | 15 | 9 | 32 |
| Docs | 0 | 0 | 12 | 19 | 31 |
| Infrastructure & Tests | 0 | 1 | 7 | 6 | 14 |
| **Total** | **5** | **23** | **69** | **86** | **183** |

**Comparison with Original Counts:** Module reports initially yielded 204 findings (6 Critical, 38 High, 75 Medium, and 85 Low). Independent verification downgraded the severity of 21 original findings and upgraded none. Deduplication across and within modules was subsequently executed via 21 merge operations (Appendix 7.3), where each merged constituent adopted the final consolidated severity. Appendix 7.2 details every severity adjustment and its origin.

### 1.3 Systemic Root Causes

| # | Root Cause | Representative Findings |
|---|---|---|
| R1 | **Client-Driven Financial Settlement & Unauthenticated Server Actions:** The server fails to commit quota reservations on normal streaming completion. Server Action modules (`"use server"`) export endpoints accepting `operationId`, `userId`, or `tier` without calling `getUser()` or validating session ownership. | LUGX-001, LUGX-002, LUGX-006, LUGX-031, LUGX-067, LUGX-115 |
| R2 | **Absence of a Unified Persistence & Sync State Machine:** The `isDirty=false` decision is scattered across approximately ten disparate locations, including `markFileClean`, `commitFileAndOperationSync`, `handleConflict` branches, rollback handlers, and the editor orchestrator. There is no monotonic local revision counter (`localRevision`) and no Compare-And-Swap (CAS) gating. | LUGX-003, LUGX-010, LUGX-011, LUGX-013, LUGX-022, LUGX-050, LUGX-052 |
| R3 | **Type System Fails to Enforce Encryption at Storage Boundaries:** Callers of `saveLocal` pass the `isEncrypted` flag and `content` payload independently. Raw ciphertext is rendered into the editor upon decryption failure. The server only validates the presence of an `iv` string. | LUGX-004, LUGX-017, LUGX-019, LUGX-048, LUGX-070, LUGX-071 |
| R4 | **Fragile Key Hierarchy Lacking Rotation:** The master key is held as raw bytes whose memory references are leaked. The device trust key is co-located alongside the encrypted data. PIN failure counters and trust epochs are unauthenticated client-side values. AAD derivation schemas are divergent and fragmented. No master key rotation mechanism exists. | LUGX-005, LUGX-015, LUGX-016, LUGX-035, LUGX-044, LUGX-064 |
| R5 | **Stripe Webhook Delivery & Sequencing Guarantees Are Absent:** Webhook route handler uniformly returns HTTP 200 on internal failures. User resolution relies on invoice metadata rather than durable customer bindings. The schema enforces a single subscription record per user. Subscription IDs are unverified, and event timestamps are unsequenced. | LUGX-025, LUGX-026, LUGX-027, LUGX-068, LUGX-069 |
| R6 | **Systemic Fail-Open Defaults:** Rate limiters permit requests when Redis is unavailable. `isSubscriptionEventProcessed` treats Redis read errors as new events. CI executes with an incompatible Redis client, forcing all guard paths down the fail-open fallback branch. | LUGX-079, LUGX-093, LUGX-148 |
| R7 | **Tautological Tests and CI Gates Incapable of Failure:** Integration tests re-implement business logic rather than importing production modules. E2E specs mutate database state directly and immediately assert against that mutation. Database push (`drizzle-kit push --force`) swallows migration errors. `singleFork` is a no-op in Vitest 4, and metric/link checkers pass without genuine assertions. | LUGX-028, LUGX-076, LUGX-078, LUGX-086, LUGX-088, LUGX-091 |
| R8 | **Documentation Formally Contradicts Implementation on Security Claims:** Documents explicitly assert "Zero Plaintext At-Rest", "Fail-Closed", "Non-Extractable Keys", "Offline Extraction Immunity", "instantly invalidates", "Server-side route barrier", and "100% Passed", all of which diverge from active code behavior. | LUGX-035, LUGX-079, LUGX-084, LUGX-085, Table 5.2 |

### 1.4 Immediate Remediation Priorities

1. Remove `refundAIReservation` and `commitAIReservation` exports from `"use server"` boundaries, make the server atomically commit quota upon emitting the `done` SSE frame, bind `operationId` to the request payload fingerprint, and reject replays (LUGX-001, LUGX-002, LUGX-006).
2. Prohibit clearing the file dirty flag without a 2xx server response bound to the submitted revision, and establish persistent conflict states in IndexedDB (LUGX-003, LUGX-022, LUGX-010, LUGX-011, LUGX-013).
3. Enforce a single local write bottleneck that mandates encryption and fails closed when master keys are absent, with inbound decryption returning explicit tagged variants (LUGX-004, LUGX-017, LUGX-019).
4. Unify seed wrapping and unwrapping AAD contexts under a typed schema, accompanied by an automated migration for existing user vaults (LUGX-005).
5. Ensure Stripe webhook handler emits HTTP 5xx on transient errors, and refactor subscriptions table to be indexed by `stripe_subscription_id` (LUGX-025, LUGX-027).

---

## 2. Methodology

### 2.1 Phase 1: Module Audits

- **Seven Dedicated Module Agents:** Each agent was assigned an isolated functional domain: Sync, AI, Vault, Backend, Editor, Docs, and Infrastructure.
- Each agent performed a **line-by-line inspection** of its domain files sourced from fixed manifest files located under `audit/lists/<module>.txt`. Agents executed an internal re-verification phase to confirm line ranges and prune unverified candidates (Appendix 7.4).
- **Audit Scope:** 355 files, strictly excluding third-party vendored assets: character maps (`cmaps`), fonts (`fonts`), `pdf.worker.min.mjs`, and `package-lock.json`. Module manifests totaled 365 entries, including 11 shared files (predominantly vault closure logs, E2E specs 10–12, and vault migrations). Appendix 7.1 details module coverage.
- **Agent Status Tags:** `CONFIRMED` designates flaws conclusively verified via code inspection or empirical execution. `LIKELY` designates flaws proven in code whose manifestation depends on specific race timings or unsimulated environments.

### 2.2 Phase 2: Independent Verification

- Three independent verification passes re-evaluated code directly from scratch without relying on prior report snippets:
  - `verify-v1.md`: Sync and Editor reports.
  - `verify-v2.md`: AI and Vault reports.
  - `verify-v3.md`: Backend, Infrastructure, and Documentation reports.
- **Verification Scope:** Every Critical or High finding, and every Medium finding tagged `LIKELY`. Remaining Medium and Low findings retained module agent severity, denoted explicitly in their status fields.
- **Verdict Lexicon:**
  - Confirmed.
  - Confirmed-with-correction (location, mechanism, or reproduction steps).
  - Downgraded.
  - Rejected.
- Zero findings were rejected in full. One sub-claim was rejected: account deletion via `DELETE` in DOCS-03. The speculative branch of AI-05 was deemed unreachable.

### 2.3 Empirical Reproduction

| Pass | Environment & Tools | Empirically Proven Findings |
|---|---|---|
| Sync Agent | `audit/sync-verify/` (esbuild, Node v20) | SYNC-06 (`eh.ts`), SYNC-20 (`wl.mjs` vs `@scure/bip39`), SYNC-22 (`cr2.ts`), SYNC-34 (`ls.ts`), and 3-way merge fuzz testing |
| AI Agent | `audit/ai-verify/t1.ts`, `t2.ts`, `t3.mjs` | AI-04, AI-06, AI-07, AI-13 |
| Vault Agent | `audit/vault-verify/verify.ts`, `verify2.ts` | T1 to T8: Recovery failure, PBKDF2 cost, counter/expiry bypass, offline revocation |
| Editor Agent | `/tmp/edaudit` with `pdfjs-dist@4.10.38` | EDITOR-03 (Buffer detachment), EDITOR-15, EDITOR-20, EDITOR-25 |
| Infra Agent | `/tmp/vt`, `/tmp/gate`, `/tmp/envsim`, `/tmp/mdl` | INFRA-01, INFRA-03, INFRA-06, INFRA-11 (Point 4), INFRA-18 |
| Verification v1 | Real `IndexedDBManager` & `SyncManager` over `fake-indexeddb`, mock HTTP server simulating `If-Match`/`expectedVersion` and pagination, `vitest@4.1.11`. Harness in `audit/verify-v1-harness/`; all 8 tests passed | SYNC-01, SYNC-03, SYNC-04, SYNC-05, SYNC-06, SYNC-07, SYNC-11, EDITOR-03 |
| Verification v2 | Node v20 with `esbuild`, verbatim copies of **production** `key-rotation.ts` & `ai-ops.ts` with mock Redis and database. Harness in `audit/verify-v2-harness/` | AI-02, AI-03, AI-04, AI-06, AI-07, VAULT-01 (`aad.mjs`), VAULT-05 (PBKDF2 cost ~157ms) |
| Verification v3 | Vitest 4.1.11 in `/tmp/verify3/vt`, source inspection of installed `drizzle-kit 0.31.10` | INFRA-01, INFRA-02; remainder via static code analysis and call graph tracing |

### 2.4 Limitations

- No live PostgreSQL cluster was provisioned. Concurrency claims in the database layer (e.g., AI-09a, BACKEND-12, BACKEND-13) were evaluated purely via static analysis and PostgreSQL documentation semantics.
- Neither Redis nor Upstash instances were provisioned live. INFRA-05 was not operationally verified due to the absence of `redis-server`.
- No real Stripe events or webhooks were processed against live endpoints. Billing findings rely on code analysis and official Stripe documentation contracts.
- Node runtime available during testing was v20, whereas the project specifies Node 22+ (`EBADENGINE`). Full Vitest repository test suites were not run; static assertion and file counts were compiled instead.
- Real browser DOM environments were not executed. The `DataCloneError` in EDITOR-03 was deduced from the HTML Living Standard, while buffer detachment was proven empirically.
- Playwright E2E suites were not run due to missing secrets, and Vercel dashboard settings were uninspected.

### 2.5 Consolidation and Merge Rules

1. **Final Severity Equals Verified Severity:** Corrections to file locations and failure mechanisms from verification passes supersede original module reports.
2. **Rejected Sub-claims Are Removed:** Sub-claims rejected by verification (such as account deletion via `DELETE` in DOCS-03) are excised from finding narratives.
3. **True Duplicates Are Merged:** Issues sharing the identical root cause and code location are consolidated under a single `LUGX-NNN` identifier, listing all constituent legacy IDs. Causal sequences or distinct instances sharing an underlying concept (e.g., D1 and D5 in v1) remain distinct findings linked via cross-references and critical chain mappings.
4. **Tie-Breaking Rule for Conflicting Verdicts:** Majority vote determines final severity. In a tie, the higher severity is adopted and the divergence is documented:
   - LUGX-015 (SYNC-09 and VAULT-05): v1 judged High, v2 judged Medium; resolved to High.
   - LUGX-035 (SYNC-10, VAULT-08, and DOCS-01): v1 judged Medium, v2 judged Medium, v3 judged "High or technically Medium"; resolved to Medium.
5. **Severity of Merged Findings:** The consolidated severity is the highest verified severity among its components unless explicitly overridden by a verification pass.
6. **Ordering:** Findings are ordered by final severity (Critical, High, Medium, Low), and by functional module within each tier.

---

## 3. Attack and Data-Loss Chains

### 3.1 Chain A: Free and Unlimited AI Usage (AI-01 + AI-02 + AI-03, reinforced by AI-04)

| Step | Mechanism | Source |
|---|---|---|
| 1 | Attacker submits `POST /api/ai/stream` with a valid session cookie, receiving `operationId` in the `type:"start"` SSE frame (`route.ts:193-200`), or specifies their own custom `operationId` (`route.ts:70`). | LUGX-001, LUGX-002 |
| 2 | Attacker reads the response stream until the `done` frame. The server fails to commit the reservation on normal completion (`route.ts:260-275`), leaving it in the `reserved` state. | LUGX-006 |
| 3a | Attacker calls `refundAIReservation(operationId)` directly via the `Next-Action` HTTP header. The Server Action lacks `getUser()` and `userId` scoping, returning `{refunded: true}` and decrementing `usage` (verified in v2 `run3.ts`). | LUGX-001 |
| 3b | Alternatively to 3a, attacker replays the identical `operationId` with a new text prompt. The replay branch (`ai-ops.ts:294-301`) inspects `status` alone without evaluating `expiresAt`, returning `reserved: true` without deducting quota, triggering a full AI generation (verified in v2: 1,999 words generated with zero usage increment). | LUGX-002 |
| 3c | If neither 3a nor 3b is executed, the daily scheduled cron cleaner (`cron.yml`: `"0 3 * * *"`, limit 100 rows) automatically refunds the stale reservation back to the user's quota. | LUGX-006 |
| 4 | Non-spaced text, such as CJK characters or Base64 blobs, is calculated as a single word by `countWords`. | LUGX-007 |

- **Compound Impact:** Uncapped consumption of Gemini LLM quota. The only boundary is 30 requests/minute and 100k characters/request.
- **Verification Calibration:** AI-01 in isolation is High (amplifying weekly free quota ~7x via daily sweeps). Combined with AI-02 or AI-03, it enables infinite consumption, elevating the chain to Critical. If cron were configured every 10 minutes as asserted in `README.md:649`, AI-01 alone would become Critical.
- **Remediation:** Enforce server-authoritative settlement (§6.1).

### 3.2 Chain B: Edit Loss on Conflict (SYNC-01 / EDITOR-07, connected to SYNC-03, SYNC-04, and SYNC-07)

| Step | Mechanism | Source |
|---|---|---|
| 1 | User edits file X while offline. File X is concurrently updated from another client. | — |
| 2 | Upon reconnecting, the orchestrator triggers the conflict dialog and immediately returns `"local"` synchronously (`use-editor-orchestrator.ts:308-311`) prior to any user interaction. | LUGX-003 |
| 3 | `handleConflict` marks the file as `isDirty: false` and flags operations as `synced` without dispatching a network push (`sync-manager.ts:1734-1747`). | LUGX-003 |
| 4 | Within the **identical sync cycle**, `pullUpdates` (near line 865) calls `pullFile` on the newly "clean" file whose ETag diverges, writing the remote version directly over local storage (1614-1627). Proven empirically in v1: `SYNC-01 local {c:'REMOTE-EDIT', dirty:false}`. | LUGX-003 |
| 5 | In the orchestrator, local content under conflict is saved with `isDirty: false` (`orchestrator:810-825`). The periodic pull cycle overwrites it in IndexedDB without reloading, leaving unsynced edits trapped solely in editor volatile memory. | LUGX-022 |

- **Adjacent Data Loss Vectors:**
  - Edits made during active push are marked clean (LUGX-010).
  - Local revision discarded after push, dropping subsequent offline edits (LUGX-011).
  - Rollback restores stale pre-push snapshot over newer edits (LUGX-013).
  - File marked clean on HTTP 404 (LUGX-041).
  - Diff3 engine drops duplicated lines silently (LUGX-045).
  - Eviction of oldest conflict when reaching 100 entries (LUGX-089).
- **Remediation:** Single persistence state machine with version-guarded writes (§6.2).

### 3.3 Chain C: Uploading Plaintext to Server Tagged as Ciphertext (EDITOR-01, fed by EDITOR-02, EDITOR-10, EDITOR-04, and EDITOR-18)

| Step | Mechanism | Source |
|---|---|---|
| 1 | When navigating away from an encrypted file containing dirty edits, the orchestrator retrieves `getValue()` (decrypted plaintext) and commits it with `isEncrypted: true` and the stale IV without encrypting (`orchestrator:1232-1246`). | LUGX-004 |
| 2 | `saveLocal` with `isDirty: true` enqueues an `update` operation via `coalesceOperation` (`use-sync.ts:295-361`). | LUGX-004 |
| 3 | `processSingleOperation` transmits `file.content` verbatim to the remote API (`sync-manager.ts:1009-1018`). | LUGX-004 |
| 4 | The API route only checks for the existence of `effectiveMetadata.iv` (`[id]/route.ts:157-167`), storing unencrypted plaintext marked as ciphertext in the database. | LUGX-004 |
| 5 | The flaw is not restricted to the 1000ms debounce window. In any offline session where `isDirtyRef=true`, the unmount flush overwrites the encrypted payload generated by the offline branch (near 826). | LUGX-004 (v1 correction) |
| 6 | Upon subsequent read, decryption fails, rendering raw content in the editor. Editing this raw content re-encrypts the raw string, causing irreversible corruption. | LUGX-048 |
| 7 | `persistClean` and wake paths persist decrypted text to IndexedDB tagged as encrypted. | LUGX-017 |
| 8 | Context menu "Remove Encryption" swallows decryption failure and uploads ciphertext as plaintext while deleting the IV, destroying the file. | LUGX-019 |
| 9 | Constructing AAD with an empty user ID in the offline orchestrator breaks all subsequent decryptions, triggering steps 6 and 8. | LUGX-056 |

- **Impact:** Complete failure of Zero-Knowledge confidentiality. Plaintext in IndexedDB is secured only by a device key stored alongside it (LUGX-035).
- **Remediation:** Typed encryption envelope preventing plaintext from carrying encrypted metadata (§6.3).

### 3.4 Chain D: Recovery Never Works, Vault Destroyable (VAULT-01, with VAULT-04, VAULT-02, and VAULT-03)

| Step | Mechanism | Source |
|---|---|---|
| 1 | Master key is wrapped with seed using AAD `vault:seed:${userId}` (`create-vault-modal.tsx:159-170`), but unwrapping is attempted using AAD `vault:recovery:${userId}` (`vault-unlock-modal.tsx:414-430`). Proven empirically in v2: `FAIL OperationError`, while control test with `vault:seed:` succeeds. | LUGX-005 |
| 2 | If a user forgets their password, their encrypted data is permanently lost, even when providing the correct 12-word recovery mnemonic. | LUGX-005 |
| 3 | Any valid session holder (via session theft or XSS) can overwrite `encryptedMasterKey` with random bytes without proof-of-possession, locking out the legitimate password with no recovery possible. | LUGX-063 |
| 4 | On a new device offline or during transient server failures, the creation modal is displayed, generating an orphaned master key used to encrypt local files (`file-context-menu.tsx:263-278`). | LUGX-024 |
| 5 | After fixing Step 1, a latent password reset flaw emerges: silent failure, no key re-wrapping, and no epoch advancement. | LUGX-062 |

- **Remediation:** Single Keyring abstraction with typed AAD schemas, cryptographic proof-of-possession, and key rotation (§6.4).

### 3.5 Associated High Chains

- **Billing Lifecycle Chain (BACKEND-04/05 + BACKEND-02):**
  - Upgrading from Pro to Ultra creates a second active subscription.
  - The single subscription row is overwritten.
  - Cancelling the old subscription downgrades the user to `free` while they continue paying for Ultra.
  - Webhook handler returns HTTP 200 on failure, permanently dropping retries (LUGX-027, LUGX-025, LUGX-026).
- **Editor Vault Lock Chain (EDITOR-08 + EDITOR-09 + EDITOR-11):**
  - Editor is unmounted from DOM on vault lock, discarding pending autosaves.
  - Unlocking mounts an empty, editable editor.
  - First keystroke overwrites the remote document with a blank file (LUGX-023, LUGX-047, LUGX-049).
- **Master Key Exfiltration Chain (SYNC-09 + SYNC-10 + INFRA-10):**
  - XSS in the absence of CSP grants read access to IndexedDB.
  - 6-digit PIN envelope is brute-forced offline in ~42.6 core-hours (153ms per PIN in v1 benchmark).
  - Device trust key is co-located alongside ciphertext in storage (LUGX-015, LUGX-035, LUGX-095).

---

## 4. Consolidated Findings

Each Critical, High, and Medium finding entry specifies: final severity, verification status, original finding IDs, exact code locations (`file:line`), code snippet, description, reproduction steps, and structural root-cause remediation. All file paths are relative to repository root.

### 4.1 Critical Findings (Critical)

#### LUGX-001 — Quota Refund Server Action `refundAIReservation` Exposed to Client Without Authentication or Ownership Validation
- **Final Severity:** Critical
- **Status:** Confirmed in verification v2, and confirmed with correction in verification v3: `operationId` arrives via the `start` SSE frame rather than a `meta` event.
- **Original IDs:** AI-02, DOCS-35. The `commitAIReservation` portion of AI-05 is cross-referenced in LUGX-115.
- **Location:**
  - `src/server/actions/ai-commit.ts:1` (`"use server"`) and `:395-400`.
  - `src/server/actions/ai-ops.ts:1`, `:478-561` (unscoped query by `operationId` in 482-484), and `:566-572` (`commitAIReservation`).
  - `src/hooks/use-ai-stream.ts:1` (`'use client'`) and `:16-17` (client-side imports).
  - `src/app/api/ai/stream/route.ts:193-200` (`start` frame carrying `operationId`).
  - Client hook refund invocations: `use-ai-stream.ts:111`, `145`, `474`, `499`, `614`, and `679`.
- **Snippet:**
```ts
// ai-commit.ts:395-400 ("use server")
export async function refundAIReservation(operationId: string, reason: string = "stream_failed") {
    return refundAIReservationOp(operationId, reason);
}
// ai-ops.ts:482-484
const reservation = await db.query.aiReservations.findFirst({
    where: eq(schema.aiReservations.operationId, operationId),
});
```
- **Description:**
  - The source file is marked with the `"use server"` directive and exported functions are imported by client code, exposing an action identifier that is compiled into the public browser bundle and callable as an unauthenticated POST endpoint.
  - The implementation lacks `getUser()` session resolution and contains no `userId` predicate in database queries, unlike `getAIReservationStatus` (`ai-ops.ts:642-648`) which enforces both.
  - Following normal streaming completion and full text delivery, a user can trigger a refund, obtaining AI output for free without incrementing their usage quota.
  - While architectural specifications declare that user-rejected previews are "settled as consumed and never refunded" (`docs/specs/ui-streaming-requirements.md:22`, `docs/architecture/ai/ai-quota-reservation-lifecycle.md:98-110`), this constraint was enforced only in browser client code.
  - Multiple refund invocation paths within the hook (version conflicts, commit failures, unmounting, `onError`, exceptions, recovery after reload) directly contradict the policy of zero refunds once tokens have been displayed.
- **Reproduction Steps:**
  1. Initiate a standard AI streaming request and capture the `operationId` from the `start` SSE frame.
  2. Dispatch an HTTP POST request to the application root with header `Next-Action: <action_id>` and JSON payload `["op_x", "x"]`.
  3. The response returns `{refunded: true}` and decrements `usage`. Proven empirically in v2 (`run3.ts` executed unauthenticated refund), and verified via live integration test `ai-quota-idempotency.live.test.ts:152,169,177` which succeeds without mocking `getUser`.
- **Structural Remediation:**
  - Move refund, commit, and reservation mutation logic into an internal module importing `"server-only"` without `"use server"` exports.
  - If a client-callable cancellation action is necessary, restrict it to `cancelMyReservation(operationId)`: resolving `getUser()`, scoping SQL queries by `user_id`, and permitting solely the state transition `reserved → refunded` prior to first token emission (`first_token_at IS NULL`).
  - Excised all refund triggers from client-side hooks; quota refunds are exclusively server-authoritative decisions.
  - Add an ESLint rule forbidding exported functions accepting `userId` from `"use server"` files, alongside negative tests for non-owner refunds and post-`done` refunds.

#### LUGX-002 — Replaying `operationId` Generates Fresh Text Without Quota Deduction Until Cron Sweeper
- **Final Severity:** Critical
- **Status:** Confirmed with correction in verification v2. Location in `processText` is line 789 (not 787). The replay branch fails to validate `expiresAt`, extending the vulnerability window until the daily sweeper executes (up to 24 hours).
- **Original IDs:** AI-03, and the `options.operationId` aspect of AI-08 (Cluster D7 in v2).
- **Location:** `src/app/api/ai/stream/route.ts:70`; `src/server/actions/ai-ops.ts:285-302` (replay branch 294-301); `src/server/actions/ai-ops.ts:789` (`processText`).
- **Snippet:**
```ts
// route.ts:70
operationId = body.operationId || `op_${crypto.randomUUID()}`;
// ai-ops.ts:293-301
if (existing) {
    if (existing.status === "reserved") {
        return { reserved: true, reservationId: existing.id, ... }; // No deduction & no payload comparison
```
- **Description:**
  - `operationId` is an untrusted client-controlled parameter.
  - If an existing reservation record with matching identifier is found in the `reserved` state, the server returns `reserved: true` without quota deduction, without validating that `wordCount`, `operation`, or `fileId` match the original reservation. A full LLM generation is subsequently performed on the new text.
  - Per-request limits (`getLimitsForOperation`) remain enforced, but cumulative quota is never deducted. Reserving 1 word enables unlimited subsequent generations.
  - Root cause is independent of LUGX-006: an idempotency key uncoupled from request payload fingerprinting.
  - Tests `ai-quota-idempotency.test.ts:108-141` and `ai-quota-idempotency.live.test.ts:87-111` test identical `wordCount` parameters, codifying the vulnerable behavior.
- **Reproduction Steps:**
  1. Dispatch `POST /api/ai/stream` with body `{"operationId":"op_fixed","text":"hi","operation":"improve"}`.
  2. Dispatch a second request reusing `"op_fixed"` with a 100,000-character payload.
  3. A new generation executes while user `usage` remains unchanged. Proven empirically in v2: replaying with 1,999 words returned `reserved: true` with empty usage updates.
- **Structural Remediation:**
  - The server must generate `operationId` unconditionally. Client-supplied idempotency keys must strictly prevent double-billing.
  - Persist a request fingerprint `request_hash = sha256(operation|text|fileId)` in the reservation row and reject any replay with differing hash via HTTP 409 Conflict.
  - Replays with matching hash must not re-invoke Gemini, but return cached results or reject duplicate generation.
  - Enforce `expiresAt` checks on every replay branch.

#### LUGX-003 — Selecting 'local' Resolution Clears Dirty Flag Without Push; Orchestrator Emits 'local' Before User Decision
- **Final Severity:** Critical
- **Status:** Confirmed with correction in verification v1; impact is more immediate than originally reported: data loss occurs within the same sync cycle.
- **Original IDs:** SYNC-01. Conceptually linked to LUGX-022 (EDITOR-07) as identical root cause across two locations (Cluster D1 in v1).
- **Location:**
  - `src/lib/sync/sync-manager.ts:1734-1747`.
  - `src/hooks/use-editor-orchestrator.ts:308-311`.
  - Inbound overwrite vector: `pullUpdates` (near `sync-manager.ts:865`) calling `pullFile` in `1614-1627`.
  - Conflict resolution dialog handler: `handleResolveConflict` in `use-editor-orchestrator.ts:1448-1560`.
- **Snippet:**
```ts
// sync-manager.ts:1734
} else if (resolution === 'local') {
    // When local resolution is selected, clear dirty flag and mark all operations as synced
    const refreshedFile = await this.idb.getFile(localFile.id);
    if (refreshedFile) {
        refreshedFile.isDirty = false;
        refreshedFile.lastSyncedAt = Date.now();
        await this.idb.saveFile(refreshedFile);
    }
// use-editor-orchestrator.ts:308-311
setIsConflictDialogOpen(true);
return "local";
```
- **Description:**
  - On non-identical conflicts, the orchestrator triggers the conflict dialog but synchronously returns `"local"` immediately before the user selects any resolution.
  - `handleConflict` marks the file as `isDirty: false` and flags queued operations as `synced`, without pushing local content and without updating `etag` or `version`.
  - During Step 3 of `sync()`, `pullUpdates` calls `pullFile` on the file that is now marked clean but has a diverging remote ETag, overwriting local content within the same cycle.
  - Although the dialog pushes when the user eventually makes a selection, local IndexedDB state has already been purged or overwritten.
  - The dialog's "Cancel (Keep Local)" button fails to preserve local data.
- **Reproduction Steps:**
  1. Edit file X while offline.
  2. Edit file X from another connected client.
  3. Reconnect the first client.
  4. After a single `sync()` pass, file X in IndexedDB has `isDirty: false` and remote server content. Empirically proven in v1: `SYNC-01 local {c:'REMOTE-EDIT', dirty:false}`.
- **Structural Remediation:**
  - Make conflict a durable file state (`status='conflict'` or persistent `conflictState` in IndexedDB with `isDirty: true`) cleared solely by explicit user resolution.
  - The conflict hook callback must return a Promise that resolves only upon user decision.
  - The 'local' resolution must trigger a conditional push (`If-Match: serverEtag`, `expectedVersion: server.version`).
  - Forbid clearing `isDirty` without an HTTP 2xx server confirmation.
  - Ensure `pullFile` refuses to overwrite any file in an active conflict state.

#### LUGX-004 — Unmount Flush Persists Plaintext Tagged as Encrypted, Which SyncManager Uploads to Server
- **Final Severity:** Critical
- **Status:** Confirmed in verification v1, with scope expanded to include offline sessions.
- **Original IDs:** EDITOR-01.
- **Location:** `src/hooks/use-editor-orchestrator.ts:1232-1246`; `src/hooks/use-sync.ts:295-361`; `src/lib/sync/sync-manager.ts:1009-1018`; `src/app/api/files/[id]/route.ts:157-167`. Offline overwrite vector near `use-editor-orchestrator.ts:826`.
- **Snippet:**
```ts
// use-editor-orchestrator.ts
1233: if (isDirtyRef.current && adapterRef.current && syncHookRef.current?.isInitialized) {
1235:     const dirtyContent = adapterRef.current.getValue();
1238:         content: dirtyContent,
1242:         isEncrypted: isEncryptedRef.current,
1243:         encryptionMetadata: fileEncryptionMetadataRef.current,
// route.ts
157: if (currentFile.isEncrypted && isEncrypted !== false && content !== undefined) {
159:     if (!effectiveMetadata?.iv) { ... 400 }
```
- **Description:**
  - When unmounting an encrypted file with pending modifications (navigation or editor adapter switch), the orchestrator retrieves decrypted text via `getValue()` and persists it with `isEncrypted: true` and the stale IV, completely bypassing encryption.
  - `saveLocal` with `isDirty: true` enqueues an operation via `coalesceOperation`. `processSingleOperation` subsequently transmits `file.content` verbatim. The API route only asserts that `iv` is present.
  - Unencrypted plaintext is permanently stored in the remote database carrying encryption metadata, destroying the Zero-Knowledge guarantee and violating the invariant enforced in the normal write path (`content: isEncryptedRef.current ? contentToSend : content`, line 817).
  - Scope expansion in v1: The flaw is not restricted to the 1000ms debounce timer. In offline sessions where `isDirtyRef=true`, the unmount flush writes plaintext **over** the encrypted ciphertext generated by the offline persistence branch.
- **Reproduction Steps:**
  1. Open an encrypted file with vault unlocked.
  2. Input modifications and navigate away within 1000ms, or edit while offline and navigate away.
  3. Inspect IndexedDB: content is plaintext while `isEncrypted: true`.
  4. Process the queue and inspect database `content` column: stored as plaintext.
- **Structural Remediation:**
  - Establish a single `persistLocal(fileId, plaintext)` pipeline routing through `SyncCryptoGateway.encryptOutbound` whenever encryption is enabled, failing closed if master keys are unavailable. When closed, edits reside in volatile RAM only.
  - Implement defensive validation in `saveLocal` rejecting ciphertext payloads that fail Base64 or length checks corresponding to AES-GCM.
  - The API route must validate that incoming ciphertext is valid Base64 with at least 16 bytes (AES-GCM tag length) and reject IV reuse for updated payloads to prevent GCM nonce reuse vulnerabilities.

#### LUGX-005 — BIP-39 Recovery Phrase Never Unlocks Vault Due to AAD Mismatch
- **Final Severity:** Critical
- **Status:** Confirmed with correction in verification v2. Assertion that the UI never calls `encryption.ts` functions was incorrect: `vault-unlock-modal.tsx:11` and `trust-device-modal.tsx:7` import PIN and `generateSalt` functions. However, password/recovery functions (`master_key:` and `recovery_master_key:`) remain unused by the UI.
- **Original IDs:** VAULT-01.
- **Location:** `src/components/vault/create-vault-modal.tsx:159-170` (wrapping); `src/components/vault/vault-unlock-modal.tsx:414-430` (unwrapping); worker passes AAD to `additionalData` in `src/lib/workers/crypto.worker.ts` (`handleWrapKeyRaw` and `handleUnwrapKeyRaw`, lines 180-240).
- **Snippet:**
```ts
// create-vault-modal.tsx:165-170
const seedWrapResult = await cryptoWorkerBridge.wrapKeyRaw(
    kekSeed, masterKeyRaw, ivSeed, `vault:seed:${userId}`);
// vault-unlock-modal.tsx:425-430
unwrappedMasterKey = await cryptoWorkerBridge.unwrapKeyRaw(
    kekSeed, wrappedObj.ciphertext, ivBytes, `vault:recovery:${userId}`);
```
- **Description:**
  - AES-GCM authentication tags require identical AAD input; mismatched strings cause unwrapping to fail unconditionally.
  - If a user loses their password, their encrypted data is permanently unrecoverable despite entering the correct 12-word recovery mnemonic.
  - Three conflicting AAD derivation schemas exist: `vault:pass:`, `vault:seed:`, and `vault:recovery:` in UI components, alongside `master_key:` and `recovery_master_key:` in `encryption.ts:117,140,162,185`.
  - Byte slicing via `slice(0,32)` was not the root cause, as `mnemonicToSeed` returns 256 bits (`mnemonic.ts:439-448`).
  - Documentation claims recovery passed 100% (`vault-phase-5-closure-test-matrix.md:90`), while tests exercised functions disconnected from actual UI components (VAULT-TG-01).
- **Reproduction Steps:**
  1. Create a vault, record the 12-word mnemonic, and lock the vault.
  2. Input the mnemonic into the recovery tab; UI displays "Invalid or corrupted recovery seed".
  3. Proven empirically by Vault agent: T2 emitted `InvalidCiphertextOrKeyError`, while T3 control test succeeded. Re-verified in v2: `aad.mjs` yielded `FAIL OperationError` while control passed.
- **Structural Remediation:**
  - Centralize master key wrapping/unwrapping into a unified module (`vault-keyring.ts`) using strictly typed AAD constants (`AAD.passwordWrap(userId)` and `AAD.recoveryWrap(userId)`).
  - Forbid direct UI calls to `wrapKeyRaw`/`unwrapKeyRaw` via `no-restricted-imports`.
  - Implement full round-trip tests exercising the exact methods invoked by UI components.
  - Introduce a `wrapFormatVersion` column in user vault profile, with automated migration attempting `vault:seed:` fallback and re-wrapping with the unified schema.
### 4.2 High Findings (High)

#### LUGX-006 — Client-Driven Quota Settlement Leaves Reservations in Reserved State; Sweeper Refunds Completed Streams
- **Final Severity:** High in isolation; Critical as part of Chain A (§3.1).
- **Status:** Confirmed with correction in verification v2; downgraded in isolation from Critical to High. Timing correction: the scheduled cron job runs once daily (`.github/workflows/cron.yml:20-22`, `"0 3 * * *"`) with a 100-row limit (`ai-ops.ts:677`), rather than every five minutes.
- **Original IDs:** AI-01.
- **Location:** `src/app/api/ai/stream/route.ts:260-275` (no commit after `done`); `src/server/actions/ai-ops.ts:378` (5-minute TTL) and `:670-736` (`expireStaleReservations`); server-side commit exists only in `route.ts:177-188` (`handleClientDisconnect`) and `:328-331` (`cancel()`).
- **Snippet:**
```ts
// route.ts:260-264 — End of successful stream
const doneFrame = JSON.stringify({ type: "done" }) + "\n";
controller.enqueue(encoder.encode(doneFrame));
controller.close();
// ... telemetry only; no commitAIReservation
```
- **Description:**
  - Upon standard streaming completion, the reservation remains in the `reserved` state, relying on the browser client hook to execute a commit action.
  - An adversarial client (e.g. `curl`) refrains from dispatching the commit action. The daily cron sweeper subsequently classifies the reservation as `expired` and refunds the reserved words back to user `usage`.
  - Live integration test `ai-preview-decision.live.test.ts:159-169` confirms that reservations remain in the `reserved` state post-stream.
  - In isolation, this vulnerability multiplies the free weekly quota approximately 7x because the sweeper refunds daily. Daily Pro quotas do not benefit, as the sweeper refunds against the previous day's `periodKey`.
- **Reproduction Steps:**
  1. Execute `curl -N -X POST /api/ai/stream -b <cookie> -d '{"text":"...","operation":"improve"}'` and read through the `done` SSE frame.
  2. Inspect the database: the corresponding row in `ai_reservations` remains in status `reserved`.
  3. Following execution of the cron job, the status transitions to `expired` and `usage` is decremented.
- **Structural Remediation:**
  - Enforce Server-Authoritative Settlement: the streaming route must atomically commit the reservation the instant `done` is enqueued, and commit partial consumption upon client disconnect occurring after the first token.
  - UI preview acceptance/rejection pertains to editor document content, not financial quota consumption.
  - The sweeper must only refund reservations where zero tokens were delivered (`first_token_at IS NULL` or `delivered_units = 0`).

#### LUGX-007 — Word Quota Bypass via Unspaced Text
- **Final Severity:** High
- **Status:** Confirmed in verification v2.
- **Original IDs:** AI-04, and the "5 million characters counted as 1 word" component of AI-08 (Cluster D6 in v2).
- **Location:** `src/lib/utils.ts:14-16`; `src/app/api/ai/stream/route.ts:78-81`; `src/config/tiers.config.ts:34-47`.
- **Snippet:**
```ts
export function countWords(text: string): number {
    return text.trim().split(/\s+/).filter(Boolean).length;
}
```
- **Description:**
  - Quotas and reservation units are tracked in words, whereas physical request boundaries are enforced in characters (100k).
  - Any text lacking whitespace delimiters is evaluated as a single word, including Chinese, Japanese, Thai, or Base64 encoded blobs.
  - This completely bypasses the free tier weekly quota (2,000 words) and per-request summarization limits (500 words).
- **Reproduction Steps:** Submit a 100,000-character Chinese text prompt for summarization on a free tier account. The request is accepted and billed as 1 word. Proven empirically by AI agent (`ai-verify/t1.ts`) and verification v2: `a*100000 → 1` and `CJK 80k → 1`.
- **Structural Remediation:** Adopt a unified, manipulation-resistant unit of measure: either token counting via `countTokens` or `max(words, ceil(chars/6))`, applied consistently across `getLimitsForOperation`, `reserveAndUpdateUsage`, and client validation.

#### LUGX-008 — Invalid API Key Classified as 'invalid_request', Permanently Preventing Key Rotation
- **Final Severity:** High
- **Status:** Confirmed in verification v2.
- **Original IDs:** AI-06.
- **Location:** `src/lib/ai/key-rotation.ts:271-288` (HTTP 400 check precedes authentication check in `290-305`); `src/lib/ai/client.ts:318-322`, `546-550`; `getApiKeyForRequest` in `key-rotation.ts:520-554`.
- **Snippet:**
```ts
if (statusCode === 400 || message.includes("invalid argument") || message.includes("bad request") || ...) {
    return { category: "invalid_request", statusCode: 400, retryableWithKey: false, ... };
}
// Checked only subsequently:
if (statusCode === 401 || message.includes("api key not valid") || ...)
```
- **Description:**
  - Gemini API returns HTTP 400 with message `API key not valid` for revoked or invalid keys. The Google SDK (`@google/generative-ai ^0.24.1`) prefixes errors with `[400 Bad Request]`, causing the first conditional branch to capture the error.
  - `getApiKeyForRequest` pins the key index as long as the key is considered "healthy", and does not increment failure counters for `invalid_request` errors. A single revoked key positioned at the active pointer stalls all requests without triggering rotation or failover, causing complete service outage.
  - Test `ai-key-rotation.test.ts:380-387` utilized an artificial mock error string ending in `(401)`.
- **Reproduction Steps:** Configure `GEMINI_KEY_1` as an invalid key with `CURRENT_KEY_INDEX=0`. Dispatch any request: it fails without rotation, and all subsequent requests fail continuously. Proven in v2 verification harness (`run.ts` returned `invalid_request`).
- **Structural Remediation:** Classify errors using structured error fields (`error.status` and `details[].reason`, e.g. `API_KEY_INVALID`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`), order evaluation rules from most specific to general, and add golden tests with verbatim Gemini error payloads.

#### LUGX-009 — Background File Conflict Decrypted and Overwritten onto Currently Open Editor File
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v1: reproduction steps in module report were corrected.
- **Original IDs:** SYNC-02. Belongs to Cluster D3 (SYNC-02, SYNC-12, SYNC-14), with SYNC-14 acting as gateway.
- **Location:** `src/hooks/use-editor-orchestrator.ts:249-273` (decrypting with `fileId`), `286-295` (`saveLocal` for `fileId`), `1448-1560` (`handleResolveConflict`); auto-resolution in `src/lib/sync/sync-manager.ts:1685-1700`.
- **Snippet:**
```ts
const serverInbound = await SyncCryptoGateway.decryptInbound({
    fileId,                       // Active editor fileId, NOT conflict.fileId
    content: conflict.serverVersion.content, ...
await syncHookRef.current.saveLocal({
    id: fileId,                   // Writes onto currently open file
    isDirty: false,
```
- **Description:**
  - `pushDirtyFiles` and the sync queue process all dirty files globally, while the only active instance of `useSync` resides in the editor orchestrator (`orchestrator:545`).
  - `handleSyncConflict` ignores `conflict.fileId`, passing the currently open editor `fileId` to decryption AAD contexts, content matching branches, and the conflict dialog.
  - v1 correction: When server content matches local content, the manager auto-resolves prior to invoking the callback. The orchestrator match branch is reached only when normalizations diverge (CRLF vs LF, NFC, or `\0`), or when the manager compares raw ciphertext in the queue path (LUGX-038).
  - Primary data corruption occurs in the dialog path: the conflict dialog opens for a background file, but resolves by writing that resolution onto the open editor file using the foreign file's `expectedVersion`.
- **Reproduction Steps:**
  1. Open file A in the editor.
  2. Cause encrypted background file B to become dirty with a conflict arriving via queue or normalization divergence.
  3. Trigger `sync()`: the conflict dialog prompts for file B, but applying resolution writes content onto file A.
- **Structural Remediation:** Conflict resolution must be an application-level service indexed strictly by `conflict.fileId`, decoupled from active editor state. All decryption, storage writes, and dialogs must bind exclusively to `conflict.fileId`.

#### LUGX-010 — Lost Update: Edits Made During Active Push Are Marked Clean
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v1: primary path is `processSingleOperation`; `pushFile` is a secondary path.
- **Original IDs:** SYNC-03. Conceptually identical across layers: LUGX-052 (EDITOR-14) and LUGX-050 (EDITOR-12), comprising Cluster D2 in v1.
- **Location:**
  - `src/lib/sync/sync-manager.ts:977-1180` (`processSingleOperation`, commit near line 1133).
  - `src/lib/sync/indexeddb.ts:550-605` (`commitFileAndOperationSync`), `643-662` (`coalesceOperation`), `525-545` (`markFileClean`).
  - `sync-manager.ts` near 1360 (`pushFile`, secondary), and `1198-1201` (excluding queued files from `pushDirtyFiles`).
- **Snippet:**
```ts
// indexeddb.ts:525
async markFileClean(id, newEtag, newVersion?) {
    const file = await this.getFile(id);     // Reads current content (which may be newer than what was pushed)
    if (file) {
        file.isDirty = false;
        file.baseSnapshot = { content: file.content, etag: newEtag, ... };
```
- **Description:**
  - `saveLocal` does not acquire `concurrencyManager` locks.
  - `coalesceOperation` merges new edits into an in-flight (`syncing`) operation. Upon network success, the operation is marked `synced`, and the commit routine re-reads the file record with its latest content and marks it `isDirty: false`.
  - The server holds the older content, while the local record holds the newer content falsely tagged as clean; the newer edits are never transmitted.
- **Reproduction Steps:** Introduce a 500ms network delay on `fetch`, and invoke `saveLocal({id, content:'v2'})` during the delay. Proven empirically in v1: `SYNC-03 local {c:'v2', dirty:false} server v1 ops [['synced','v2']]`; server remained at `v1` on subsequent cycles.
- **Structural Remediation:** Introduce a monotonically increasing `localRevision` counter incremented on every `saveLocal` and transmitted with the push. Mark clean only if current `localRevision` matches the pushed revision using CAS within an atomic IndexedDB transaction; otherwise retain `isDirty: true` updating only `etag`/`version`. Restrict coalescing to `queued` operations.

#### LUGX-011 — Local Version Not Updated After Successful Push, Causing False 412 Resolved by Dropping Next Edit
- **Final Severity:** High
- **Status:** Confirmed in verification v1 and empirically proven.
- **Original IDs:** SYNC-04.
- **Location:**
  - `src/lib/sync/sync-manager.ts` near 1017 (`expectedVersion: op.baseVersion ?? file.version`), false match branch near 1027, lines `1133` and `1360` (committing without `newVersion`), lines `1685-1700`.
  - `src/app/api/files/[id]/route.ts:188-205` (`expectedVersion` comparison) and `300-307` (server returning `version`).
- **Snippet:**
```ts
await this.idb.markFileClean(file.id, data.etag);          // data.version ignored
...
if (localPlaintext === serverPlaintext || compareETags(localFile.etag, serverVersion.etag)) {
    const cleanFile = { ...localFile, etag: serverVersion.etag, version: serverVersion.version, isDirty: false };
    await this.idb.saveFile(cleanFile);   // No push dispatched
```
- **Description:**
  - The server returns the newly incremented `version`, but the client only updates `etag`.
  - On the next push, `If-Match` matches but `expectedVersion` is stale, prompting an HTTP 412 Precondition Failed response from the server.
  - `handleConflict` inspects matching ETags, erroneously classifies the conflict as false, and marks the file clean without pushing. Every second offline edit is silently dropped.
- **Reproduction Steps:**
  1. Starting with a file at version 1, perform offline edit 1 and call `sync()`.
  2. Perform offline edit 2 and call `sync()`.
  3. Proven empirically in v1: `PUT bodies [['edit-1',1],['edit-2',1]]`; server remained at `edit-1` while local had `edit-2` marked `isDirty: false`.
- **Structural Remediation:** Push response is an atomic `{etag, version}` entity committed via a mandatory-signature commit routine (`newVersion` required). ETag equivalence must not imply content parity unless the ETag is deterministically derived from the payload just transmitted.

#### LUGX-012 — Sync Watermark Advances Using Client Clock Even When Pull Fails
- **Final Severity:** High
- **Status:** Confirmed in verification v1 and empirically proven.
- **Original IDs:** SYNC-05.
- **Location:** `src/lib/sync/sync-manager.ts:865-875`, `1440-1443` (swallowing error); `src/lib/sync/indexeddb.ts:1032-1045`.
- **Snippet:**
```ts
const pullResult = await this.pullUpdates(signal);
result.success = result.errors.length === 0;
await this.idb.updateLastSyncedAt(this.config.userId);   // Unconditional advance
// indexeddb.ts
metadata.lastSyncedAt = Date.now();   // Client system clock
```
- **Description:**
  - `pullUpdates` swallows network and pagination errors (non-OK responses or mid-stream disconnects), yet unconditionally advances `lastSyncedAt` to `Date.now()`.
  - Dropped remote updates are never requested again on subsequent `updated_after` queries.
  - Relying on local client clocks causes missed updates whenever clock skew occurs.
- **Reproduction Steps:** Force the second page of `/api/files/sync` to return HTTP 500. Proven empirically in v1: `errors ['Pull failed: 500'] watermark advanced true a true b false`; file `b` was permanently omitted from sync.
- **Structural Remediation:** Implement a server-issued high-water mark cursor derived from server-side `updatedAt` or monotonic sequence, persisted only upon successful completion of all pagination pages within the same atomic transaction that stores the files.

#### LUGX-013 — Rollback Restores Pre-Push Snapshot Over Newer Local Edits
- **Final Severity:** High
- **Status:** Confirmed in verification v1 and empirically proven.
- **Original IDs:** SYNC-07.
- **Location:** `src/lib/sync/rollback.ts:134-157`, `197-206`; invoked from queue `catch` and `pushFile` `catch` (`sync-manager.ts:1172`, `1374`).
- **Snippet:**
```ts
const restoredFile: IDBFile = {
    ...currentFile,
    content: checkpoint.content,
    etag: checkpoint.etag,
    version: checkpoint.version,
    isDirty: true,
};
await this.idb.saveFile(restoredFile);
```
- **Description:**
  - When a push fails (due to transient network drops), the rollback handler overwrites the current file record with pre-push checkpoint content without version comparison, destroying any user edits saved during the flight of the request.
  - Rolling back local state on push failure is fundamentally flawed, as a failed network push alters no local data.
  - Test `sync-rollback.test.ts:95-121` codifies this destructive behavior.
- **Reproduction Steps:** Configure `fetch` in `pushFile` to reject after 300ms, and invoke `saveLocal(v2)` during that window. Proven empirically in v1: `local after rollback {c:'v1', dirty:true}`.
- **Structural Remediation:** Excised rollback from network push error handlers. Push failures must preserve current local state and schedule backoff retry. Local merge rollbacks, if required, must be CAS-guarded against `localRevision`.

#### LUGX-014 — Base Envelope Constructed with Mismatched IV, Breaking 3-Way Merge on Encrypted Files
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v1:
  - `baseSnapshot` contains `encryptionMetadata`, but `saveLocal` populates it on the first edit from caller arguments (`file.encryptionMetadata ?? existing`) using an incorrect IV, which the manager ignores in favor of `file.encryptionMetadata.iv`.
  - In locked vault states, `decryptAESGCM` throws, returning `'skipped'` instead of `CONFLICT_MANUAL` (lines 684-691), keeping the conflict permanently quarantined.
  - In unlocked states, the base reaches the conflict dialog as unparsed ciphertext.
- **Original IDs:** SYNC-08. Linked to LUGX-017 (Cluster D6 in v1).
- **Location:** `src/lib/sync/sync-manager.ts:1059-1066`, `1279-1286`, `1574-1581`; `src/hooks/use-sync.ts:131-137`, `309-311`.
- **Snippet:**
```ts
baseEnvelope: {
    iv: file.baseSnapshot?.isEncrypted ? (file.encryptionMetadata?.iv || '') : '',
    salt: file.encryptionMetadata?.salt || '',
    ciphertext: file.baseSnapshot?.content || '',
```
- **Description:** Every encrypted write generates a fresh IV (`sync-crypto-gateway.ts:155-165`). The base envelope pairs stale base ciphertext with the active version's IV, causing AES-GCM authentication to fail unconditionally after the first edit. 3-way merge is broken for all encrypted files. Test `sync-encrypted-conflict.test.ts` injects envelopes with valid IVs, masking the bug.
- **Reproduction Steps:** Take an encrypted clean file, edit it to generate a new IV, and induce a conflict. In locked state, sync returns `'skipped'` leaving the file quarantined. In unlocked state, raw ciphertext is fed into 3-way merge.
- **Structural Remediation:** `baseSnapshot` must be an atomic envelope record (`{ciphertext, iv, keyId, aadVersion}`) captured simultaneously with content; building composite envelopes from mismatched version fields is forbidden.

#### LUGX-015 — Trusted Device PIN Envelope Vulnerable to Offline Brute Force; Counter and Expiry Are Unauthenticated Client Data
- **Final Severity:** High. Divergent verdicts: v1 confirmed SYNC-09 as High; v2 downgraded VAULT-05 to Medium. Tie-breaker rule (§2.5) resolved to High.
- **Status:**
  - SYNC-09: Confirmed in v1. PBKDF2-SHA256 with 600,000 iterations takes 153ms per PIN, requiring ~42.6 core-hours for the complete \(10^6\) keyspace.
  - VAULT-05: Confirmed with correction and downgraded in v2: `encryption.ts:265-282` is production code imported by `vault-unlock-modal.tsx:11`; an attacker with local IDB access can brute-force directly without resetting counters; risk is acknowledged in UI.
  - High severity retained because XSS or local database extraction is sufficient to access the envelope.
- **Original IDs:** SYNC-09, VAULT-05. Epoch manipulation component of VAULT-05 is cross-referenced in LUGX-064.
- **Location:**
  - `src/lib/sync/encryption.ts:198-218` (6-digit PIN) and `255-282` (client-side `expiresAt` and `failedAttempts` checks; AAD from envelope epoch at `:282`).
  - `src/lib/sync/indexeddb.ts:1143-1165` (envelope in IDB).
  - `src/components/vault/vault-unlock-modal.tsx:224-259`.
  - `src/components/vault/trust-device-modal.tsx:303`.
  - `src/lib/sync/webauthn-prf.ts:358-366`.
- **Snippet:**
```ts
if (!/^\d{6}$/.test(cleanPin)) { throw new InvalidPinError(...) }
if (Date.now() > envelope.expiresAt) { throw ... }
if (envelope.failedAttempts >= 5) { throw ... }
const aad = `trusted_device:${userId}:${envelope.deviceTrustEpoch || 1}`;
```
- **Description:**
  - Master key is wrapped with a key derived from a 6-digit numeric PIN, with the complete envelope persisted in client IndexedDB.
  - The 5-attempt lockout and expiry timestamp are client-side JSON properties that are not authenticated in the unwrapping AAD.
  - Anyone extracting the IndexedDB store (via malware, browser extension, XSS, or device backup) can reset counters, extend expiry, and brute-force the keyspace offline.
  - Results in complete compromise of the master key and all encrypted user data. Documentation asserts "Offline Extraction Immunity" (DOC-04).
- **Reproduction Steps:**
  1. Trust a device with a 6-digit PIN and extract `sync_metadata['device_trust_envelope']`.
  2. Reset `failedAttempts=0` and set `expiresAt` to a future timestamp.
  3. Execute `unwrapMasterKeyWithPin` iteratively across `000000` to `999999`.
  4. Verified empirically: Vault agent T4 (165ms per trial), T5 (unlock succeeded after counter reset), T8 (unlock succeeded after expiry extension). Verified in v1 (153ms) and v2 (157ms).
- **Structural Remediation:**
  - Condition unwrapping on an off-device secret: either a server-validated PIN with server-side pepper/OPRF/OPAQUE enforcing remote lockouts (e.g. Signal SVR), or hardware-bound WebAuthn PRF / non-exportable `CryptoKey`.
  - Bind `expiresAt`, `deviceTrustEpoch`, and `trustedAt` into the authenticated data (AAD).
  - Correct conflicting documentation claims.

#### LUGX-016 — `getMasterKeyRaw` Leaks Internal Buffer Reference; Locking During `await` Causes Zero-Key Encryption
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v1: scope broadened to include all encrypted write paths.
- **Original IDs:** SYNC-11. Comprises Cluster D7 in v1 covering all callers of `getMasterKeyRaw`.
- **Location:**
  - `src/lib/sync/session-key-store.ts:139-145`, `252-261`.
  - `src/lib/sync/sync-manager.ts:517`, `598-603`.
  - Identified in v1: `src/lib/sync/sync-crypto-gateway.ts:143-152`; `src/hooks/use-editor-orchestrator.ts:624-640`; `src/components/layout/sidebar.tsx:341-353`; `src/components/files/file-context-menu.tsx:137`, `301`, `428`.
- **Snippet:**
```ts
public getMasterKeyRaw(): Uint8Array | null { ...; this.touch(); return this.masterKeyRaw; }
...
if (this.masterKeyRaw) { wipeBuffer(this.masterKeyRaw); this.masterKeyRaw = null; }
```
- **Description:**
  - Callers retain direct references to the internal `masterKeyRaw` buffer across `await` expressions, notably during `await generateRandomBytes` between key retrieval and encryption in `encryptOutbound` and orchestrator.
  - If the vault is locked during this window (via inactivity timer, cross-tab `vault_locked` broadcast, or logout), `wipeBuffer` zeroes the buffer in place. The in-flight execution proceeds, encrypting user data with a 32-byte array of zeroes and pushing it to the server.
  - Ciphertext on the remote server becomes decryptable by anyone, while remaining unrecoverable by the legitimate owner.
- **Reproduction Steps:** Call `getMasterKeyRaw()`, execute `sessionKeyStore.lock()`, and pass the reference to `encryptAESGCM`. Proven in v1 (`sk.test.ts`): buffer was zeroed in place, and WebCrypto accepted the zeroed key without throwing errors.
- **Structural Remediation:** Forbid returning raw key buffers. Provide a scoped `withMasterKey(fn)` abstraction operating over non-exportable `CryptoKey` handles, validating a monotonic `lockEpoch` before and after operations. In the interim, `getMasterKeyRaw` must return a detached clone (`slice()`).

#### LUGX-017 — `persistClean` and Wake Path Store Decrypted Text in IndexedDB Tagged as Encrypted
- **Final Severity:** High
- **Status:** Confirmed in verification v1. Stale IV is retained rather than adopting the server's new IV.
- **Original IDs:** EDITOR-02.
- **Location:** `src/hooks/use-editor-orchestrator.ts:1145-1156` (`persistClean`, invoked at 1164, 1171, 1177), `1396-1403` (wake path), `1104-1118` (`safeContent` decryption); `src/hooks/use-sync.ts:329-330`.
- **Snippet:**
```ts
1145: const persistClean = async () => {
1147:         await sh.saveLocal({
1149:             content: safeContent,          // Decrypted plaintext
1153:             isDirty: false,
// No isEncrypted or encryptionMetadata specified
```
- **Description:**
  - `safeContent` holds decrypted plaintext, while `saveLocal` preserves existing `isEncrypted`/`encryptionMetadata` flags when omitted by the caller, persisting unencrypted plaintext to disk under an encrypted tag.
  - On cold restart, the tag evaluates to `false`, treating the encrypted file as unencrypted locally.
  - In the wake path, if `isDirtyRef` is true, the plaintext payload enters the sync queue and uploads to the remote server as detailed in LUGX-004.
- **Reproduction Steps:** Open an encrypted file whose remote server version is newer than local storage (`adopt_remote` or `bootstrap_server` path), and inspect IndexedDB: content is plaintext.
- **Structural Remediation:** Enforce a single local write bottleneck that mandates encryption (as in LUGX-004), isolate `ciphertext` storage from in-memory volatile `plaintextCache`, and introduce invariant tests covering all `saveLocal` call sites.

#### LUGX-018 — Fast PDF Import Fails on All Valid Files: Buffer Detached in Corruption Detector Prior to Worker Dispatch
- **Final Severity:** High
- **Status:** Confirmed in verification v1 and reproduced with `pdfjs-dist@4.10.38`.
- **Original IDs:** EDITOR-03. Resolves alongside LUGX-060 via unified remediation (Cluster D10 in v1).
- **Location:** `src/components/layout/sidebar.tsx:275-324`; `src/lib/parsers/pdf-corruption-detector.ts:166,196`; `src/lib/parsers/pdf-worker-bridge.ts:87-89,128`.
- **Snippet:**
```ts
275: const arrayBuffer = await file.arrayBuffer();
280: const corruptionReport = await detectPdfFontCorruption(arrayBuffer, 5);
314: const extractResult = await pdfWorkerBridge.extractText(arrayBuffer, {...
// pdf-worker-bridge.ts
128: this.worker!.postMessage(request, [arrayBufferData as ArrayBuffer]);
```
- **Description:**
  - The detector passes the raw `arrayBuffer` to `pdfjs.getDocument`. In pdf.js 4.x, the buffer is transferred to its internal worker, detaching it and collapsing its `byteLength` to 0.
  - The identical detached buffer is subsequently included in the transfer list of `postMessage` to the PDF worker bridge. Browsers throw a `DataCloneError`, causing the extraction promise to reject.
  - The direct fallback path `extractPdfTextDirect` similarly fails on the detached buffer.
- **Reproduction Steps:** In the workspace sidebar, select "Import PDF" in Fast Mode with any valid text PDF. The UI immediately displays an import error. Empirically demonstrated: buffer length was 585 bytes before and 0 bytes (detached) after detection.
- **Structural Remediation:** Make buffer ownership explicit: consumers must accept `Uint8Array` and clone via `slice()`. Preferably, introduce a single `DETECT_AND_EXTRACT` worker message that inspects and parses in a single pass, eliminating LUGX-060 simultaneously.

#### LUGX-019 — Context Menu "Remove Encryption" Swallows Decryption Failure and Uploads Ciphertext as Plaintext
- **Final Severity:** High
- **Status:** Confirmed in verification v1.
- **Original IDs:** EDITOR-04.
- **Location:** `src/components/files/file-context-menu.tsx:443-486`.
- **Snippet:**
```ts
443: let decryptedContent = rawContent;
447:     try { ... decryptedContent = await cryptoWorkerBridge.decryptAESGCM(...) }
456:     catch {
457:         // Content may already be plaintext from local IndexedDB
458:     }
464: syncResult = await toggleFileEncryption(fileId, false, decryptedContent, null);
```
- **Description:**
  - Decryption exceptions are silently caught and ignored, transmitting `rawContent` (Base64 ciphertext) to the server as plaintext without `expectedVersion`, while deleting encryption metadata.
  - Decryption can fail for numerous reasons: invalid AAD, differing key, or IV mismatch in IDB (LUGX-014, LUGX-036, LUGX-017).
  - Deleting the IV and metadata renders the ciphertext permanently unrecoverable.
  - The comment at line 457 explicitly accommodates LUGX-017, transforming an internal state inconsistency into permanent data loss.
- **Reproduction Steps:** Configure `resolveEffectiveUserId` to return `""`, or select an encrypted file with an invalid key, and select "Remove Encryption". The file content is irreversibly replaced with raw Base64 text.
- **Structural Remediation:** Fail closed: abort the operation and surface an explicit error upon decryption failure. `decryptInbound` must return tagged status variants (`decrypted | plaintext_legacy | failed`). Decryption toggle must validate against server version anchors.

#### LUGX-020 — Cross-Tab Lost Update: Clean Tab Adopts Sibling's Version and ETag Without Its Content
- **Final Severity:** High
- **Status:** Confirmed in verification v1. Tab B does not pull remote changes because Tab A wrote the new ETag into shared IndexedDB, causing `pullFile` to bypass the update.
- **Original IDs:** EDITOR-05. Linked to LUGX-051 (Cluster D9 in v1).
- **Location:** `src/hooks/use-editor-orchestrator.ts:1343-1357`.
- **Snippet:**
```ts
1344: const isLocalDirty = localFile?.isDirty || activeConflictRef.current !== null || isDirty;
1346: if (!isLocalDirty) {
1347:     if (event.version && event.version > fileVersionRef.current) {
1348:         fileVersionRef.current = event.version;
1352:         fileEtagRef.current = event.etag;
```
- **Description:**
  - Upon receiving a `file_saved` broadcast, a clean tab advances its version and ETag anchors while retaining stale editor content.
  - The clean tab's subsequent edit is transmitted with the new `expectedVersion`, which the server accepts, overwriting the sibling tab's edits without a conflict.
  - `isDirty` at line 1344 is read from a potentially stale React closure.
- **Reproduction Steps:**
  1. Open the same document in Tab A and Tab B.
  2. Type in Tab A and save, generating version 2.
  3. Tab B adopts version 2 while keeping version 1 content.
  4. Type in Tab B and save: version 3 is created containing version 1 text plus Tab B edits, wiping Tab A edits.
- **Structural Remediation:** Document anchors (`version`, `etag`, and `content`) form an indivisible atomic entity. When `file_saved` arrives in a clean tab, it must atomically ingest content along with the anchor, or retain old anchors to let the server reject concurrent writes with HTTP 412.

#### LUGX-021 — AI Session Integrity Assertion Is Tautological, Wiping Non-Operation User Edits on Stream Failure
- **Final Severity:** High
- **Status:** Confirmed in verification v1: `session.editorGeneration` is passed to itself without dynamic reading (`rg getEditorGeneration` returns no matches). AI-11 was CONFIRMED by the AI agent.
- **Original IDs:** EDITOR-06, AI-11. Merged as identical underlying bug in `assertSessionIntegrity`.
- **Location:** `src/hooks/use-ai-stream.ts:285`, `335-347`, `345`, `423`, `488-490`, `605-607`; `src/lib/ai/stream-session.ts:141-152`; `src/hooks/use-editor-orchestrator.ts:909-921`, `1441`.
- **Snippet:**
```ts
423:  const integrity = assertSessionIntegrity(session, editorGeneration, expectedVersion);
488:  if (editorGeneration === session.editorGeneration && session.originalMarkdown) {
490:      editor.setValue(session.originalMarkdown);
// orchestrator
920:  editorGenerationRef.current += 1;
```
- **Description:**
  - `editorGeneration` is a snapshot of `editorGenerationRef.current` stored inside the session object; passing both to `assertSessionIntegrity` evaluates to true unconditionally, failing to detect concurrent editor edits or version shifts during streaming.
  - While the orchestrator explicitly permits edits outside the ghost diff range (909-914) and increments `editorGenerationRef`, the stream hook never reads the live reference.
  - On any error (empty response, network drop, commit conflict), `editor.setValue(session.originalMarkdown)` executes, reverting the entire document and erasing concurrent user input.
- **Reproduction Steps:**
  1. Select a paragraph and trigger "Improve".
  2. Concurrently type into another paragraph while text streams.
  3. Disconnect network: the document reverts entirely to its pre-operation snapshot.
- **Structural Remediation:** Pass a dynamic getter (`getEditorGeneration: () => number`) alongside the active editor version. Never execute full document resets: clear ghost decorations (`clearGhostDecoration`), or apply inverse change sets targeted strictly to the operation range using `mapPos`.

#### LUGX-022 — Orchestrator Persists Local Content Under Conflict with `isDirty:false`, Dropping Edits Without Reload
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v1: data loss does not require a page reload, as periodic background pulls overwrite clean records holding stale ETags.
- **Original IDs:** EDITOR-07. Common root cause with LUGX-003 (Cluster D1 in v1).
- **Location:** `src/hooks/use-editor-orchestrator.ts:810-825`.
- **Snippet:**
```ts
810: activeConflictRef.current = conflictObj;
815:     await syncHook.saveLocal({
817:         content: isEncryptedRef.current ? contentToSend : content,
819:         version: fileVersionRef.current,
823:         isDirty: false,
```
- **Description:**
  - Conflict state exists only in component memory. In IndexedDB, local edits are saved as `isDirty: false` under the stale version, and `saveLocal` marks queued operations as `synced`.
  - Periodic background pulls overwrite the local record with the remote server version. Edits exist solely in volatile editor memory until the dialog is closed.
  - Upon browser reload, reconciliation treats the remote version as authoritative (`adopt_remote`).
- **Reproduction Steps:** Induce a conflict via concurrent edits. While the dialog is displayed, wait for a pull cycle or reload: IndexedDB contains remote content with zero trace of local modifications.
- **Structural Remediation:** Persist conflicts durably in IndexedDB (`conflictState: {local, remote, base}` with `isDirty: true`) restored on startup, prohibiting automatic `adopt_remote` or `pullFile` overwrites while active.

#### LUGX-023 — Locking Then Unlocking Vault Leaves Empty Editable Editor That Overwrites Remote Document
- **Final Severity:** High
- **Status:** Confirmed in verification v1. `MarkdownEditor` has no `value` or `defaultValue` props; vector applies equally to `sessionKeyStore.subscribe` listeners in the same tab (1251-1264).
- **Original IDs:** EDITOR-08. Belongs to Cluster D8 in v1 alongside LUGX-047 and LUGX-049.
- **Location:** `src/app/workspace/editor/[fileId]/page.tsx:363-421`; `src/hooks/use-editor-orchestrator.ts:929-939`, `977`, `1219-1220`, `1251-1264`, `1281-1294`.
- **Snippet:**
```ts
933: const pending = pendingEncryptedPayloadRef.current;
934: if (!pending) {
936:     setHydration("ready");
937:     if (adapterRef.current) adapterRef.current.setEditable(true);
1220: if (loadedFileIdRef.current === fileId || pipelineRef.current) return;
```
- **Description:**
  - Vault locking unmounts `MarkdownEditor` from the DOM, destroying editor state, while pending payloads are cleared at line 977.
  - Unlocking sets hydration to `ready` without content, mounting a blank editable editor, while the loader effect exits early due to stale `loadedFileIdRef`.
  - The first keystroke triggers autosave with valid document anchors, overwriting the remote document with a single character.
  - Pending autosaves are discarded on lock without flushing (LUGX-049).
- **Reproduction Steps:** Open an encrypted file, lock the vault (via background tab or inactivity), unlock it: a blank editor appears. Typing any character overwrites the remote document.
- **Structural Remediation:** Do not unmount the editor on lock; set it to `readOnly` with a secure visual overlay and scrub decrypted text from memory. On unlock, force rehydration by clearing `loadedFileIdRef` and running the load pipeline. Guard autosave with `hydratedFromAnchor === currentAnchor`.

#### LUGX-024 — Vault Activation Proceeds Despite Server Save Failure or Pre-existing Vault, Creating Orphaned Master Key
- **Final Severity:** High
- **Status:** Confirmed in verification v2, with a broader trigger: `file-context-menu.tsx:263-278` displays creation modal whenever IDB lacks a profile and `getUserVaultProfile` fails (via throw or `success: false`).
- **Original IDs:** VAULT-02. Aggravated by LUGX-065 (VAULT-07).
- **Location:** `src/components/vault/create-vault-modal.tsx:187-213`; `src/server/actions/vault-actions.ts:79-102`; `src/components/files/file-context-menu.tsx:263-278`.
- **Snippet:**
```ts
try {
    const res = await createUserVaultProfile(payload);
    if (!res.success && res.status !== "conflict") {
        console.warn("[CreateVaultModal] Server save warning:", res.error);
    }
} catch (serverErr) {
    console.warn("[CreateVaultModal] Offline server sync deferred:", serverErr);
}
sessionKeyStore.setMasterKey(masterKeyRaw, 1);
```
- **Description:**
  - Upon server failure (including `status: 'conflict'` indicating a pre-existing vault), an orphaned master key is activated locally, with lines 188-196 persisting the orphaned profile to IndexedDB prior to server confirmation.
  - No retry mechanism exists; invocation occurs solely at line 204.
  - Server executes `findFirst` followed by `insert` without transactions or `ON CONFLICT` clauses.
  - Because local profiles are preferred unconditionally, the client remains permanently locked to the orphaned key.
- **Reproduction Steps:** Create a vault on Device A. On Device B while offline, complete vault creation. Encrypt a file on Device B and restart the browser: the file cannot be decrypted with Device A's password.
- **Structural Remediation:** Two-phase creation protocol: master keys are activated only upon verified server acknowledgment. On `conflict`, fetch the remote profile and route to unlock. While offline, queue creation in a durable outbox as `pending_server_ack` and disallow encryption. On server, enforce `INSERT ... ON CONFLICT (user_id) DO NOTHING RETURNING`.

#### LUGX-025 — Stripe Webhook Handler Returns HTTP 200 on Internal Handler Failure, Permanently Dropping Retries
- **Final Severity:** High
- **Status:** Confirmed with correction in verification v3: explicit `throw` at line 274 is swallowed by `catch` in lines 365-368.
- **Original IDs:** BACKEND-02.
- **Location:** `src/app/api/stripe/webhook/route.ts:663-679`; error-swallowing handlers in `:235-238`, `:252-255`, `:365-368`, `:381-384`, `:451-455`; duplicate lock return in `:589-593`.
- **Snippet:**
```ts
663:         if (mutationMeta.success) {
673:         } else {
675:                 await withTimeout(redis.del(lockKey)).catch(() => {});
677:         }
679:         return NextResponse.json({ received: true, event: eventId });
```
- **Description:**
  - Sub-handlers intercept all exceptions and return `success: false` (covering transaction failures, database disconnects, and unhandled states), while the top-level route handler returns HTTP 200 regardless.
  - Successful payments fail to upgrade accounts, and cancellations fail to downgrade tiers, with Stripe recording deliveries as succeeded.
  - Concurrent duplicate deliveries are answered with HTTP 200 `deduplicated`; if the initial delivery fails, the event is permanently lost.
  - Test `stripe-webhook.test.ts:571-591` codifies returning 200 on failure.
- **Reproduction Steps:** Cause `recordSubscriptionEvent` to throw, and dispatch a signed `customer.subscription.deleted` webhook. The response is HTTP 200, no state is updated, and Stripe dashboard marks the webhook successful.
- **Structural Remediation:** Return HTTP 2xx only after database transactions commit and events are durably recorded; return HTTP 5xx on transient errors; return HTTP 2xx with `status='rejected'` strictly for permanent unrecoverable payload errors; return HTTP 409/503 on concurrent duplicate deliveries while lock is held.

#### LUGX-026 — `invoice.payment_failed` Reads Non-Existent `invoice.metadata.userId` on Subscription Invoices
- **Final Severity:** High
- **Status:** Confirmed in verification v3 along with sub-issue (b).
- **Original IDs:** BACKEND-03.
- **Location:** `src/app/api/stripe/webhook/route.ts:446-485` (lines 451-455 and 472-479); `src/lib/stripe/index.ts:101-106`; `src/lib/db/migrations/0004_stripe_constraints.sql:46-48`.
- **Snippet:**
```ts
451:         const userId = invoice.metadata?.userId;
452:         if (!userId) {
454:             return { success: false, error: 'Missing userId' };
472:             const subId = existingSub?.stripeSubscriptionId || '';
```
- **Description:**
  - Stripe propagates subscription metadata to `invoice.parent.subscription_details.metadata`, not `invoice.metadata`. Checkout configuration sets only `subscription_data.metadata`, causing the handler to exit unconditionally at line 454.
  - Secondary defects: immediately downgrading to `free` on initial payment failure despite Stripe smart retries; writing empty string `''` instead of NULL, colliding with partial unique index `WHERE stripe_subscription_id IS NOT NULL`; and failing to verify that `invoice.subscription` matches the user's active subscription.
  - Test `stripe-webhook.test.ts:204-211` artificially injected `metadata` into the root invoice object.
- **Reproduction Steps:** Complete Checkout using test card `4000 0000 0000 0341`. When renewal fails, server logs `Missing userId in invoice metadata` with zero state updates.
- **Structural Remediation:** Maintain a durable mapping (`stripe_customer_id → user_id` or `stripe_subscription_id → user_id`) populated at checkout. Resolve users via customer or subscription objects. Treat `customer.subscription.updated` as authoritative for status transitions, using `invoice.payment_failed` purely for alerting. Store NULL instead of empty strings.

#### LUGX-027 — Single Subscription Row Per User: Upgrade Creates Second Subscription, Events Unverified and Unsequenced
- **Final Severity:** High
- **Status:** Confirmed in verification v3; single root cause constitutes a duplicate cluster.
- **Original IDs:** BACKEND-04, BACKEND-05. Linked to LUGX-068 (BACKEND-06).
- **Location:** `src/app/api/stripe/create-checkout/route.ts:52-89`; `src/lib/stripe/index.ts:72-107`; `src/server/actions/subscription-actions.ts:196-211` (upsert key `userId`); `src/app/api/stripe/webhook/route.ts:294-345`, `374-441`, terminal guard at `:300`. Access path: `account/page.tsx:146-151` via `upgrade-button.tsx`.
- **Snippet:**
```ts
85:         const session = await stripe.checkout.sessions.create({
86:             customer: customerId,
87:             mode: 'subscription',
// subscription-actions.ts
200:             .where(eq(subscriptions.userId, userId))
```
- **Description:**
  - When a Pro user upgrades to Ultra, a new Checkout session is created instead of modifying the existing subscription, resulting in two concurrent active subscriptions in Stripe.
  - `upsertSubscription` overwrites the single user record, orphaning the first subscription from the database while billing continues.
  - Handlers fail to match incoming `subscription.id` against database records or evaluate `event.created`. Cancelling the old subscription downgrades the user to `free` despite paying for Ultra, and out-of-order events apply stale state.
  - Terminal guard at line 300 handles only `canceled → active`.
- **Reproduction Steps:**
  1. Subscribe to Pro, then click Upgrade to Ultra on `/account`: Stripe displays two active subscriptions, while the database retains only the new ID.
  2. Cancel the Pro subscription in Stripe dashboard: user tier becomes `free`.
- **Structural Remediation:** Primary key for `subscriptions` table must be `stripe_subscription_id`. Compute `users.tier` from the highest active or trialing subscription. Track `last_event_created` per subscription or fetch live state via `stripe.subscriptions.retrieve`. Use `stripe.subscriptions.update` with proration for plan switches. Derive checkout idempotency keys from `userId + tier`.

#### LUGX-028 — E2E Test Suites Are Largely Tautological: Actions Executed Against Database and Asserted Against Itself
- **Final Severity:** High, due to widespread prevalence and the misleading claim of "100% Passed". Verification v3 noted BACKEND-17 represents a related medium-severity gap.
- **Status:** Confirmed in verification v3.
- **Original IDs:** INFRA-04. Linked to LUGX-078, LUGX-086, and VAULT-TG-08.
- **Location:** `e2e/specs/02-file-tree-trash.spec.ts:53-123`; `03-codemirror-bidi.spec.ts:50-62`; `04-offline-sync-conflict.spec.ts:30-47`; `05-pdf-ocr-pipeline.spec.ts:43-45`; `06-ai-streaming-commit.spec.ts:32-77`; `07-ai-abort-reject.spec.ts:22-57,75-110`; `08-ai-failure-refund.spec.ts:22-69`; `09-ai-conflict-412.spec.ts:30-44`; `10-vault-lifecycle.spec.ts:25-72`; `13-stripe-billing.spec.ts:24-42`; `14-tenant-isolation.spec.ts:44-50`; `01-auth-session.spec.ts:36-37`; CI summary in `ci.yml:404-408`.
- **Snippet:**
```ts
await page.route("**/api/ai/stream", async (route) => {
    await route.fulfill({ status: 500, ... });
});
await e2eDb ...   // Test directly sets status: "refunded" in database
expect(refundedRes?.status).toBe("refunded");
```
- **Description:**
  - Test titles describe comprehensive user journeys (HTTP 412, ConflictDialog, AI streaming, refunds, webhooks, encryption), but test bodies directly mutate database rows and immediately query back those mutations, succeeding even if feature implementations are deleted.
  - Uses hardcoded `periodKey: "2026-09-19"`.
  - CI summary proclaims "15 User Journeys — 100% Passed".
  - Genuine tests: `12-vault-ai-shield`, algorithmic sections of `14`, and presentation assertions in `01`, `03`, and `11`.
- **Reproduction Steps:** Delete refund logic from stream route or remove ConflictDialog component, and execute `npx playwright test e2e/specs/04* e2e/specs/08*`: tests continue to pass.
- **Structural Remediation:** Enforce testing rule: Arrange via database, Act strictly via browser UI or HTTP endpoints, Assert on UI and database state concurrently. Enforce via ESLint rule forbidding `e2eDb.update/delete` following the initial `page.goto`. Mock Gemini at server boundary, use `stripe trigger` with signed webhooks, and generate `periodKey` dynamically from production utilities.
### 4.3 Medium Findings (Medium)

#### 4.3.1 AI Subsystem

#### LUGX-029 — Forced Key Rotation Penalizes Active Pointer Instead of the Specific Failing Key
- **Final Severity:** Medium, downgraded from High.
- **Status:** Downgraded in verification v2. Core mechanism confirmed, but key cooldown duration is 300 seconds and self-heals (`DEFAULT_KEY_COOLDOWN_SECONDS`, line 15), while the 24-hour permanent disable branch is virtually unreachable due to LUGX-008. The real-world consequence is partial load degradation rather than total outage.
- **Original IDs:** AI-07.
- **Location:** `src/lib/ai/key-rotation.ts:627-681` (specifically lines 633-651); callers in `src/lib/ai/client.ts:370`, `520`, and `597`.
- **Snippet:**
```ts
const storedIndex = await redis.get<number>(REDIS_KEYS.CURRENT_KEY_INDEX);
if (classification.category === "authentication") await markKeyDisabled(currentIndex, ...);
else if (classification.category === "quota") await markKeyCooldown(currentIndex, ...);
```
- **Description:** The client reports an error without passing `keyInfo.index`. Under high concurrency, an interleaved request may have already advanced the Redis key pointer, causing a healthy key at the new index to be placed into cooldown while the failing key remains in active rotation.
- **Reproduction Steps:** Request A retrieves key 0. A concurrent request advances the pointer to 1. Request A fails with HTTP 429. Empirically demonstrated (AI agent `t2.ts` and v2 `run.ts`): Redis sets `gemini:key_cooldown:1`.
- **Structural Remediation:** Change signature to `reportKeyFailure(failedIndex, error)` targeting the specific failing key, and advance rotation indices atomically using a conditional compare-and-set Lua script.

#### LUGX-030 — Non-Atomic Quota Accounting and Sweeper Execution
- **Final Severity:** Medium
- **Status:** Sub-issues (b), (c), and (d) from AI-09 and DOCS-04 confirmed by module agents. Sub-issue (a) confirmed with mechanism correction in verification v2, classified as strong LIKELY due to absence of live PostgreSQL in verification.
- **Original IDs:** AI-09, DOCS-04 (Cluster D9 in v2: identical pattern in `refundAIReservation` and `expireStaleReservations`).
- **Location:** `src/server/actions/ai-ops.ts:344-362`, `378-459`, `505-558`, `670-730`; documentation claims "Updated atomically" and "Zero Partial Mutations" in `docs/architecture/security/security-and-rate-limiting.md:225` and phase-18 closure line 137.
- **Snippet:**
```ts
// ai-ops.ts:346
quotaGuard = sql`(SELECT COALESCE(SUM(correct_words + improve_words + translate_words), 0)
  FROM ${schema.usage} WHERE user_id = ${userId} AND date >= ${weekStart}) + ${wordCount} <= ${limitsInfo.maxWords}`;
```
- **Description:**
  - **(a) Corrected:** Concurrent requests updating the same day row serialize on row locks, but the `SUM` subquery evaluates against the statement's initial read snapshot. Under PostgreSQL `READ COMMITTED`, `WHERE` clauses are re-evaluated against the new target row version only. This race window exists exclusively on the free weekly tier; the daily Pro tier guard is safe.
  - **(b)** Incrementing `usage` and inserting the reservation row are executed in separate queries outside a transaction; an insertion error drops quota without recording a reservation.
  - **(c)** On collision, rollbacks revert against `today` rather than `existing.periodKey`.
  - **(d) & DOCS-04:** Marking status `refunded`/`expired` and updating counters are separate queries; network drops between them leave reservations untracked, causing permanent quota leaks.
- **Reproduction Steps:** Inject a `throw` statement immediately following the reservation status update in a live sweeper test: the row transitions to `expired` while `usage` remains unadjusted.
- **Structural Remediation:** Wrap all reservation lifecycle mutations in a single `db.transaction`: execute `INSERT ... ON CONFLICT DO NOTHING RETURNING` first, followed by conditional updates. Introduce a weekly aggregation table (`usage_weekly`) or user-level advisory locks. Execute status transitions and quota returns within an atomic CTE statement (`WITH upd AS (UPDATE ... RETURNING) UPDATE usage ...`).

#### LUGX-031 — Streaming Settlement Races Between Client and Server, Contradicting Stated Security Policies
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; considered an artifact of Root Cause R1 in verification v2 (Cluster D1).
- **Original IDs:** AI-10.
- **Location:** `src/app/api/ai/stream/route.ts:177-188`, `284-290`, `328-331`; `src/hooks/use-ai-stream.ts:110-111`, `265`, `474`.
- **Snippet:**
```ts
// route.ts:284-290 — Inside streaming catch block
if (operationId) {
    await refundAIReservation(operationId, "mid_stream_failure");
}
```
- **Description:**
  - The server attempts to commit upon disconnect after first token delivery, while the client simultaneously issues refund actions on unmount or `onError`, producing non-deterministic outcomes.
  - `stopStream` in the `reserved` state triggers a commit (line 265), violating the policy of refunding before the first token is emitted.
  - The route `catch` block refunds even after delivering partial chunks to the client.
- **Reproduction Steps:** Disconnect the client immediately after receiving the first token while unmounting the component simultaneously: commit and refund race non-deterministically based on network timing.
- **Structural Remediation:** Implement a single server-authoritative state machine keyed on `first_token_at`, completely revoking client financial transition capabilities (§6.1).

#### LUGX-032 — Streaming Abort Leaks Reader in Server Route Until `maxDuration` Timeout
- **Final Severity:** Medium
- **Status:** CONFIRMED via simulation by module agent (`ai-verify/t3.mjs`).
- **Original IDs:** AI-13.
- **Location:** `src/lib/ai/client.ts:505-508`; `src/app/api/ai/stream/route.ts:206`, `233`.
- **Snippet:**
```ts
} catch (streamErr) {
    if (signal?.aborted || isStreamCancelled) {
        return; // Suppress downstream error if cancelled
    }
```
- **Description:** `start()` returns without calling `controller.close()` or `controller.error()`, leaving the pending `reader.read()` call at `route.ts:233` unresolved. Neither the `aborted` event nor `finally`/`releaseLock` blocks are reached, leaking promises and stream references until Next.js forces termination at `maxDuration`.
- **Reproduction Steps:** Abort the signal during stream reading in client model harness (`client.ts:490-508`). Output: `read2: STILL PENDING after 2s`.
- **Structural Remediation:** Always invoke `controller.close()` or `controller.error(abortErr)` on abort branches, and race `reader.read()` against `req.signal` via `Promise.race`.

#### LUGX-033 — Watchdog Timer and Memory Degradation in Stream Handler
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** AI-14.
- **Location:** `src/lib/ai/stream-handler.ts:196-203`, `212`, `235`, `297-303`; `src/app/api/ai/stream/route.ts:22`, `193-200`; `src/lib/ai/preview-buffer.ts:33-61`.
- **Snippet:**
```ts
firstChunkTimer = setTimeout(() => {
    if (!receivedFirstChunk) {
        fireWatchdogTimeout('AI_STREAM_FIRST_CHUNK_TIMEOUT', ...);
    }
}, firstChunkTimeoutMs);
```
- **Description:**
  - The first-chunk watchdog is cleared upon receiving the `start` frame emitted immediately by the server. If Gemini subsequently stalls, the timeout does not trigger until the 120-second global safety timer fires, despite `maxDuration = 60`.
  - `accumulatedText` buffer size is unbounded.
  - String concatenation in the preview buffer scales as \(O(n^2)\).
  - The existing test (`ai-stream-completion-terminality.test.ts:113-139`) only tests stalls occurring before any frame.
- **Reproduction Steps:** Configure a mock server to transmit the `start` frame and immediately halt transmission: the watchdog fails to trigger before 120 seconds.
- **Structural Remediation:** Arm the watchdog on the first actual text `chunk`, enforce an inactivity timeout shorter than `maxDuration`, cap maximum output size, and implement chunk array buffering with lazy joins.

#### 4.3.2 Sync Subsystem

#### LUGX-034 — HTTP 5xx and 429 Errors Misclassified as Non-Retryable Post-Rethrow; Failed Operations Orphaned
- **Final Severity:** Medium, downgraded from High.
- **Status:** Downgraded in verification v1. Misclassification confirmed, but data is not trapped permanently: content successfully reaches the server after network recovery via `pushDirtyFiles`. "Retry storm" claim was overstated, as only two PUT requests are dispatched per cycle without exponential backoff.
- **Original IDs:** SYNC-06.
- **Location:** `src/lib/sync/error-handler.ts:138-147`, `313-345`; `src/lib/sync/sync-manager.ts:1125-1172`; `src/lib/sync/indexeddb.ts:858-863`.
- **Snippet:**
```ts
if (!response.ok) {
    const syncErr = await syncErrorHandler.fromResponse(response, `Operation ${op.id}`);
    throw new Error(syncErr.message);          // Drops recoverable metadata
}
const isRetryable = isRetryableError(error);   // -> UNKNOWN, recoverable=false
```
- **Description:** Structured error classification is lost when wrapped in a generic `Error` instance, causing operations to enter `failed` status without a `nextRetryAt` timestamp. Once `maxRetries` is reached, operations remain permanently in `failed` status without routing to `dead_letter` or displaying a user notification. Every attempt executes an unnecessary rollback (LUGX-013).
- **Reproduction Steps:** Force `fetch` to return `{ok: false, status: 503}`. Empirically demonstrated (v1): status 503 produced `fromResponse.recoverable=true`, but re-throwing via `new Error()` caused `isRetryableError` to return `false`. After 6 cycles, the operation remained permanently `failed` with `attempts: 5`.
- **Structural Remediation:** Maintain a strongly typed `SyncHttpError` throughout the catch hierarchy, centralize HTTP status code classification, and enforce a type constraint requiring `nextRetryAt` on all non-terminal `failed` operations.

#### LUGX-035 — Local Device Key Stored Alongside Encrypted Data; Regenerated Silently on Read Errors While Docs Assert Zero Plaintext At-Rest
- **Final Severity:** Medium. Downgraded by v1 from High; affirmed as Medium by v2; v3 judged "High regarding security claim, or Medium technically". Resolved to Medium by majority consensus.
- **Status:** SYNC-10 downgraded (defense-in-depth) in v1; VAULT-08 code confirmed with LIKELY trigger in v2; DOCS-01 confirmed in v3.
- **Original IDs:** SYNC-10, VAULT-08, DOCS-01. Downstream downgrade path linked in LUGX-103 (SYNC-28).
- **Location:**
  - `src/lib/sync/indexeddb.ts:96-135` (`catch {}` in lines 111-113, key overwrite in 121-130, swallowing write failures in 131-133), lines `184-198` (legacy plaintext fallback), line `211` (`CorruptedLocalRecordError`), lines `477-484`.
  - Contradictory claims: `indexeddb.ts:2-6`; `README.md:447`, `462`, `477`; `docs/architecture/security/security-and-rate-limiting.md:155-159`; `docs/Plans/HYBRID_ENCRYPTION_AND_VAULT_PLAN.md:7, 309, 316`.
- **Snippet:**
```ts
} catch {
    // Fall through to generation if store read fails
}
const generated = await cryptoWorkerBridge.generateRandomBytes(32);
... .put({ id: 'local_device_key', keyBase64: arrayBufferToBase64(generated) });
```
- **Description:**
  - The local device key is stored as raw Base64 in the `sync_metadata` table within the same IndexedDB database. Any reader of IndexedDB can read the key and decrypt stored records simultaneously, rendering encryption-at-rest purely obfuscation.
  - A transient IndexedDB read error triggers silent generation of a fresh key that overwrites the existing key, converting existing records into unrecoverable `CorruptedLocalRecordError` exceptions which `getAllFiles` silently drops, destroying unpushed edits.
  - If saving the new key fails, records are encrypted using an in-memory ephemeral key.
  - Severity calibration: While the trigger is uncommon and vault content is protected by the master key, the risk escalates severely in combination with LUGX-004 and LUGX-017.
- **Reproduction Steps:** Inspect IndexedDB in DevTools under `textai_db_<userId>` → `sync_metadata`, copy `keyBase64`, and decrypt stored records in `files`. Alternatively, mock `IDBObjectStore.prototype.get` to throw once: a new key is written, corrupting existing records.
- **Structural Remediation:** Use `crypto.subtle.generateKey(..., extractable: false)` storing non-exportable `CryptoKey` instances in IDB, or wrap the key using WebAuthn PRF / vault master key. Distinguish "not found" from "read error", use `add` instead of `put`, treat persistence failure as fatal, remove legacy plaintext fallback paths, and align documentation.

#### LUGX-036 — 'server' Conflict Resolution Retains Local Encryption Metadata with Server Ciphertext
- **Final Severity:** Medium, downgraded from High.
- **Status:** Downgraded in verification v1 due to narrow reachability: the orchestrator only returns `'server'` from the content match branch (`orchestrator:284-306`), and the bug is reached primarily via LUGX-038. The remote server remains intact; corruption is confined to the local record.
- **Original IDs:** SYNC-12 (Cluster D3 in v1).
- **Location:** `src/lib/sync/sync-manager.ts:1717-1733`.
- **Snippet:**
```ts
const updatedFile: IDBFile = {
    ...localFile,                                   // Retains local encryptionMetadata
    content: serverVersion.rawCiphertext || serverVersion.content,
    etag: serverVersion.etag, version: serverVersion.version, isDirty: false,
};
```
- **Description:** `serverVersion.encryptionMetadata` and `isEncrypted` are not copied over, and `baseSnapshot` is left un-updated. Subsequent decryptions fail due to IV mismatches, presenting the document as corrupt or reversing its encryption state.
- **Reproduction Steps:** Induce a conflict on an encrypted file where `serverVersion.encryptionMetadata.iv ≠ local.iv`, and choose `'server'`: subsequent calls to `decryptInbound(getFile(id))` fail.
- **Structural Remediation:** Implement a unified "Adopt Server" routine that copies the entire server record payload (ciphertext, metadata, ETag, version, and base snapshot) without merging via local object spread.

#### LUGX-037 — Missing 'merge' Branch in `handleConflict` Leaves Operations Stuck in 'conflict' State
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-13.
- **Location:** `src/lib/sync/sync-manager.ts:1717-1749`; state set at `1096-1099`.
- **Snippet:**
```ts
if (resolution === 'server') { ... }
else if (resolution === 'local') { ... }
// No 'merge' branch exists
```
- **Description:** The TypeScript type definition allows the resolution value `"merge"`. If returned, the operation remains indefinitely in status `conflict`. Because `getDueOperations` filters out conflict operations, the file is never processed, remaining trapped without visual indicator in the UI.
- **Reproduction Steps:** Mock the conflict callback to return `'merge'`, and execute `sync()` twice: the operation remains in `conflict` status and is never pushed.
- **Structural Remediation:** Implement a discriminated union with an exhaustive `switch` block terminating in a `never` assertion, ensuring every conflict resolution transitions to a defined terminal state.

#### LUGX-038 — Sync Queue Path Passes Server Ciphertext Verbatim as Plaintext into `handleConflict`
- **Final Severity:** Medium
- **Status:** Confirmed in verification v1 and upgraded from LIKELY. Gateway to Cluster D3, acting as the primary entry point to LUGX-009 and LUGX-036.
- **Original IDs:** SYNC-14.
- **Location:** `src/lib/sync/sync-manager.ts:1094-1099` (in contrast to `1313-1331` where `pushFile` decrypts); line 1683.
- **Snippet:**
```ts
if (serverData.serverVersion) {
    await this.handleConflict(file, serverData.serverVersion);   // content = raw ciphertext
}
```
- **Description:** `serverPlaintext` contains raw ciphertext while `localPlaintext` holds decrypted text. Content comparison fails unconditionally for encrypted files, routing the conflict to the orchestrator. `rawCiphertext` does not exist in this path.
- **Reproduction Steps:** Enqueue an encrypted file in the sync queue that encounters an HTTP 412 response with identical remote content: an interactive conflict dialog opens instead of auto-resolving.
- **Structural Remediation:** Route all incoming conflict responses through a unified `SyncCryptoGateway` that normalizes payloads into `{plaintext, envelope}` before executing comparison logic.

#### LUGX-039 — `createCheckpoint` Throws Before Asserting File Existence, Trapping Operations in 'syncing' Status
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-15.
- **Location:** `src/lib/sync/sync-manager.ts:984-992`; `src/lib/sync/rollback.ts:74-77`.
- **Snippet:**
```ts
const checkpointId = await this.rollback.createCheckpoint(op.fileId, 'pre_sync', op.id); // Throws if file missing
const file = await this.idb.getFile(op.fileId);
if (!file) { ... 'failed' ... }        // Unreachable dead code
```
- **Description:** The exception is thrown outside the `try` block after the operation status has already transitioned to `syncing`. The operation remains trapped in `syncing` until `resetSyncingOperations` executes, repeating in an infinite retry loop. `pushDirtyFiles` permanently excludes files with active `syncing` operations.
- **Reproduction Steps:** Create a `queued` operation for a locally deleted file (`deleteFile` does not purge associated operations), and execute `processOperationsQueue()`: the operation remains stuck in `syncing`.
- **Structural Remediation:** Wrap all operation state transitions within a `try/finally` block ensuring definitive terminal state transitions, and delete files and operations within a single atomic IndexedDB transaction.

#### LUGX-040 — `coalesceOperation` Merges Fresh Edits into 'conflict', 'failed', or 'dead_letter' Operations
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-16.
- **Location:** `src/lib/sync/indexeddb.ts:643-662`.
- **Snippet:**
```ts
const existingPendingOp = existingOps.find(o =>
    !o.synced && o.status !== 'synced' && (o.operationType === operation.operationType || ...));
if (existingPendingOp) {
    const coalesced = { ...existingPendingOp, content: operation.content, timestamp: ... };
```
- **Description:** New edits inherit `status`, `attempts`, `baseVersion`, and `nextRetryAt` from existing operations. If the prior operation was in `conflict`, `dead_letter`, or terminal `failed` state, the fresh edit is never dispatched to the server. Test `sync-indexeddb.test.ts:347-398` tests `queued` operations only.
- **Reproduction Steps:** Transition an operation to `dead_letter`, then save a new edit via `saveLocal`: the coalesced operation inherits `dead_letter` and is never pushed.
- **Structural Remediation:** Restrict coalescing strictly to `queued` operations while resetting `attempts` and `nextRetryAt`, or generate a new independent operation bound to the latest `baseVersion`.

#### LUGX-041 — HTTP 404 Push Response Marks Local File Clean, Dropping Unpushed Edits
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-17.
- **Location:** `src/lib/sync/sync-manager.ts:1341-1351`; queue path in `1106-1118`; tombstone guard in `1473-1488`.
- **Snippet:**
```ts
if (response.status === 404) {
    // File deleted or non-existent on server -> mark clean locally so queue ceases retrying
    await this.idb.markFileClean(file.id, file.etag || '');
```
- **Description:** If a file was created offline and does not yet exist on the server, or was deleted by another client, receiving HTTP 404 causes local modifications to be marked clean and silently dropped. In the queue path, operations are marked `failed` with zero UI recovery mechanisms.
- **Reproduction Steps:** Delete a file from Client A, edit it while offline on Client B, and call `sync()`: the file is marked `isDirty: false` without warning.
- **Structural Remediation:** Treat HTTP 404 as a durable "Delete Conflict" surfaced via `ConflictDialog` (where a 'restore' strategy already exists), or transition to a file creation operation if the file was never published.

#### LUGX-042 — Background Decryption `touch()` Prevents Automatic Vault Inactivity Lock
- **Final Severity:** Medium
- **Status:** Confirmed in verification v1 and upgraded from LIKELY. Background access occurs via `SyncCryptoGateway.decryptInbound` inside `pullFile`. Vulnerability requires remote encrypted updates at least once per timeout window.
- **Original IDs:** SYNC-19.
- **Location:** `src/lib/sync/session-key-store.ts:128-145`.
- **Snippet:**
```ts
public getMasterKeyRaw(): Uint8Array | null {
    if (!this.isUnlocked()) { return null; }
    this.touch();
    return this.masterKeyRaw;
}
```
- **Description:** `getMasterKey` and `getMasterKeyRaw` invoke `this.touch()`, resetting the inactivity timer. Background synchronization and automatic inbound decryption keep the vault unlocked indefinitely without active user presence.
- **Reproduction Steps:** Unlock the vault and leave the client idle. Have another client modify an encrypted document periodically within the timeout window: the vault never locks.
- **Structural Remediation:** Couple inactivity timers exclusively to authentic user interface events (mouse and keyboard input), decoupling programmatic key retrieval from session activity tracking.

#### LUGX-043 — Non-Standard BIP-39 Wordlist Implementation (2052 Words)
- **Final Severity:** Medium
- **Status:** CONFIRMED empirically by module agent (`sync-verify/wl.mjs` against `@scure/bip39`).
- **Original IDs:** SYNC-20.
- **Location:** `src/lib/sync/mnemonic.ts:13-220` (wordlist); `336-343` (11-bit index mapping).
- **Snippet:**
```ts
for (const word of words) {
    const index = WORD_INDEX_MAP.get(word)!;
    for (let j = 10; j >= 0; j--) { bits.push((index >> j) & 1); }
}
```
- **Description:** The embedded wordlist contains 2,052 words instead of the standard 2,048 words specified by BIP-39. Indices 2048–2051 cannot be encoded within standard 11-bit chunks, making mnemonics incompatible with external BIP-39 utilities. Future corrections risk invalidating existing user mnemonics.
- **Reproduction Steps:** Compare `BIP39_WORDLIST` against `@scure/bip39/wordlists/english`: array length and contents diverge.
- **Structural Remediation:** Replace with an audited library (`@scure/bip39` with standard English wordlist), add test vector verification suites, and introduce a `mnemonicVersion` field for graceful user migration.

#### LUGX-044 — Missing Version and Metadata in File AAD Permits Stale Ciphertext Replay and Rollback
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-21.
- **Location:** `src/lib/sync/sync-crypto-gateway.ts:40-42`, `155-165`; duplicated metadata in `sync-manager.ts:607-614` and `use-editor-orchestrator.ts:646-652`.
- **Snippet:**
```ts
return `vault:file:${userId || ''}:${fileId}`;
...
salt: '', iv: encResult.ivBase64, kdfIterations: 600000,   // Hardcoded constants
```
- **Description:** A compromised database or man-in-the-middle attacker can roll back an encrypted file to an older ciphertext payload without detection. The AAD contains no version counter, title binding, key identifier, or KDF algorithm binding.
- **Reproduction Steps:** Replace the `content` column of an encrypted file with an older ciphertext blob for the same file: it decrypts successfully without integrity warnings.
- **Structural Remediation:** Include `{schemaVersion, fileId, userId, keyId, contentRevision}` within the AAD, record the latest known revision locally to reject rollbacks, and construct envelopes through a single builder.

#### LUGX-045 — 3-Way Merge (diff3) Silently Drops Duplicated Lines Without Conflict Warning
- **Final Severity:** Medium
- **Status:** CONFIRMED empirically by module agent (`sync-verify/cr2.ts`).
- **Original IDs:** SYNC-22.
- **Location:** `src/lib/sync/conflict-resolver.ts` (alignment algorithm and `extractSliceForRange` in lines 600-620).
- **Snippet:**
```ts
private extractSliceForRange(
    chunks: Array<{ baseStart: number; baseEnd: number; modTokens: string[] }>,
    start: number, end: number, baseSlice: string[]
): string[] {
```
- **Description:** Example: base=`"D\nC\nC"`, local=`"n6\nD\nC"`, remote=`"D\nC"`. Output produced is `"n6\nD"`, whereas the correct result is `"n6\nD\nC"`. Duplicated lines are pervasive in Markdown (blank lines, thematic breaks `---`, code fences). ConflictDialog auto-merges on success (LUGX-112), dropping content silently.
- **Reproduction Steps:** Execute 3-way merge on the provided input strings.
- **Structural Remediation:** Adopt a battle-tested diff3 implementation (`node-diff3` based on LCS/Myers), and implement property-based tests asserting that lines unmodified by either party are strictly preserved.

#### LUGX-046 — Rollback Checkpoints Stored in Module-Level Global Map Shared Across Users
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** SYNC-24.
- **Location:** `src/lib/sync/rollback.ts:37`.
- **Snippet:**
```ts
const checkpoints = new Map<string, SyncCheckpoint>();
```
- **Description:** The map is shared across all `SyncRollback` instances and user sessions. Calling `clearAll()` from one instance (such as upon account switching) evicts checkpoints belonging to another active push. Plaintext file contents remain retained in memory post-logout.
- **Reproduction Steps:** Instantiate two `SyncRollback` objects; invoking `clearAll()` on the first while the second is pushing deletes active checkpoints.
- **Structural Remediation:** Scope checkpoints inside instance state keyed by user ID, or eliminate the rollback mechanism entirely following implementation of LUGX-013.

#### 4.3.3 Editor and UI Subsystem

#### LUGX-047 — Early Exit on Vault Lock Enters `finally` Block, Falsely Transitioning Hydration State to "ready"
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; belongs to Cluster D8 in v1.
- **Original IDs:** EDITOR-09.
- **Location:** `src/hooks/use-editor-orchestrator.ts:998`, `1008-1020`, `1098-1101`, `1197-1215`.
- **Snippet:**
```ts
1019: setHydration("vault_locked");
1020: return;                       // Inside try block initiated at 998
1197: } finally {
1214:     setHydration("ready");
1215:     if (adapterRef.current) adapterRef.current.setEditable(true);
```
- **Description:** A `return` statement does not bypass the `finally` block. Because `loadFailureRef` remains `false`, hydration transitions immediately to `ready`, dismissing the lock screen and rendering a blank, editable editor. Key verification in `executeServerWrite` (625-632) rejects pushes but fails to preserve entered text.
- **Reproduction Steps:** Open an encrypted file with vault locked, then dismiss the unlock dialog: a blank, editable editor is displayed.
- **Structural Remediation:** Model hydration through an explicit state machine (`hydrating → vault_locked | ready | fatal`), where the terminal state is returned directly from the load pipeline rather than being unconditionally set in `finally`.

#### LUGX-048 — Decryption Failure Renders Ciphertext into Editor, Risking Permanent Re-encryption of Ciphertext
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent (Cluster D5 in v1, alongside LUGX-103).
- **Original IDs:** EDITOR-10.
- **Location:** `src/hooks/use-editor-orchestrator.ts:472-482`, `944-957`, `1105-1118`.
- **Snippet:**
```ts
1116: } catch (decErr) {
1117:     console.warn("[Orchestrator] Remote decrypt fallback:", decErr);
1118: }        // safeContent remains raw encrypted Base64 and is rendered
```
- **Description:** Across all three paths (remote update, document load, vault unlock), decryption exceptions cause raw Base64 ciphertext to be rendered into the editor view. If modified, the raw string is re-encrypted as document content, causing permanent file corruption.
- **Reproduction Steps:** Open an encrypted file with an invalid AAD (LUGX-056): raw Base64 text is rendered in the editor.
- **Structural Remediation:** `decryptInbound` must return a discriminated union. When `failed`, transition to a `decrypt_failed` state rendering a read-only warning overlay; never render raw ciphertext.

#### LUGX-049 — Pending Autosaves Dropped Without Persistence on Vault Lock
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; partially subsumed under LUGX-023 (Cluster D8 in v1).
- **Original IDs:** EDITOR-11.
- **Location:** `src/hooks/use-editor-orchestrator.ts:624-632`, `1281-1294`.
- **Snippet:**
```ts
625: if (!masterKey) {
629:     setIsVaultLocked(true);
631:     return;                         // No saveLocal executed
1283: debouncedAutoSaveRef.current?.cancel?.();
1285: sessionKeyStore.lock(false);
```
- **Description:** Inactivity locking cancels pending autosaves without flushing edits to encrypted storage or volatile memory. In cross-tab lock events, the debounce timer is cancelled, the editor is unmounted from the DOM, and master keys are cleared before encryption can execute.
- **Reproduction Steps:** Modify an encrypted file, lock the vault from another browser tab within 1,000ms, and unlock: recent edits are lost.
- **Structural Remediation:** Implement a two-phase lock protocol: `prepareLock` requests all tabs to encrypt and persist pending modifications, clearing keys only upon confirmation. If keys are missing, store edits in memory to be flushed upon unlock.

#### LUGX-050 — User Edits Made During Commit Phase Marked Clean Without Persistence
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; belongs to Cluster D2 in v1.
- **Original IDs:** EDITOR-12.
- **Location:** `src/hooks/use-editor-orchestrator.ts:353-374`, `892-896`.
- **Snippet:**
```ts
365:     content: isEncryptedRef.current && committedContent ? committedContent : adapterRef.current.getValue(),
371:     isDirty: false,
374: setIsDirty(false);
```
- **Description:** For unencrypted files, `getValue()` is evaluated after the network request finishes, capturing text typed during the commit window and recording it as clean under a version that does not include it. For encrypted files, `committedContent` is saved, causing editor display to diverge from saved storage while `isDirty` is false.
- **Reproduction Steps:** Accept an AI preview and immediately type during the flight of the network commit request; reload from another client: typed characters are missing.
- **Structural Remediation:** Persist strictly what the server committed (`committedContent`), and compare active editor generation against the post-commit snapshot; if they diverge, retain `isDirty: true` and schedule a follow-up save.
#### LUGX-051 — Cross-Tab `file_encrypted` and `file_decrypted` Broadcasts Discard Pending Unsaved Edits
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; common root cause with LUGX-020 (Cluster D9 in v1).
- **Original IDs:** EDITOR-13.
- **Location:** `src/hooks/use-editor-orchestrator.ts:1299-1319`, `1322-1330`.
- **Snippet:**
```ts
1300: debouncedAutoSaveRef.current?.cancel?.();
1301: isEncryptedRef.current = true;
1314: setIsDirty(false);
1315: isDirtyRef.current = false;
```
- **Description:** Receiving an encryption status event cancels pending autosave timers and clears dirty flags without persisting or comparing content. Sibling tab content is sourced from local IndexedDB which may be stale. The version counter is incremented (1306-1309), causing subsequent writes to overwrite encrypted content.
- **Reproduction Steps:** Type into Tab A, then select "Encrypt" on the same file in Tab B within 1,000ms: edits from Tab A disappear from the remote server.
- **Structural Remediation:** Structural transformations must acquire a cross-tab file lock via `navigator.locks.request(fileId)` and request active editors to flush modifications prior to executing the state shift.

#### LUGX-052 — Absence of Single-Flight Concurrency Control for Server Writes in Editor Orchestrator
- **Final Severity:** Medium
- **Status:** Confirmed in verification v1 and upgraded from LIKELY. Failure is deterministic whenever write latency exceeds debounce interval (1,000ms).
- **Original IDs:** EDITOR-14 (Cluster D2 in v1).
- **Location:** `src/hooks/use-editor-orchestrator.ts:597-700` (specifically 666-673), `871-875`.
- **Snippet:**
```ts
666: if (saveRes.success && saveRes.version) {
667:     fileVersionRef.current = saveRes.version;
673:     setIsDirty(false);
```
- **Description:** Debounce timers invoke `executeServerWrite` without awaiting prior in-flight executions. A second write dispatched with stale `expectedVersion` triggers a false self-conflict dialog. `setIsDirty(false)` clears dirty status even if typing occurred during the flight of the request.
- **Reproduction Steps:** Throttle network speed such that write round-trips exceed 1,000ms, and type continuously: a self-conflict dialog appears against the tab's own edits.
- **Structural Remediation:** Maintain a per-file serialized write queue with latest-wins coalescing; clear `isDirty` strictly when the transmitted editor generation matches the active generation.

#### LUGX-053 — Case-Insensitive Search Calculates Offsets on Text with Diverging Character Lengths
- **Final Severity:** Medium
- **Status:** CONFIRMED empirically by module agent.
- **Original IDs:** EDITOR-15.
- **Location:** `src/components/editor/search-replace.tsx:55-75`.
- **Snippet:**
```ts
57: const contentToSearch = caseSensitive ? content : content.toLowerCase();
65: const index = contentToSearch.indexOf(searchText, position);
71:     to: index + searchQuery.length,
```
- **Description:** `toLowerCase()` alters character counts in certain Unicode locales (e.g. `İ` U+0130 expands to two characters). String indices in `contentToSearch` fail to align with the original document, causing replacement operations to alter incorrect text slices.
- **Reproduction Steps:** In a document starting with "İİ test", perform a case-insensitive search for "test" and click replace: text is replaced at shifted offsets. Proven empirically: `"İstanbul foo"` has length 12, whereas its lowercased counterpart has length 13.
- **Structural Remediation:** Utilize `@codemirror/search` cursors (`SearchCursor`/`RegExpCursor`) or build a character offset mapping between original and normalized text representations.

#### LUGX-054 — Replace Operation Applies Stale Offsets Without Re-Verifying Target Content
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** EDITOR-16.
- **Location:** `src/components/editor/search-replace.tsx:109-150`.
- **Snippet:**
```ts
113: const currentMatch = matches[currentMatchIndex];
117: currentAdapter.replaceRange(from, to, replaceQuery);
139: currentAdapter.replaceRanges(changes);
```
- **Description:** `matches` is cached React state derived after debounce. Typing, remote sync pulls, or AI insertions shift document positions, causing replacements to execute against stale `(from, to)` bounds without verifying `doc.sliceString(from, to)`.
- **Reproduction Steps:** Search for a term, type a character prior to its position, and immediately press Ctrl+Enter: the wrong text range is replaced.
- **Structural Remediation:** Execute replacements within atomic CodeMirror transactions that re-evaluate matches against live `state.doc`, or maintain matches within a `StateField` automatically mapped via `mapPos`.

#### LUGX-055 — Context Menu Encrypt/Decrypt Reads Stale IDB Content and Calls `toggleFileEncryption` Without `expectedVersion`
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** EDITOR-17.
- **Location:** `src/components/files/file-context-menu.tsx:305-336`, `431-464`; server supports parameter in `src/server/actions/file-ops.ts:324`.
- **Snippet:**
```ts
305: const localFile = await indexedDBManager.getFile(fileId, effectiveUid);
306: let contentToEncrypt = localFile?.content ?? "";
336: syncResult = await toggleFileEncryption(fileId, true, encResult.ciphertextBase64, metadata);
```
- **Description:** Reads local IndexedDB content that may be outdated relative to server or editor state, overwriting newer remote updates without conflict checks. Server errors (337-339, 465-467) are swallowed while proceeding locally, inducing split-brain states.
- **Reproduction Steps:** Modify a file from Device A. On Device B (which has not pulled updates), select "Encrypt" from the context menu: Device A's edits are overwritten on the remote server.
- **Structural Remediation:** Anchor transformations to version snapshots: fetch latest content and version, execute cryptographic transform, transmit with `expectedVersion`, and handle 409/412 conflicts. On network failure, enqueue a `toggle_encryption` operation.

#### LUGX-056 — Empty User ID in Orchestrator AAD Derivation During Offline Sessions
- **Final Severity:** Medium
- **Status:** Confirmed with correction in verification v1: actual location is the editor orchestrator (sidebar and context menu paths are largely unreachable due to layout props). In the orchestrator, initial `userId` is `null` (`page.tsx:30`), and `supabase.auth.getUser()` fails while offline, returning `""`.
- **Original IDs:** EDITOR-18 (Cluster D11 in v1: root cause of decryption failures feeding LUGX-019 and LUGX-048).
- **Location:** `src/hooks/use-editor-orchestrator.ts:213-221`, used at `635`, `947`, `1108`.
- **Snippet:**
```ts
// file-context-menu.tsx (identical pattern)
74: return "";
316: const aad = `vault:file:${effectiveUid}:${fileId}`;
```
- **Description:** Offline operations derive AAD using `vault:file::<fileId>`. Reconnecting and attempting decryption with the genuine user ID causes authentication tag verification to fail permanently, driving execution into data-loss paths.
- **Reproduction Steps:** Open an encrypted file while offline before user ID resolution completes, save edits, reconnect, and reopen: decryption fails.
- **Structural Remediation:** Enforce a single `buildFileAAD(uid, fileId)` utility that validates `uid` is a non-empty UUID, throwing immediately upon violation.

#### LUGX-057 — Vault Import Records Clean File in IDB Before Server Confirmation
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** EDITOR-19.
- **Location:** `src/components/layout/sidebar.tsx:365-398`.
- **Snippet:**
```ts
369: await indexedDBManager.saveFile({
377:     version: 1,
380:     lastSyncedAt: Date.now(),
381:     isDirty: false,
388: result = await importFile(
```
- **Description:** File is marked clean in local storage before `importFile` executes. If import fails due to payload size, network drops, or database errors, an orphaned local record remains with no server counterpart and no sync queue entry. `ivBytes` is not scrubbed.
- **Reproduction Steps:** Import a file exceeding server body limits (LUGX-059) into the vault: the file persists in IndexedDB while non-existent on the server.
- **Structural Remediation:** Perform an optimistic write with `isDirty: true` and a queued `create` operation, or persist locally only following server confirmation.

#### LUGX-058 — Markdown Stripper Corrupts Exported Text While Documentation Claims Full Precision
- **Final Severity:** Medium
- **Status:** CONFIRMED empirically by editor and docs agents.
- **Original IDs:** EDITOR-20, DOCS-11.
- **Location:** `src/lib/exporters/utils/markdown-stripper.ts:18-70` (specifically lines 19, 38, 39, 54, 60, 63, 70); claims in `docs/guides/editor/data-export-guide.md:141, 181, 407, 415` and phase-6 closure line 65.
- **Snippet:**
```ts
19: cleanText = cleanText.replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, '$1');
39: cleanText = cleanText.replace(/_([^_]+)_/g, '$1');
63: cleanText = cleanText.replace(/<[^>]+>/g, '');
```
- **Description:** Regex stripping applies inline markdown rules inside code blocks after removing fences, corrupting code syntax. Empirical tests demonstrate:
  - `my_var_name` becomes `myvarname`.
  - `a < b && c > d` becomes `a d`.
  - `def __init__(self):` becomes `def init(self):`.
  - `- [x] done` becomes `[x] done`; line 60 is dead code.
  - Indentation and asterisks inside code blocks are discarded.
- **Reproduction Steps:** Export a document containing the above snippets to plain text (.txt).
- **Structural Remediation:** Utilize an AST-based parser (`@lezer/markdown` or `remark` with `strip-markdown`) that preserves `FencedCode` and `InlineCode` tokens verbatim, accompanied by property-based edge-case tests.

#### LUGX-059 — Advertised 10MB Import Limit Unreachable Due to Next.js Default 1MB Server Action Limit
- **Final Severity:** Medium
- **Status:** EDITOR-21 CONFIRMED via configuration; BACKEND-22 LIKELY.
- **Original IDs:** EDITOR-21, BACKEND-22.
- **Location:** `src/lib/parsers/file-validator.ts:15`; `src/server/actions/import-file.ts:36, 74`, `103` vs `119-121`; `next.config.ts` (lacks `experimental.serverActions.bodySizeLimit`).
- **Snippet:**
```ts
15: export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
74: if (Buffer.byteLength(textContent, 'utf-8') > MAX_TEXT_LENGTH) {
```
- **Description:** Files exceeding ~1MB fail with generic framework errors before reaching validation logic. Encrypted vault imports expand Base64 payloads ~1.33x. Binary file inspection is absent on both client and server for encrypted uploads.
- **Reproduction Steps:** Attempt importing a 2MB text file: request is rejected by Next.js framework boundaries.
- **Structural Remediation:** Align configuration limits with `bodySizeLimit` in `next.config.ts` accounting for Base64 overhead, or implement chunked streaming uploads via dedicated Route Handlers; move binary inspection to client prior to encryption.

#### LUGX-060 — Font Corruption Detector Parses PDF on Main Thread Using Fake Worker
- **Final Severity:** Medium
- **Status:** Confirmed in verification v1 and upgraded from LIKELY: `pdf.mjs:17499-17508` inspects `globalThis.pdfjsWorker?.WorkerMessageHandler` which is populated by `pdf.worker.mjs:4686`.
- **Original IDs:** EDITOR-22. Intersects with LUGX-110 (SYNC-36).
- **Location:** `src/lib/parsers/pdf-corruption-detector.ts:169-176`.
- **Snippet:**
```ts
169: await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
170: const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
```
- **Description:** Importing the worker module on the main thread sets `globalThis.pdfjsWorker`, forcing pdf.js into Fake Worker mode on the UI thread even when `workerSrc` is configured. Large or malicious PDFs block the UI thread, inducing client denial of service.
- **Reproduction Steps:** Import a large PDF in Fast Mode and observe UI freezing during font inspection.
- **Structural Remediation:** Encapsulate detection inside `pdf-worker-bridge` via a dedicated `DETECT_AND_EXTRACT` message as specified in LUGX-018.

#### LUGX-061 — PDF OCR Engine Lacks Dimension and Page Count Boundaries, Leaking Resources
- **Final Severity:** Medium
- **Status:** Confirmed in verification v1 and upgraded from LIKELY.
- **Original IDs:** EDITOR-23.
- **Location:** `src/lib/parsers/pdf-ocr-engine.ts:141-156`, `160-193`, `238-241`.
- **Snippet:**
```ts
154: const worker = await createWorker('ara+eng', 1, { cachePath: CACHE_NAME });
160: try {
167:     const viewport = page.getViewport({ scale: 2.0 });
189:     const ocrResult = await worker.recognize(canvas, {}, { text: true, blocks: true });
238: } finally { await worker.terminate(); await pdfDoc.destroy(); }
```
- **Description:** `createWorker` is invoked outside `try`, leaking `pdfDoc` if initialization fails. Scale is hardcoded to 2.0, allowing PDFs with extreme `MediaBox` dimensions to allocate canvases exceeding GPU limits. Page counts are uncapped, cancellation signals are ignored by `recognize`, and canvas memory is not explicitly released.
- **Reproduction Steps:** Run OCR on a PDF with extreme dimensions or hundreds of pages and cancel during processing: execution continues until page completion.
- **Structural Remediation:** Move `createWorker` inside `try`, implement dynamic scaling capped at a maximum pixel threshold (e.g. 16MP), enforce configurable page limits, terminate workers immediately on abort signals, and release canvas resources.

#### 4.3.4 Vault Subsystem

#### LUGX-062 — Post-Recovery Password Reset Fails Silently (Latent Defect Masked by LUGX-005)
- **Final Severity:** Medium, downgraded from High as a latent defect; returns to High upon resolution of LUGX-005.
- **Status:** Downgraded in verification v2. `handleCompletePasswordReset` is reached only after `setIsResetStep(true)` at line 438, which requires successful seed unwrapping (currently failing due to LUGX-005). Key re-wrapping and epoch escalation defects are consolidated into LUGX-064.
- **Original IDs:** VAULT-03.
- **Location:** `src/components/vault/vault-unlock-modal.tsx:505-534`.
- **Snippet:**
```ts
const serverRes = await updateVaultPassword(payload);
if (!serverRes.success) {
    console.warn("[VaultUnlockModal] Cloud password update deferred:", serverRes.error);
}
broadcastCrossTabEvent({ type: "vault_unlocked" });
onUnlocked(); onClose();
```
- **Description:** When server password updates fail, success is displayed to the user with no retry scheduled. The server retains the stale envelope while other devices retain the old password. The local device uses cached data, resulting in divergent credentials across devices.
- **Reproduction Steps (post-LUGX-005):** Recover vault, set a new password while the server returns an error: UI declares success, but other devices only accept the old password.
- **Structural Remediation:** Enforce a server-first flow where local caches update only after confirmed server acknowledgment, incrementing `deviceTrustEpoch` within the same transaction.

#### LUGX-063 — Server Actions Accept Master Key Envelope Replacement Without Proof-of-Possession
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** VAULT-04.
- **Location:** `src/server/actions/vault-actions.ts:114-152` (`updateVaultPassword`), `:61-109`.
- **Snippet:**
```ts
const [updated] = await db.update(schema.userVaultProfiles).set({
    encryptedMasterKey: input.encryptedMasterKey.trim(),
    keySalt: input.keySalt.trim(),
    kdfIterations: input.kdfIterations ?? existing.kdfIterations,
```
- **Description:** Any valid session cookie permits overwriting `encryptedMasterKey` with arbitrary bytes. Stolen sessions or XSS can permanently lock users out of their vault with zero recovery possible under LUGX-005. The server validates neither format nor payload bounds.
- **Reproduction Steps:** From an authenticated session, call `updateVaultPassword({encryptedMasterKey: "{}", keySalt: "x"})`: subsequent unlock attempts fail across all devices.
- **Structural Remediation:** Store an auth verifier derived via HKDF (`authKey = HKDF(MK, "vault-auth")`), enforce cryptographic proof-of-possession (HMAC challenge with server nonce) on envelope updates, and apply strict Zod validation.

#### LUGX-064 — Central Device Revocation Is Advisory and Non-Atomic; Epoch Read from Envelope; Master Key Unrotated
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent (T7); unified in verification v2 (Cluster D4).
- **Original IDs:** VAULT-06, VAULT-03 part 2, VAULT-05 epoch component, SYNC-32.
- **Location:** `src/server/actions/vault-actions.ts:154-189`; `src/components/vault/vault-unlock-modal.tsx:150-165`, `207-222`; `src/lib/sync/webauthn-prf.ts:275`, `363`; `src/lib/sync/encryption.ts:282`.
- **Snippet:**
```ts
// vault-actions.ts
 * This instantly invalidates all local device PIN envelopes across all devices.
const nextEpoch = (existing.deviceTrustEpoch || 1) + 1;
// vault-unlock-modal.tsx:208-222
try { const profileRes = await getUserVaultProfile(); ... } catch { /* If offline, continue with local verification */ }
```
- **Description:**
  1. Clients verify trust epochs only when online. While offline or on network failure, envelopes unwrap using local epoch data (proven in T7).
  2. The AAD `trusted_device:${userId}:${epoch}` is shared between PIN and PRF envelopes, and the epoch is parsed from the target envelope itself, failing to cryptographically invalidate old envelopes.
  3. Master keys are never rotated upon revocation or password reset, leaving compromised device envelopes perpetually functional (T6).
  4. Epoch increment executes via non-atomic read-modify-write queries.
  5. Documentation falsely promises "instant" global invalidation (DOC-01).
- **Reproduction Steps:** Trust Device A, trigger "Revoke All Devices" from Device B, disconnect Device A from the network, and unlock with PIN: unlock succeeds (T7).
- **Structural Remediation:** Execute atomic updates (`UPDATE ... SET device_trust_epoch = device_trust_epoch + 1 RETURNING`), validate epochs against server during unlock, bind envelope type into AAD, couple true revocation with master key rotation, and correct documentation.

#### LUGX-065 — Local Vault Profile Cache Preferred Unconditionally, Becoming Stale
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent (Cluster D5 in v2).
- **Original IDs:** VAULT-07.
- **Location:** `src/components/vault/vault-unlock-modal.tsx:113-135`, `:335`, `505-517`; `src/components/vault/create-vault-modal.tsx:191-196`.
- **Snippet:**
```ts
const cached = await indexedDBManager.getCachedVaultProfile();
if (cached) return cached;          // Never compared against server
const epoch = profile.deviceTrustEpoch || 1;
```
- **Description:** Stored profile caches are never refreshed against the server while present. Newly created profiles omit `deviceTrustEpoch`. After triggering "Revoke All Devices", new envelopes are generated with epoch 1 against the server's epoch 2, causing immediate deletion and preventing future device trust. Password changes on other devices are rejected locally.
- **Reproduction Steps:** Create a vault, execute "Revoke All Devices", and unlock with password while enabling "Trust this device": subsequent PIN unlocks continuously report that device trust has been revoked.
- **Structural Remediation:** Implement a network-first strategy with cache fallback, compare revision/updatedAt timestamps, fetch epochs from server during envelope generation, and align local and remote schemas.

#### LUGX-066 — Trusting Device Does Not Enforce Re-authentication If Vault Is Currently Unlocked
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** VAULT-09.
- **Location:** `src/components/vault/trust-device-modal.tsx:65-66`.
- **Snippet:**
```ts
async function ensureMasterKey(): Promise<boolean> {
    if (sessionKeyStore.isUnlocked()) return true;
```
- **Description:** Anyone accessing an unlocked browser session (unattended workstation or XSS) can configure an arbitrary PIN, acquiring 30 days of persistent offline access (LUGX-015) without knowing the master password.
- **Reproduction Steps:** Unlock vault, navigate to Account Settings, and select "Trust this device with PIN": setup completes without prompting for the master password.
- **Structural Remediation:** Enforce step-up authentication requiring master password entry or hardware biometric confirmation before creating persistent authentication credentials.

#### 4.3.5 Backend Subsystem

#### LUGX-067 — Latent Mass Assignment Vulnerability in `updateUserProfile`
- **Final Severity:** Medium, downgraded from High as a latent defect.
- **Status:** Confirmed with correction in verification v3: `updateUserProfile` is defined but unimported in client code. Next.js tree-shakes unreferenced server actions, preventing immediate exploitation. The flaw becomes a direct privilege escalation vulnerability if imported.
- **Original IDs:** BACKEND-01.
- **Location:** `src/server/actions/auth-actions.ts:1`, `:140-162`; target columns in `src/lib/db/schema.ts:28-29`.
- **Snippet:**
```ts
1: "use server";
140: export async function updateUserProfile(
141:     data: { displayName?: string }
150:             .set({
151:                 ...data,
```
- **Description:** `...data` is spread into Drizzle's `.set()` method without an allowlist. Drizzle accepts any column present in the `users` table schema, including `tier`, `stripeCustomerId`, and `email`. TypeScript interface types are erased at runtime.
- **Reproduction Steps:** Import `updateUserProfile` in a `"use client"` component and invoke `updateUserProfile({ displayName: "x", tier: "ultra", stripeCustomerId: "cus_victim" })`.
- **Structural Remediation:** Enforce strict runtime validation (`z.object({...}).strict()`), construct update payloads from explicit allowlisted properties, restrict sensitive columns to internal non-`"use server"` modules, and add an ESLint rule banning argument spreads in `.set()` and `.values()`.

#### LUGX-068 — Subscription Tier Derived from `subscription.metadata.tier` Instead of Stripe Price ID
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-06.
- **Location:** `src/app/api/stripe/webhook/route.ts:249-250`, `:279`.
- **Snippet:**
```ts
250:         const tier = subscription.metadata?.tier as TierName;
279:         const effectiveTier: TierName = paidStatuses.includes(subscription.status) ? tier : 'free';
```
- **Description:** Subscription metadata is set once during Checkout creation and is not updated when plans are changed via the Stripe Customer Portal or dashboard, disconnecting actual payments from granted access tiers.
- **Reproduction Steps:** Change price ID from Ultra to Pro in Stripe dashboard: the database continues granting `users.tier = 'ultra'`.
- **Structural Remediation:** Derive tiers from `subscription.items.data[0].price.id` via reverse mapping against `src/lib/stripe/config.ts`, failing closed on unrecognized price IDs.

#### LUGX-069 — Mapping `paused` to `canceled` with Terminal Guard Freezes Resumed Subscriptions on Free Tier
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-07.
- **Location:** `src/app/api/stripe/webhook/route.ts:269`, `:300`.
- **Snippet:**
```ts
269:             paused: 'canceled',
300:             if (currentSub?.status === 'canceled' && status === 'active') {
```
- **Description:** Paused subscriptions in Stripe can be resumed, but LUGX maps `paused` to `canceled`. When resumed, incoming `active` events are discarded by the terminal guard as "stale events", forcing paying users to remain on the free tier.
- **Reproduction Steps:** Pause subscription collection in Stripe and subsequently resume it: the database retains `tier = 'free'`.
- **Structural Remediation:** Support `paused` as a distinct status in `subscription_status` enum, evaluate terminal states against `subscription.id` and `ended_at`, and implement chronological event sequencing (LUGX-027).

#### LUGX-070 — `toggleFileEncryption` Accepts `isEncrypted:true` Without Encryption Metadata
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-09.
- **Location:** `src/server/actions/file-ops.ts:286-395` (stored at `:367`, normalization at `:356`); compared to `src/app/api/files/[id]/route.ts:218-225`.
- **Snippet:**
```ts
365:                 content: normalizedContent,
366:                 isEncrypted,
367:                 encryptionMetadata: isEncrypted ? encryptionMetadata : null,
```
- **Description:** Server action lacks validation for `encryptionMetadata.iv` when `isEncrypted = true`, persisting ciphertext with NULL metadata, whereas the REST PUT endpoint rejects this payload. Markdown normalization is mistakenly applied to raw ciphertext. Test `multi-system-lifecycle.live.test.ts:271-286` codifies the defect.
- **Reproduction Steps:** Call `toggleFileEncryption(id, true, "<ciphertext>", null, {expectedVersion: v})`: returns success with `encryption_metadata = NULL`.
- **Structural Remediation:** Implement a unified validation helper for zero-knowledge storage invariants invoked across all write endpoints, and enforce a database constraint: `CHECK (NOT is_encrypted OR (encryption_metadata ? 'iv'))`.

#### LUGX-071 — `PUT /api/files/[id]` with `isEncrypted:false` and Omitted `content` Strips Metadata While Keeping Ciphertext
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-10.
- **Location:** `src/app/api/files/[id]/route.ts:157`, `:170`, `:212-229`, `:248-253`.
- **Snippet:**
```ts
212:         const effectiveIsEncrypted = isEncrypted !== undefined ? isEncrypted : currentFile.isEncrypted;
227:         const newContent = content !== undefined
228:             ? (effectiveIsEncrypted ? content : normalizeMarkdownSource(content))
229:             : currentFile.content;
```
- **Description:** Updating `isEncrypted: false` without supplying `content` converts the file to unencrypted status while leaving raw ciphertext in storage and deleting metadata, permanently breaking decryption and permitting ciphertext to be passed into AI streams. Title collisions trigger unhandled 500 errors, and `If-Match` checks are bypassed if `currentFile.etag` is empty.
- **Reproduction Steps:** Execute `curl -X PUT /api/files/<id> -d '{"isEncrypted":false,"expectedVersion":<v>}'`: returns 200 with `is_encrypted = false` and `encryption_metadata = null`.
- **Structural Remediation:** Apply Zod schema validation at route boundaries; treat encryption transitions as dedicated state operations requiring explicit fresh content, and delegate title modifications to `renameFile`.

#### LUGX-072 — `copyFile` Accepts Client-Controlled `depth` and Fails to Prevent Copying into Source Subfolders
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-11.
- **Location:** `src/server/actions/file-ops.ts:660-674`, `698-719`, `725-740`, `742-744`, `783-794`.
- **Snippet:**
```ts
660: export async function copyFile(
663:     depth = 0,
671:         const MAX_DEPTH = 20;
790:                         await copyFile(child.id, copiedFile.id, depth + 1);
```
- **Description:** `depth` is an untrusted parameter exposed in public action signatures. Passing a large negative integer bypasses depth checks. Copying folder A into its subfolder B generates recursive loops until execution timeouts, inflating database storage (DoS). Encrypted children are silently dropped without atomicity.
- **Reproduction Steps:** Create folder A containing child folder B, and invoke `copyFile(A.id, B.id, -100000)`.
- **Structural Remediation:** Decouple public action signatures from internal recursive functions, snapshot the source hierarchy using recursive CTEs rejecting targets within the subtree, and execute copies within an atomic transaction enforcing item limits.

#### LUGX-073 — Cycle Detection in `moveFile` Capped at 50 Hops and Non-Atomic
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-12.
- **Location:** `src/server/actions/file-ops.ts:858-887`, `890-900`.
- **Snippet:**
```ts
863:                 const MAX_HOPS = 50;
865:                 while (currentAncestorId && hops < MAX_HOPS) {
```
- **Description:** Nesting beyond 50 hops bypasses ancestor inspection, forming directory cycles that cause `buildFileTree` to drop cyclic nodes and hide file trees. Ancestor verification and updates execute outside transactions, enabling concurrent inverse moves to succeed simultaneously (TOCTOU). Test `file-ops.ownership.test.ts:74-110` tests a modified implementation lacking hop limits.
- **Reproduction Steps:** Build a chain of 52 folders and call `moveFile(F0, F51)`, or execute `Promise.all([moveFile(A, B), moveFile(B, A)])`.
- **Structural Remediation:** Inspect ancestors using `WITH RECURSIVE` within an atomic transaction acquiring `SELECT ... FOR UPDATE` locks, or enforce cycle rejection via database triggers.

#### LUGX-074 — File Deletion and Restoration Are Non-Atomic; Restoration Revives Independently Deleted Files
- **Final Severity:** Medium
- **Status:** Confirmed with correction in verification v3 and upgraded from LIKELY: `getDescendantIds` (41-69) filters by `deletedAt IS NULL`, whereas restore (603-627) does not. Correction: because child updates are batched into a single statement, partial failure leaves **all children deleted** rather than restoring a subset.
- **Original IDs:** BACKEND-13.
- **Location:** `src/server/actions/file-ops.ts:456-461`, `470-499`, `583-639`; unique index `idx_files_user_parent_title_live` in `0003_integrity_constraints.sql:32-34`.
- **Snippet:**
```ts
583:         await db.update(schema.files).set({ title: finalTitle, deletedAt: null, ...
630:                 await db.update(schema.files).set({ deletedAt: null, updatedAt: now })
```
- **Description:** Executed as discrete non-transactional statements over HTTP. Restoring a folder revives files that were independently deleted by the user prior to folder deletion, colliding with active file titles and causing folder restoration to succeed while all child files remain deleted. `deleteFile` resets timestamps on previously deleted rows.
- **Reproduction Steps:** Delete `a.md` inside folder F, create a new `a.md`, delete folder F, and restore F: collision occurs, F is active, and children remain deleted.
- **Structural Remediation:** Assign a `deleted_batch_id` on cascade delete, restoring only records sharing the specific batch identifier; execute operations inside atomic transactions resolving name collisions before writes.

#### LUGX-075 — Database Connection Layer: Cast Hides Lack of Transactions, TLS Certificate Verification Disabled, Silent Placeholders
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** BACKEND-14.
- **Location:** `src/lib/db/index.ts:7-9`, `19-22`, `29-32`, `37`; `src/lib/db/transactional.ts:11-13`, `41-44`; pattern repeated in `scripts/verify-migrations.mjs:44` (LUGX-076).
- **Snippet:**
```ts
9:     "postgresql://placeholder:placeholder@localhost:5432/placeholder";
21:         return drizzleNeonHttp(sql, { schema });
31:         ssl: isSsl ? { rejectUnauthorized: false } : undefined,
37: export const db = createDbInstance() as unknown as ReturnType<typeof drizzleNodePg<typeof schema>>;
```
- **Description:**
  - (a) neon-http does not support interactive transactions; casting hides this limitation from the compiler.
  - (b) `rejectUnauthorized: false` permits man-in-the-middle attacks on non-Neon PostgreSQL instances.
  - (c) Missing `DATABASE_URL` uses fallback placeholders, deferring failure to the first runtime query.
- **Reproduction Steps:** Run `next start` without `DATABASE_URL`: boot succeeds, and the first request fails with `ECONNREFUSED`.
- **Structural Remediation:** Type database instances truthfully (`drizzle-orm/neon-serverless` or separate `HttpDb`/`TxDb` types), enforce fail-fast environment validation at boot, and configure `ssl: { rejectUnauthorized: true, ca }`.
#### 4.3.6 Documentation Subsystem

#### LUGX-076 — Schema Drift from Migrations; Schema Sync Verification Incapable of Failure
- **Final Severity:** Medium. Downgraded from High in INFRA-02; unified as Medium across cluster in verification v3.
- **Status:** INFRA-02 confirmed with correction in v3: in drizzle-kit 0.31.10, `pgPush` executes DDL inside `try {} catch(e) { console.error(e) }` without returning a non-zero exit code. BACKEND-15 and INFRA-07 CONFIRMED by module agents.
- **Original IDs:** INFRA-02, BACKEND-15, INFRA-07.
- **Location:**
  - `.github/workflows/ci.yml:138-142`.
  - `src/lib/db/schema.ts:12-20`, `77-87`, `90-101`.
  - `src/lib/db/migrations/0001_add_sync_fields.sql:14-17`; `0004_stripe_constraints.sql:11-13, 46-48`; `0008_hybrid_vault_schema.sql:19`.
  - `scripts/verify-migrations.mjs:42-46`, `56-122`, `125-138`, `171-184`.
- **Snippet:**
```yaml
- name: Validate Drizzle Schema Sync
  run: npx drizzle-kit push --config drizzle.config.test.ts --force
```
```js
if (!indexNames.has(idx)) {
    console.warn(`[verify-migrations] WARNING: Expected index '${idx}' not found in pg_indexes.`);
```
- **Description:**
  - Critical indexes exist in SQL migrations but are omitted from `schema.ts`: `idx_files_etag`, `idx_files_version`, `idx_files_deleted_at`, `idx_files_updated_at`, `idx_files_user_encrypted`, and `idx_subscriptions_stripe_id_unique`. Running `db:push` prompts to drop them.
  - No baseline `0000` migration exists; migrations begin with `ALTER TABLE`.
  - `push --force` alters schema silently, swallows SQL errors, and exits with code 0.
  - `verify-migrations.mjs` emits non-fatal warnings on missing indexes, uses hardcoded hand-rolled schemas, lacks migration journaling, and disables TLS verification.
- **Reproduction Steps:** Add a column to `schema.ts` without creating a migration and run the CI step: the column is pushed and the step passes. Delete a unique index and run `verify-migrations.mjs`: it logs WARNING, prints SUCCESS, and exits with code 0.
- **Structural Remediation:** Make `schema.ts` the single source of truth, generate migrations via `drizzle-kit generate` with a `0000_baseline` initial migration, maintain official journal tables (`__drizzle_migrations`), implement read-only drift verification via `drizzle-kit check`, and enforce strict exit codes and TLS validation.

#### LUGX-077 — Test Route `/api/test/e2e-auth` Shipped to Production Under Environment Guard, Granting Arbitrary Tiers
- **Final Severity:** Medium. Downgraded from High in DOCS-03; unified as Medium across cluster in verification v3.
- **Status:** BACKEND-16 and INFRA-09 confirmed with correction in v3: existing users cannot be hijacked without their password (`signInWithPassword`). DOCS-03 downgraded with correction.
- **Rejected Sub-claim (Excised):** DOCS-03 claim that attackers can delete arbitrary accounts via `DELETE` was rejected: the DELETE handler (157-191) only terminates the caller's own session and clears their cookies.
- **Original IDs:** BACKEND-16, INFRA-09, DOCS-03. Linked to LUGX-179 regarding `NODE_ENV`.
- **Location:** `src/app/api/test/e2e-auth/route.ts:8-10`, `35-36`, `65-80` (tier from body in 71 and 77), `134-141` (`httpOnly/secure=false`); `playwright.config.ts:73`.
- **Snippet:**
```ts
8: function isTestEnvironment(): boolean {
9:     return process.env.NODE_ENV === "test" || process.env.PLAYWRIGHT === "1";
71:                 tier: body.tier || "free",
138:                 httpOnly: false,
```
- **Description:** The test route is compiled into the production bundle. Setting `PLAYWRIGHT=1` on preview or production deployments allows anyone to create pre-confirmed accounts with the Supabase Service Role key under any chosen subscription tier, issuing cookies with `httpOnly: false` and `secure: false`. `listUsers()` reads only the first pagination page.
- **Reproduction Steps:** Deploy with `PLAYWRIGHT=1`, and execute `curl -X POST /api/test/e2e-auth -d '{"email":"a@b.c","password":"x...","tier":"ultra"}'`: a verified Ultra account is immediately created.
- **Structural Remediation:** Physically exclude the route from production builds via Next.js `pageExtensions` or deploy as an external test harness service. Add a CI assertion failing if `/api/test/*` appears in `.next/server/app-paths-manifest.json`.

#### LUGX-078 — Tests Purporting to Cover Production Logic Test Re-implemented Copies
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent; clustered in verification v3 with LUGX-028 and LUGX-086.
- **Original IDs:** BACKEND-17.
- **Location:** `src/test/api/api-files-putguard.live.test.ts:59-66`; `src/test/server/file-ops.lostupdate.test.ts:59-66`; `src/test/server/file-ops.ownership.test.ts:72-80`, `169-172`, `228+`; `src/test/server/file-ops.softdelete.test.ts:22-24`.
- **Snippet:**
```ts
// api-files-putguard.live.test.ts — Test file header comment
"Faithful in-process reproduction of the PUT ... algorithm"
```
- **Description:** Test suites execute duplicate in-memory reimplementations of production algorithms rather than importing actual route handlers or actions, passing even if production code is deleted. None of these tests detected LUGX-071, LUGX-073, or LUGX-074.
- **Reproduction Steps:** Delete the optimistic locking clause `eq(schema.files.version, currentVersion)` from `route.ts:261` and run `npm run test:live`: all tests remain green.
- **Structural Remediation:** Refactor integration tests to import actual production handlers while mocking authentication boundaries (`vi.mock("@/lib/supabase/server")`), and introduce mutation testing (e.g. Stryker).

#### LUGX-079 — Rate Limiter Fails Open Across All Routes, Using Placeholder Redis Client on Missing Config While README Claims Fail-Closed
- **Final Severity:** Medium. Downgraded from High in DOCS-02; unified as Medium in verification v3.
- **Status:** DOCS-02 downgraded with correction in v3. Gemini keys are not drained on Redis outage because `getApiKeyForRequest` and `getKeyState` throw `RedisUnavailableError` prior to calling the AI provider, and PostgreSQL quotas remain active. The real impact is misleading documentation and database load. BACKEND-19 confirmed by module agent.
- **Original IDs:** DOCS-02, BACKEND-19. Linked to LUGX-087.
- **Location:** `src/lib/rate-limit.ts:7-13`, `84-124` (specifically 95, 115-124); `src/lib/redis.ts:16-21`; claims in `README.md:76, 139, 191, 536-537, 563-564, 608`; test `rate-limit.test.ts:70` ("should FAIL OPEN").
- **Snippet:**
```ts
95:             pipeline.zadd(key, { score: now, member: `${now}-${Math.random()}` });
117:             // On Redis error, allow the request (fail open)
118:             return {
119:                 success: true,
```
- **Description:**
  - Rate limiting logic unconditionally allows requests when Redis fails. The configuration option `onRateLimitError: 'deny'` does not exist in the codebase.
  - Missing `UPSTASH_*` configuration instantiates a client pointing to `placeholder-redis.upstash.io`, causing all requests to fail open silently.
  - `zadd` executes before rate calculation, trapping retry clients in locked states upon rate limit resets.
  - Documentation repeatedly asserts "Fail-Closed" behavior, directly contradicting the code.
- **Reproduction Steps:** Set `UPSTASH_REDIS_REST_URL` to an unreachable host and send 100 requests to `/api/ai/stream`: no HTTP 429 is ever returned.
- **Structural Remediation:** Enforce explicit failure policies per tier in `RATE_LIMITS` (`fail-closed` for AI and authentication, `fail-open` for sync), utilize atomic Lua scripts or `@upstash/ratelimit`, validate environment at boot, and synchronize documentation.

#### LUGX-080 — Quota Reservation TTL in README Is 60s While Reality Is 5 Minutes, with Duplicate Constants
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** DOCS-05.
- **Location:** `src/server/actions/ai-ops.ts:378`; `src/config/features.config.ts:20`; claims in `README.md:70, 407, 442`.
- **Snippet:**
```ts
const ttlMs = options.ttlMs || 5 * 60 * 1000; // 5 minutes default TTL
```
- **Description:** `FEATURES.RESERVATION_TTL_MS` is defined but unimported by `ai-ops.ts`, rendering configuration updates ineffective. Documentation specifies 60 seconds, whereas code enforces 5 minutes (`sync-api.md:268` specifies 5 minutes).
- **Reproduction Steps:** Execute `rg -n RESERVATION_TTL_MS src`: the constant has zero references outside its configuration file.
- **Structural Remediation:** Import `FEATURES.RESERVATION_TTL_MS` directly in `ai-ops.ts`, and auto-generate documentation values from the configuration source.

#### LUGX-081 — Section 5.2 in Security Architecture Describes Non-Existent Sweeper
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** DOCS-06.
- **Location:** `docs/architecture/security/security-and-rate-limiting.md:211, 217-229`; `src/app/api/cron/expire-reservations/route.ts:36-42, 52`; `ai-ops.ts:675`; `.github/workflows/cron.yml`.
- **Snippet:**
```ts
return NextResponse.json({ success: true, expiredCount, timestamp: new Date().toISOString() });
```
- **Description:** Documentation diverges from code in four respects:
  1. Cites `STALE_THRESHOLD_MS`, which does not exist.
  2. Cites `ai_usage_history` table, which does not exist.
  3. Cites response schema `{success, count, message}`, whereas actual schema is `{success, expiredCount, timestamp}`.
  4. Asserts "failures never break the CI pipeline", whereas `cron.yml` executes `exit 1`.
- **Reproduction Steps:** Run `rg -n "STALE_THRESHOLD_MS|ai_usage_history" src`: returns zero results.
- **Structural Remediation:** Export response contracts as shared TypeScript interfaces validated in integration tests, and link documentation to live contract definitions.

#### LUGX-082 — Sweeper Cron Schedule Documented Incorrectly
- **Final Severity:** Medium; impacts calibration of LUGX-006 and LUGX-002 (Cluster D11 in v2).
- **Status:** CONFIRMED by module agent.
- **Original IDs:** DOCS-07.
- **Location:** `README.md:442, 634, 638, 648-649`; `.github/workflows/cron.yml:20-22`; `ai-ops.ts:677` (`limit: 100`).
- **Snippet:**
```yaml
schedule:
  # Daily at 03:00 UTC
  - cron: "0 3 * * *"
```
- **Description:** The sweeper runs once daily with a 100-row limit, meaning stale reservations may linger up to 24 hours. Documentation claims it runs continuously or every 10 minutes via `vercel.json` (which does not exist in the repository).
- **Reproduction Steps:** Verify that `vercel.json` is missing from the repository root, and inspect `.github/workflows/cron.yml`.
- **Structural Remediation:** Implement lazy reservation expiry evaluated during new reservation requests, or schedule cron execution every 10 minutes with a loop draining all stale rows; correct documentation.

#### LUGX-083 — `sync-doc-metrics` Script Rewrites Historical Dated Records
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent via `git show 4fbb34a -- docs/TECHNICAL_DEBT_REGISTER.md`.
- **Original IDs:** DOCS-08.
- **Location:** `scripts/sync-doc-metrics.mjs:289-310`; policy in `docs/DOCUMENTATION_GUIDELINES.md:46, 176-181, 246` and `CORE_HARDENING_PRE_STAGE_2_PLAN.md:76-77`.
- **Snippet:**
```js
content = content.replace(
  /100% passing across \d+ test files and \d+ tests/g,
  `100% passing across ${metrics.unitSuites} test files and ${metrics.unitTests} tests`);
```
- **Description:** Historical verification entries stating "Verified as of [date]" have their test counts retroactively rewritten (e.g. TD-12 modified from 66/797 to 67/820), destroying forensic integrity and violating immutable record policies.
- **Reproduction Steps:** Add a dummy test, run the script, and inspect `git diff` against dated historical records.
- **Structural Remediation:** Restrict replacements to explicit HTML comment placeholders (`<!-- METRIC:unit_tests -->`) in living documents, excluding `docs/records/` and historical sections.

#### LUGX-084 — Misleading "Non-Extractable Keys" Claim in Documentation
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent. Linked to LUGX-016.
- **Original IDs:** DOCS-09.
- **Location:** `src/lib/workers/crypto.worker.ts:54-65`, `72-90`; claims in `README.md:74, 137, 481`; `CHANGELOG.md:602`; `security-and-rate-limiting.md:123, 128`; `HYBRID_ENCRYPTION_AND_VAULT_PLAN.md:14, 54, 87, 258, 272, 417`.
- **Snippet:**
```ts
const derivedBits = await crypto.subtle.deriveBits({ name: 'PBKDF2', ... }, keyMaterial, keyLengthBits);
return new Uint8Array(derivedBits);
```
- **Description:** The master key resides in JavaScript memory as raw byte arrays and is transferred between threads. The `extractable: false` attribute is applied only to ephemeral operation keys. This contradicts marketing claims of hardware-like non-extractable keys.
- **Reproduction Steps:** Trace `deriveBits` to `sessionKeyStore.masterKeyRaw`: holds raw `Uint8Array`.
- **Structural Remediation:** Use `deriveKey` with `extractable: false`, retain `CryptoKey` handles inside the worker, communicate via handle IDs, and reconcile documentation.

#### LUGX-085 — AI Stream Encrypted File Barrier Bypassed Because `fileId` Is Optional
- **Final Severity:** Medium. Verification v2 rated Low/Medium depending on threat model; resolved to Medium based on higher DOCS-10 rating.
- **Status:** DOCS-10 CONFIRMED; VAULT-20 LIKELY.
- **Original IDs:** DOCS-10, VAULT-20, AI-15 point 5.
- **Location:** `src/app/api/ai/stream/route.ts:83-109` (check at line 106); `src/server/actions/ai-commit.ts:91`; claims in `HYBRID_ENCRYPTION_AND_VAULT_PLAN.md:18, 371, 392, 418` and `docs/reference/ui-streaming-readiness.md:27` (G11).
- **Snippet:**
```ts
// File ownership verification if fileId is supplied
if (fileId !== undefined && fileId !== null) { ... if (targetFile.isEncrypted) { ... 403 } }
```
- **Description:** Omitting `fileId` allows decrypted vault text to be transmitted to Gemini. Reservations with `fileId = null` can subsequently be committed onto encrypted files, bypassing what documentation describes as a "Server-side route barrier".
- **Reproduction Steps:** Send `POST /api/ai/stream` with a body containing only `text` and `operation`: returns HTTP 200.
- **Structural Remediation:** Require `fileId` for document operations or mandate an explicit `source: "scratch"` parameter, and clarify in documentation that the barrier is advisory.

#### LUGX-086 — CI Gating Test Re-implements Logic Instead of Testing Actual `ci.yml`, and Is Not Run in CI
- **Final Severity:** Medium
- **Status:** CONFIRMED via mutation testing by docs and infra agents.
- **Original IDs:** DOCS-12, INFRA-06.
- **Location:** `scripts/test-ci-gating.mjs:24-45` (`simulateStage6Gating`), line 118, `187-197`; `.github/workflows/ci.yml:288-300`; `package.json:15`; claims in phase-03 closure line 27 and `ci-pipeline.md:5, 153`.
- **Snippet:**
```js
assertCheck("Stage 6 enforces exit 1 on missing secrets in protected context", ciContent.includes('exit 1'));
function simulateStage6Gating({ eventName, ref, runLiveSmoke, secrets }) {
```
- **Description:** The 30 assertions in `test-ci-gating.mjs` test JavaScript mocks, while static checks rely on simple substring searches, succeeding even if bash logic is inverted. `npm run test:ci-gate` is never executed in CI workflows.
- **Reproduction Steps:** Invert bash logic in `ci.yml` (e.g. replace `exit 1` with `exit 0`): `test-ci-gating.mjs` continues to report 100% verification success.
- **Structural Remediation:** Extract CI gating into a standalone script (`scripts/ci/e2e-gate.sh`) executed by `ci.yml` and verified via matrix execution asserting actual exit codes; add gating test to Stage 1.

#### LUGX-087 — `authRateLimiter` Defined but Unused; No IP-Based Rate Limiting
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** DOCS-13.
- **Location:** `src/lib/rate-limit.ts:54-57`, `172`; claims in `security-and-rate-limiting.md:56, 67, 236`.
- **Snippet:**
```ts
AUTH: { limit: 20, windowSeconds: 15 * 60 },
export const authRateLimiter = new RateLimiter('auth', RATE_LIMITS.AUTH);
```
- **Description:** No rate limiting is applied to authentication or PIN verification endpoints, and no client IP extraction logic exists, contradicting claims of "IP fallback" and "dual IP/User" limiting.
- **Reproduction Steps:** Execute `rg -n authRateLimiter src`: returns only its declaration.
- **Structural Remediation:** Enforce the rate limiter across authentication and verification endpoints, or excise the definition and corresponding documentation claims.

#### LUGX-088 — Metrics Verification `--check` Is Self-Referential and Does Not Verify Test Execution
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agents; clustered with DOCS-08 in v3.
- **Original IDs:** DOCS-14, INFRA-17.
- **Location:** `scripts/sync-doc-metrics.mjs:80-104`, `131-275`; invoked in `ci.yml:65`.
- **Snippet:**
```js
const currentMetrics = fs.existsSync(METRICS_PATH) ? readMetrics() : {
  liveTests: 89,
  e2eTests: 15,
};
```
- **Description:** Running with `--check` executes no test runners, comparing values against static `METRICS.json` data. "820/820 Passing" badges remain green even if test runs fail.
- **Reproduction Steps:** Run `node scripts/sync-doc-metrics.mjs --check`: passes without executing tests.
- **Structural Remediation:** Generate metrics exclusively from genuine test runner JSON output artifacts in CI, or replace static badges with dynamic CI status badges.

#### LUGX-089 — Evicting Quarantined Conflicts at 100 Entries (FIFO) Deletes Unresolved Conflicts
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent. Linked to LUGX-101.
- **Original IDs:** DOCS-15.
- **Location:** `src/lib/sync/sync-manager.ts:128`, `407-423`; claims in `PRODUCTION_HARDENING_AND_REMEDIATION_PLAN_M6.md:431` vs `:489`.
- **Snippet:**
```ts
export const MAX_QUARANTINED_CONFLICTS = 100;
if (isNewConflict && this.pendingEncryptedConflicts.size >= MAX_QUARANTINED_CONFLICTS) {
    ...
    this.pendingEncryptedConflicts.delete(oldestKey);
```
- **Description:** Upon encountering the 101st conflict, the oldest quarantined conflict is silently evicted along with the user's unresolved edits, violating the policy of requiring explicit user resolution before conflict deletion.
- **Reproduction Steps:** Induce 101 encrypted conflicts via `quarantineEncryptedConflict`: the oldest conflict is discarded with a console warning.
- **Structural Remediation:** Apply backpressure to halt synchronization for the file while alerting the user, or maintain a persistent conflict store bounded by byte limits.

#### LUGX-090 — Deferred Row Level Security (RLS) Technical Debt Unrecorded in Register
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent as a documentation governance gap.
- **Original IDs:** DOCS-16.
- **Location:** `docs/records/archive/technical-fix-documentation-security-hardening.md:200`; `docs/TECHNICAL_DEBT_REGISTER.md`; `docs/foundation/System Architecture Design.md:103`.
- **Snippet:**
```text
"Enable Supabase RLS… deferred"
```
- **Description:** Multi-tenant data isolation relies solely on application-level `userId` predicates without defense-in-depth database enforcement, and this deferred architecture is omitted from `TECHNICAL_DEBT_REGISTER.md`.
- **Reproduction Steps:** Execute `rg RLS docs/TECHNICAL_DEBT_REGISTER.md`: returns zero matches.
- **Structural Remediation:** Register a technical debt item assigning ownership and timeline, and enable PostgreSQL RLS with `auth.uid()` policies.

#### 4.3.7 Infrastructure and CI Subsystem

#### LUGX-091 — `singleFork` Option Is a No-op in Vitest 4; Live Tests Run in Parallel Against Shared DB
- **Final Severity:** Medium, downgraded from High.
- **Status:** Confirmed with correction in verification v3 and reproduced with Vitest 4.1.11: with `singleFork: true` and `--maxWorkers=4`, four test files started simultaneously (1.88s), whereas with `fileParallelism: false` they serialized (6.65s). Impact is test flakiness and CI reliability, with no production impact.
- **Original IDs:** INFRA-01.
- **Location:** `vitest.config.mts:18-21`; `vitest.live.config.mts:20-22`.
- **Snippet:**
```ts
pool: 'forks',
// @ts-expect-error -- singleFork serializes test files to protect the
// shared local Postgres database from cross-file setup/cleanup races.
singleFork: true,
```
- **Description:** `singleFork` is obsolete in Vitest 4. The `@ts-expect-error` comment suppressed the type error, allowing test suites to execute concurrently against a shared database, defeating the intended serialization.
- **Reproduction Steps:** Execute four test files with current configuration: all four start concurrently.
- **Structural Remediation:** Configure `fileParallelism: false` or `maxWorkers: 1` and remove `@ts-expect-error`. Preferably, isolate test suites into dedicated database schemas (`lugx_test_${VITEST_POOL_ID}`).

#### LUGX-092 — Test Database Targeting Falls Back to `DATABASE_URL`; Guards Are Fragmented
- **Final Severity:** Medium, downgraded from High.
- **Status:** Downgraded in verification v3: Stage 4 in CI executes `test:live` via `src/test/test-db-guard.ts` requiring `DATABASE_URL === TEST_DATABASE_URL`, mitigating real-world host drop claims.
- **Original IDs:** INFRA-03. Intersects with LUGX-146 and LUGX-162.
- **Location:** `drizzle.config.test.ts:8-19`; `scripts/verify-migrations.mjs:21-34`; `playwright.config.ts:18-30`; `e2e/fixtures/test-db.ts:19-22`.
- **Snippet:**
```ts
// drizzle.config.test.ts:19
url: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
// test-db.ts:20
if (testDbUrl.includes("ep-lucky-star")) {
```
- **Description:** `drizzle.config.test.ts` lacks host validation and applies destructive DDL with `--force`. `verify-migrations.mjs` loads production `.env.local` without guards. Four disparate guards use inconsistent case-sensitive matching rules.
- **Reproduction Steps:** Run `DATABASE_URL=postgresql://prod:secret@ep-lucky-star-... node sim.mjs`: evaluates to production host.
- **Structural Remediation:** Create a unified guard module imported by all four entry points requiring `TEST_DATABASE_URL`, enforcing allowlists (`TEST_DB_ALLOWED_HOSTS`), normalizing hostnames, and masking production host identifiers into secrets.

#### LUGX-093 — Redis Service in Stage 4 Is Incompatible with Upstash REST; Locking and Deduplication Untested
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent (protocol incompatibility).
- **Original IDs:** INFRA-05.
- **Location:** `.github/workflows/ci.yml:168-175`, `202-203`; `src/lib/redis.ts:1-23`; `src/app/api/stripe/webhook/route.ts:572-597`.
- **Snippet:**
```yaml
redis:
  image: redis:7-alpine
...
UPSTASH_REDIS_REST_URL: http://localhost:6379
```
- **Description:** `@upstash/redis` communicates via HTTP REST, while `redis:7-alpine` expects RESP over TCP, terminating HTTP connections. Webhook handlers fail open, leaving distributed locking and event deduplication completely untested in CI.
- **Reproduction Steps:** Run `redis:7-alpine` on 6379 and call `new Redis({url:'http://localhost:6379',token:'x'}).get('a')`: throws fetch error.
- **Structural Remediation:** Deploy a REST-compatible proxy (`hiett/serverless-redis-http`) in front of Redis in CI, add live tests asserting lock creation (`stripe:lock:<id>`), and test fail-open behavior in dedicated test suites.

#### LUGX-094 — E2E Web Server Inherits Production Secrets from `.env.local`; Supabase Auth Test Users Unpurged
- **Final Severity:** Medium
- **Status:** Confirmed in verification v3: Stage 6 in CI passes real Supabase credentials, accumulating orphaned test users in production projects.
- **Original IDs:** INFRA-08.
- **Location:** `playwright.config.ts:6-9`, `66-74`; `e2e/fixtures/test-db.ts:9-12`, `61-72`; `e2e/fixtures/auth-fixture.ts:20-62`, `65-96`.
- **Snippet:**
```ts
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
env: { ...process.env, DATABASE_URL: testDbUrl, },
```
- **Description:** Only `DATABASE_URL` is redirected; production Supabase and Stripe keys are inherited from `.env.local`. Test runs create users with hardcoded passwords (`E2E_Secure_Pass_2026!`). `cleanupE2EUser` deletes Neon database rows only, leaving orphaned users in Supabase Auth.
- **Reproduction Steps:** Execute Playwright tests with a production `.env.local`: test users accumulate in Supabase dashboard.
- **Structural Remediation:** Hermetically isolate E2E test runs, require test project URLs, call `admin.auth.admin.deleteUser` during teardown, and randomize test passwords.

#### LUGX-095 — Complete Absence of Security Headers (CSP, HSTS, X-Frame-Options)
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** INFRA-10.
- **Location:** `next.config.ts:1-15` (no `headers()`); `src/proxy.ts` (contains no security header directives).
- **Snippet:**
```ts
const nextConfig: NextConfig = {
  images: { remotePatterns: [ { protocol: "https", hostname: "lh3.googleusercontent.com", pathname: "/**" } ] },
};
```
- **Description:** The application handles zero-knowledge vault keys in browser memory, renders markdown, and contains billing pages, yet sets no Content Security Policy (CSP), `frame-ancestors`, HSTS, `X-Content-Type-Options`, or `Referrer-Policy`, and exposes `X-Powered-By`. XSS can exfiltrate keys, and pages are vulnerable to clickjacking.
- **Reproduction Steps:** Execute `curl -I https://<deploy>/workspace`: security headers are entirely absent.
- **Structural Remediation:** Configure centralized security headers in `next.config.ts` or edge proxy, enforcing nonce-based CSP (`script-src 'nonce-...' 'strict-dynamic'`, `frame-ancestors 'none'`, restricted `connect-src`), and `poweredByHeader: false`.

#### LUGX-096 — `cron.yml`: Purge Failure Blocks Expire-Reservations; No Backlog Drain; Comments Contradict Behavior
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** INFRA-11.
- **Location:** `.github/workflows/cron.yml:13-15`, `44-57`, `59-63`, `65`.
- **Snippet:**
```yaml
# The workflow never fails the whole pipeline on cron issues: ...
if [ "$HTTP_CODE" != "200" ]; then
  exit 1
fi
- name: Run expire reservations cron endpoint (TD-02)
```
- **Description:** Both tasks run in a single job without `if: always()`; a failure in purge prevents reservation expiry from executing. The inline comment contradicts the explicit `exit 1` check. Daily 500-row purge limits fail to drain backlogs, and `curl -f` suppresses error response bodies.
- **Reproduction Steps:** Configure mock server to return 500 on purge: reservation expiry step never executes.
- **Structural Remediation:** Separate tasks into independent jobs or specify `if: always()`, add drain loops for backlogs, use `--fail-with-body`, and reconcile comments.

#### LUGX-097 — Supply Chain Vulnerabilities and Unscoped Token Permissions in CI
- **Final Severity:** Medium
- **Status:** CONFIRMED by module agent.
- **Original IDs:** INFRA-12.
- **Location:** `ci.yml`: no top-level `permissions:`; mutable action tags (`actions/checkout@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`); lines 277-286, 457-466; `cron.yml:36, 68`.
- **Snippet:**
```yaml
SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY || vars.SUPABASE_SERVICE_ROLE_KEY }}
STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY || vars.STRIPE_SECRET_KEY }}
```
- **Description:** `GITHUB_TOKEN` runs with default write permissions. Third-party actions are pinned to mutable tags instead of immutable commit SHAs. Fallback expressions suggest reading service role keys from unmasked variables. Artifact uploads retain authenticated session screenshots for 7 days.
- **Reproduction Steps:** Inspect `ci.yml` and `cron.yml`: top-level `permissions` block is absent.
- **Structural Remediation:** Enforce `permissions: contents: read` globally with granular job escalations, pin actions to full commit SHAs via Dependabot, source credentials exclusively from `secrets.*`, and utilize GitHub Environments.
### 4.4 Low Findings (Low)

The status for each Low finding reflects the verdict of the responsible module agent, falling outside the secondary independent verification pass unless explicitly noted otherwise.

#### 4.4.1 Sync Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-098 | SYNC-18 | Downgraded from Medium in v1 | `src/lib/sync/concurrency-manager.ts:17-40, 71-76` | Releases lock by identifier instead of ownership token; does not synchronize across tabs. `releaseAll`/`acquireLock` lack production callers, `while` loop re-checks condition, and `expectedVersion`/`If-Match` guards protect across tabs. | Use `navigator.locks.request(fileId)` with unique lease tokens per lock. |
| LUGX-099 | SYNC-23 | Downgraded from Medium in v1 | `src/lib/sync/operations-gc.ts:143-161`; `indexeddb.ts:950-1010` | Race between read and `replaceOperations`, alongside premature deletion of `dead_letter` operations. Impact is minimal as network push transmits `file.content`. | Perform read and delete within a single `readwrite` transaction; retain `dead_letter` until user interaction. |
| LUGX-100 | SYNC-25 | CONFIRMED | `sync-manager.ts:1410-1440` | `has_more: true` paired with `next_cursor: null` triggers an infinite request loop. | Enforce pagination contract validation via schema (`has_more` requires valid cursor) and apply hard page limits. |
| LUGX-101 | SYNC-26 | CONFIRMED | `sync-manager.ts:1081, 1301` vs `405-427` | Actual sync code paths mutate `pendingEncryptedConflicts.set` directly, bypassing `MAX_QUARANTINED_CONFLICTS` boundary checks (see LUGX-089). | Encapsulate map in private state mutable exclusively via a validated method. |
| LUGX-102 | SYNC-27 | CONFIRMED | `sync-manager.ts:569, 607-614, 667` | Hardcoded metadata (`master-v1`, `salt: ''`), `serverVersion: 0`, and unversioned `markFileClean` in `else` branch. v1 noted narrower impact as version is updated from `resData.version` at lines 651-657. | Remediate in accordance with LUGX-011 and LUGX-044. |
| LUGX-103 | SYNC-28 | CONFIRMED | `indexeddb.ts:184-198` | `decryptText` returns unencrypted strings verbatim (downgrade path); anyone writing to IDB can inject unauthenticated plaintext content. | Introduce `schemaVersion` tag and reject unencrypted records post-migration. |
| LUGX-104 | SYNC-29 | CONFIRMED | `indexeddb.ts:1236-1241`; `deleteFile` | `deleteDatabase` treats blocked deletion as success; `deleteFile` preserves queued operations, feeding LUGX-039. | Broadcast `logout` event across tabs or return an explicit error; delete file and associated operations in a single transaction. |
| LUGX-105 | SYNC-30 | LIKELY | `indexeddb.ts:1146-1153` | Invoking `saveDeviceTrustEnvelope` with a different user identifier re-initializes the singleton instance for another user. | Instantiate dedicated per-user manager instances and reject mismatched identifiers. |
| LUGX-106 | SYNC-31, VAULT-18 | CONFIRMED | `crypto-worker-bridge.ts:164-170, 196-214, 353-355`; `crypto.worker.ts:326-334` | Any worker rejection (including GCM authentication tag mismatch or invalid PIN) is retried on the main thread, executing PBKDF2 twice, freezing the UI, and exposing key material to the main thread. Timeouts tear down the worker for the entire session, `generateRandomBytes` bypasses worker, and stack traces are leaked to caller. Contradicts "Worker Offloading" claim (DOC-07). | Disentangle transport failures from cryptographic authentication errors, add circuit breaker with worker recreation, and suppress stack traces. |
| LUGX-107 | SYNC-33 | CONFIRMED | `encryption.ts:405-407, 445, 484, 518-522` | `EncryptionManager` uses hardcoded default AAD `'default'` and wipes a shared salt array. | Make AAD a mandatory typed parameter, and wipe only locally instantiated buffers. |
| LUGX-108 | SYNC-34 | CONFIRMED empirically (`ls.ts`) | `log-sanitizer.ts:26-65`; `sync-manager.ts:879, 1208` | Sanitizer regex patterns omit several secret token formats, and `console.log` directly outputs raw objects and user IDs. | Implement structured logging with strict field allowlisting. |
| LUGX-109 | SYNC-35 | CONFIRMED | `cross-tab-sync.ts:21, 42-44` | Broadcast channel name `textai_cross_tab_sync` is hardcoded across all users, causing cross-account event pollution on shared browser origins. | Derive channel name from `userId` and validate sender ID on every message. |
| LUGX-110 | SYNC-36 | LIKELY | `pdf.worker.ts:287-347`; `pdf-worker-bridge.ts:15, 83` | The `'postMessage' in self` predicate evaluates to true in `window`. Importing `extractPdfTextDirect` overrides `window.onmessage`; messages from iframe origins trigger arbitrary PDF parsing (DoS). | Assert `self instanceof DedicatedWorkerGlobalScope` and import pure side-effect-free engine modules. |
| LUGX-111 | SYNC-37 | CONFIRMED | `sync-indicator.tsx:72-76` | The `'conflict'` state in the UI sync indicator is unreachable, preventing users from seeing trapped conflict files. | Derive indicator status directly from unresolved operation counts in IndexedDB. |
| LUGX-112 | SYNC-38 | CONFIRMED | `conflict-dialog.tsx:94-98, 158-166` | Defaults to `'merge'` when automated diff3 succeeds, swallows `onResolve` errors, and the Cancel button retains nothing (LUGX-003). | Mandate explicit user choice without destructive defaults, surface errors, and bind cancel to state machine semantics. |
| LUGX-113 | SYNC-39 | CONFIRMED | `etag-generator.ts:105` | ETag calculation incorporates `updatedAt`, generating spurious conflict mismatches. Test `sync-etag-generator.test.ts:132-149` codifies this flaw. | Derive ETags strictly from content and semantic metadata, or rely on server-issued version identifiers. |
| LUGX-114 | SYNC-40 | CONFIRMED | `connection-detector.ts:127-131` | `navigator.onLine` returns true on local area networks without WAN access, causing continuous failed sync retries. | Implement active reachability health-check probes with exponential backoff. |

#### 4.4.2 AI Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-115 | AI-05 | Downgraded from High in v2 | `src/server/actions/ai-ops.ts:1, 29, 151, 271, 566, 670, 741-774` | Server action exports accept untrusted `userId` and `tier` arguments (`refundUsage`, `reserveAndUpdateUsage`, `expireStaleReservations`). Functions are unimported by client components and tree-shaken by Next.js 16, rendering the speculative attack unreachable. Accessible `commitAIReservation` only deducts quota from the reservation owner using a UUID identifier. | Separate `ai-ops.server.ts` (`server-only`) from thin client actions resolving `getUser()`; protect sweeper via secret-guarded cron route. |
| LUGX-116 | AI-08 | Rated Medium by agent; downgraded to Low per v2 note (dead code) | `ai-ops.ts:780-831` (raw error at 828) | `processText` executes AI generation without length caps, rate limiting, operation validation, or abort signals. It is unimported in `src` outside tests, presenting no accessible HTTP route. Components merged into LUGX-002 and LUGX-007. | Delete the dead function or route through unified `enforceAIRequestPolicy` gateway. |
| LUGX-117 | AI-12 | Downgraded from Medium in v2 | `src/lib/ai/client.ts:477-480, 517`; `key-rotation.ts:763-778, 819` | Circuit breaker ignores mid-stream disconnections because success is logged upon stream initialization. Path is gated by `NEXT_PUBLIC_AI_STREAMING_ENABLED` defaulting to `false`, and non-streaming `processWithAI` is intact. | Record success upon full stream completion; implement sliding error-rate window. |
| LUGX-118 | AI-15 | CONFIRMED | `src/server/actions/ai-commit.ts:55-390` (lines 91, 154, 164, 329, 377, 387) | `commitAIFileOperation` does not validate `expiresAt`, permits unbounded `resultContent`, leaks `error.message`, asserts `expectedVersion` instead of `baseVersion`, and passes `user.id` into `reason`. `fileId = null` merged into LUGX-085. | Require `fileId`, enforce TTL checks, align version assertions, cap payload sizes, and return sanitized errors. |
| LUGX-119 | AI-16 | CONFIRMED | `route.ts:68, 354-359, 362-384`; `use-ai-stream.ts:462-466` | Malformed JSON returns HTTP 500 instead of 400; `refundUsage` branch is unreachable; missing `Retry-After` on `AllKeysExhausted`/`RedisUnavailable`; unvalidated `operationId`; `AbortError` fails to settle reservation. | Pre-validate request body via Zod and map typed domain errors to standard HTTP status codes. |
| LUGX-120 | AI-17 | CONFIRMED | `key-rotation.ts:491-492, 508-509, 794-797` | `set` followed by `expire` in Redis are non-atomic, risking keys stuck permanently in cooldown if execution halts between commands. | Use atomic `set(key, value, { ex })` single-command invocation. |
| LUGX-121 | AI-18 | CONFIRMED | `key-rotation.ts:465, 592-621` | Time-of-check to time-of-use (TOCTOU) race condition on daily key quota; error message hardcodes static limit `(20/20)`. | Execute atomic `INCR` prior to dispatch and `DECR` on non-quota failure. |
| LUGX-122 | AI-19 | LIKELY | `client.ts:275-281, 461-467` | System prompts are transmitted within the user role, increasing vulnerability to prompt injection attacks. | Use `getGenerativeModel({ systemInstruction })` with explicit content boundary delimiters. |
| LUGX-123 | AI-20 | CONFIRMED | `client.ts:108-130`; `ai-ops.ts:18-24` | Ignores `frequencyPenalty` and `presencePenalty` parameters; mixes local client `getDay()` with UTC `toISOString()`. | Forward penalty parameters to provider, and enforce UTC timestamps exclusively. |

#### 4.4.3 Vault Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-124 | VAULT-10 | CONFIRMED | `vault-unlock-modal.tsx:224-259` | Any thrown exception increments the PIN failure counter; counter is reset before verification; reading from React state allows double-submit races. | Distinguish `InvalidPinError` from system errors, manage attempts via locked service, and disable buttons during execution. |
| LUGX-125 | VAULT-11 | CONFIRMED | `vault-unlock-modal.tsx:169, 236`; `create-vault-modal.tsx:213` | `keyVersion` is hardcoded to 1 across both biometric PRF and PIN authentication paths. | Store dynamic `keyVersion` in envelope and include in authenticated AAD. |
| LUGX-126 | VAULT-12 | CONFIRMED | `vault-unlock-modal.tsx:330, 358-363, 436-439` | Vault remains unlocked in memory while UI modal presents an error; recovery seed path commits master key prior to password reset. | Implement an unlock state machine that commits key and broadcasts events atomically after all mandatory steps finish. |
| LUGX-127 | VAULT-13 | CONFIRMED | `vault-unlock-modal.tsx:415-433, 443-445`; `create-vault-modal.tsx:100-105, 160-161`; `recovery-phrase-modal.tsx:19-23` | `kekSeed` is not zeroed on failure; `seedBytes` is never zeroed; mnemonic persists in React state and clipboard; UI displays "Copied" even on rejection (DOC-06). | Use a `SensitiveScope` helper wiping buffers in `finally`, handle clipboard errors via `await/catch`, and wipe mnemonic post-challenge. |
| LUGX-128 | VAULT-14 | CONFIRMED | `vault-unlock-modal.tsx:176-179, 550`; `create-vault-modal.tsx:242`; `recovery-phrase-modal.tsx:27`; `trust-device-modal.tsx:176-179` | Backdrop click dismisses modal while `isLoading` is true; unmounted timers invoke `onUnlocked`. | Suppress backdrop dismissal during loading, bind async routines to `AbortController`, and clear timers on unmount. |
| LUGX-129 | VAULT-15 | CONFIRMED | `vault-security-card.tsx:180, 222, 223, 248` | UI states "4-digit PIN" while code enforces 6 digits; displays "(PIN)" badge for hardware WebAuthn; claims "No keys stored locally". | Derive strings dynamically from `trustType` and `PIN_LENGTH` constants. |
| LUGX-130 | VAULT-16 | CONFIRMED | `vault-unlock-modal.tsx:182, 341, 360`; `trust-device-modal.tsx:157, 182`; `vault-security-card.tsx:401-406` | Hardcoded email `user@lugx.local` used in WebAuthn registration; displays raw unformatted `err.message` in UI. | Pass authentic user identity via typed parameters, and map exceptions to friendly localized error strings. |
| LUGX-131 | VAULT-17 | CONFIRMED | `vault-actions.ts:97, 141`; `vault-unlock-modal.tsx:313, 418, 484, 502` | `kdfIterations` is a single unconstrained database column shared across two envelopes; lacks boundary checks. | Maintain distinct KDF parameters per envelope with strict min/max boundaries enforced on client and server. |
| LUGX-132 | VAULT-19 | CONFIRMED | `recovery-phrase-modal.tsx:1-88`; `components/vault/index.ts` | `RecoveryPhraseModal` is dead code; no user flow exists to view or rotate mnemonic phrases; docs reference non-existent button. | Delete dead component or establish an authenticated "Rotate Recovery Phrase" flow requiring re-authentication. |
| LUGX-133 | VAULT-21 | LIKELY | `create-vault-modal.tsx:146-147`; `vault-unlock-modal.tsx:306-307, 478-479`; `trust-device-modal.tsx:80`; vs `encryption.ts:75` | Missing NFKC Unicode normalization on passwords in UI components causes decomposed characters to derive different keys, breaking migrations (DOC-08). | Centralize key derivation in unified keyring module (LUGX-005) enforcing NFKC normalization and tracking `passwordNormalization` version. |

#### 4.4.4 Backend Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-134 | BACKEND-08 | Downgraded from Medium in v3 | `webhook/route.ts:142-148, 652-660` | `no_payment_required` and `unpaid` statuses fail to grant access, and unhandled events are marked processed, blocking future processing. Path is currently unreachable (`card` only, no trials or promos), but becomes active with async payments or trials. | Grant access upon `customer.subscription.created/updated` and maintain a dedicated audit log for unsupported events. |
| LUGX-135 | BACKEND-18 | CONFIRMED | `src/lib/stripe/index.ts:31-62`; `create-checkout/route.ts:69-78` | `getOrCreateStripeCustomer` queries by email ignoring stored customer ID, introducing duplicate customer creation races. | Prioritize stored `stripeCustomerId`, pass `idempotencyKey`, and enforce `WHERE stripe_customer_id IS NULL`. |
| LUGX-136 | BACKEND-20 | CONFIRMED | `cron/expire-reservations/route.ts:20-25`; `cron/purge-deleted/route.ts:24-29, 44-51` | Non-constant-time string comparison (`===`) on cron bearer secret; misleading comment regarding `LIMIT` (see LUGX-181). | Use `crypto.timingSafeEqual` and reconcile comments. |
| LUGX-137 | BACKEND-21 | CONFIRMED | `create-checkout/route.ts:29, 102-111` | Invalid JSON body returns HTTP 500 and leaks internal error `details`. | Implement safe JSON parsing returning HTTP 400, and redact internal details using `correlationId`. |
| LUGX-138 | BACKEND-23 | CONFIRMED | `src/lib/utils/file-naming.ts:9-37`; `file-ops.ts:577, 722-740` | Copied and restored file titles can exceed `varchar(500)` column limits; test fails to validate length constraints. | Implement title truncation ensuring `len(base) + len(suffix) + len(ext) <= 500`. |
| LUGX-139 | BACKEND-24 | CONFIRMED | `auth-actions.ts:71-104` | `syncUserToDatabase` overwrites `displayName` on every login, fails to sync email updates, and swallows unique email collisions. | Use `COALESCE` for display names, sync email changes, and handle unique constraint collisions explicitly. |
| LUGX-140 | BACKEND-25 | CONFIRMED | `src/proxy.ts:41-45` | Any URL containing `?code=` on any path is unconditionally rewritten to `/auth/callback`. | Restrict query parameter interception strictly to registered OAuth callback paths. |
| LUGX-141 | BACKEND-26 | CONFIRMED | `src/app/dashboard/page.tsx:75-85` | "Payment Successful" UI banner renders purely based on presence of `?session_id` query parameter. | Verify checkout status and ownership via `checkout.sessions.retrieve`. |
| LUGX-142 | BACKEND-27 | CONFIRMED | `src/hooks/use-toast.ts`; `upgrade-button.tsx` | `use-toast` outputs only to `console.log`; billing errors fail to render in UI. | Integrate a genuine toast notification library or render errors inline. |
| LUGX-143 | BACKEND-28 | LIKELY | `src/app/api/files/sync/route.ts:102-118` | Millisecond cursor precision causes items sharing timestamps to repeat across pagination pages; timestamp lacks timezone. | Use high-precision microsecond cursor or `sync_seq bigserial` alongside `timestamptz`. |
| LUGX-144 | BACKEND-29 | CONFIRMED | `src/app/page.tsx:201, 237, 258, 280, 301`; `models.config.json:3-19` | Landing page advertises "Advanced/Premium" models while configuration pins `gemini-3.7-flash` across all tiers; pricing tables duplicated manually. | Dynamically generate marketing pricing and feature matrices directly from configuration files. |
| LUGX-145 | BACKEND-30 | CONFIRMED | `src/test/api/stripe-webhook.test.ts:151-169, 204-211, 571-591` | Webhook tests mock all database layers and assert flawed behavior; lacks tests for mismatched subscription IDs or `paused` status. | Author fixtures from genuine Stripe events and execute integration tests against real test database instances. |
| LUGX-146 | BACKEND-31 | CONFIRMED | `src/test/db.setup.ts:71-75, 101-103`; `file-ops.softdelete.test.ts:63`; `api-files-putguard.live.test.ts:43`; `src/test/test-db.ts:98-105`; `drizzle.config.test.ts` | Silent test skips when database is unavailable; swallowed migration errors; cross-suite deletion via `or(...)`; fallback to `DATABASE_URL` (LUGX-092). | Fail CI on database disconnects, throw on migration failures, enforce scoped deletion, and apply `assertSafeTestDatabaseUrl`. |
| LUGX-147 | BACKEND-32 | CONFIRMED | `proxy.test.ts:133-141`; `rate-limit.test.ts:98`; `cron-expire-reservations.test.ts`; `cross-user-ownership.test.ts` | Weak assertions: `toBeDefined()` passes on `null`; test case names diverge from tested scenarios. | Replace with `not.toBeNull()`, assert exact return values, and expand edge cases. |
| LUGX-148 | BACKEND-33 | CONFIRMED | `subscription-actions.ts:38-41`; `webhook/route.ts:654-658` | `isSubscriptionEventProcessed` fails open on errors; return value of `recordSubscriptionEvent` ignored in default branch. | Re-throw Redis read errors to cause the webhook handler to return HTTP 503. |
| LUGX-149 | BACKEND-34 | CONFIRMED | `src/app/account/page.tsx`; `src/lib/stripe/index.ts:171-182` | No UI flow exists to cancel or manage subscriptions; `cancelStripeSubscription` is unused. | Implement Stripe Customer Portal sessions (`billingPortal.sessions.create`) following resolution of LUGX-027 and LUGX-068. |

#### 4.4.5 Editor and UI Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-150 | EDITOR-24 | Downgraded from Medium in v1 | `use-editor-orchestrator.ts:1197-1198, 1219-1224` | Changing `fileId` during active load can leave editor in `hydrating` state. In App Router, page unmounts on parameter changes, mitigating primary vector; secondary vector on `currentAdapter` change untested. | Bind load pipeline to `{fileId, promise, abort}` token. |
| LUGX-151 | EDITOR-25 | CONFIRMED empirically | `arabic-normalizer.ts:19-21, 34-79, 103-119, 124` | `despaceArabicWords` merges valid words (`"الغيربيت"`), NFKC normalization corrupts non-Arabic text and strips ZWJ/ZWNJ markers, and inverse function is uncalled and untested. | Restrict NFKC to presentation form blocks, merge using spatial coordinates, and delete uncalled inverse function. |
| LUGX-152 | EDITOR-26 | CONFIRMED | `text-parser.ts:18`; `file-validator.ts:135`; `sidebar.tsx:194` | Windows-1256 encoded files convert silently to replacement characters `U+FFFD`; `validateFileBuffer` is unused in production. | Use `TextDecoder('utf-8', { fatal: true })` with fallback to `windows-1256`, and incorporate `validateFileBuffer` into import pipeline. |
| LUGX-153 | EDITOR-27 | CONFIRMED | `search-replace.tsx:110, 129, 143-146, 201-219`; `page.tsx:162-163` | Window-level keydown listener intercepts Ctrl+Enter inside editor; Escape key terminates AI stream; unable to replace with empty string. | Scope shortcuts to panel element or CodeMirror `keymap`, and distinguish `null` from `""`. |
| LUGX-154 | EDITOR-28 | CONFIRMED (Revocation LIKELY) | `exporters/utils/validator.ts:46, 55-57`; `exporters/index.ts:60-69` | `slice` splits surrogate pairs; lacks handling for reserved Windows filenames; blob URL revoked immediately upon `click()`. | Use `Intl.Segmenter`, apply reserved name blocklists, and defer blob URL revocation. |
| LUGX-155 | EDITOR-29 | CONFIRMED (line 40) / LIKELY (delete) | `pdf-ocr-engine.ts:34-42, 105-110, 154-156` | OCR installation check returns `true` unconditionally; `deleteDatabase('tesseract')` targets wrong IndexedDB database name. | Maintain single source of truth for installation state and target actual database names. |
| LUGX-156 | EDITOR-30 | LIKELY / CONFIRMED | `markdown-extensions.ts:661-672`; `page.tsx:164-180, 183` | Potential double-toggle on Mod-Alt-D shortcut; `lockCodeBlocksLTR` setting holds stale closure value. | Assign single owner for shortcut and verify `e.defaultPrevented`. |
| LUGX-157 | EDITOR-31 | CONFIRMED | `use-editor-orchestrator.ts:1457-1464, 1604-1614`; `page.tsx:310`; `markdown-editor.tsx:153-157` | Title updates before server confirmation; navigation post-`deleteFile` uninspected; Retry button resets state without retrying; missing `onAdapterReady(null)` feeds LUGX-023; AI bar active during hydration. | Create unified command layer returning `Result` types and bind action enablement to hydration state. |
| LUGX-158 | EDITOR-32 | CONFIRMED | `sidebar.tsx:158-176, 282-292, 554-571, 852-859`; `file-tree-item.tsx:87-98`; `folder-picker-modal.tsx:34-54`; `pdf-corrupted-font-dialog.tsx:32`; `app/workspace/page.tsx:15-16, 31-37` | Inverted Arabic text string `"d left"`; batch import exits mid-flight without calling `loadFiles()`; dropped `text/plain` treated as fileId; hanging spinners; mixed localization strings. | Establish explicit batch import model, adopt `useSyncExternalStore`, and centralize localization strings. |

#### 4.4.6 Documentation Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-159 | DOCS-17, INFRA-18 | CONFIRMED empirically (`/tmp/mdl`) | `scripts/check-markdown-links.mjs:88, 121-123, 154-158, 198-204` | Link checker skips anchors, reference links, and HTML tags; code fence detection logic is flawed; file counts are inconsistent (75, 76, 78). | Replace with `remark-validate-links` or `lychee --offline` enforcing GitHub-compatible anchor slugs. |
| LUGX-160 | DOCS-18 | CONFIRMED | `CHANGELOG.md:98`; `three-way-conflict-resolution.md:255` vs `indexeddb.ts:389-401` | Cites `idb-keyval` dependency and database indexes that do not exist. | Generate index documentation directly from `IDB_CONFIG`. |
| LUGX-161 | DOCS-19 | CONFIRMED | `docs/README.md:6, 71, 175`; `CHANGELOG.md:136`; `DOCUMENTATION_GUIDELINES.md:4-6, 29, 52` | Cites untracked `.agents/rules/` and `docs-governance.md`; inconsistent references to `.Plans` vs `Plans`. | Commit governance files or remove untracked references. |
| LUGX-162 | DOCS-20 | CONFIRMED | `README.md:129, 223, 257, 283, 571, 656`; `security-and-rate-limiting.md:12` | Inaccurate build environment claims (Turbopack, pnpm/yarn, "100% test coverage"); leaks active Neon hostname `ep-dry-rain-b1kfmpgk-pooler`. | Replace with generic placeholders and derive toolchain documentation from `package.json`. |
| LUGX-163 | DOCS-21 | CONFIRMED | `docs/foundation/DESIGN_VS_REALITY.md:8, 25, 27` | Broken file references despite claim that "Every row verified". | Add automated link validation step verifying referenced paths. |
| LUGX-164 | DOCS-22 | CONFIRMED | `DOCUMENTATION_GUIDELINES.md:110` vs `schema.ts:64` | Documents cite "Neon BYTEA", while schema defines column as `text("content")`. | Correct documentation to reflect active text column type. |
| LUGX-165 | DOCS-23 | CONFIRMED | `CHANGELOG.md:145, 201, 753`; `M6:20, 462` | Inconsistent test counts across documents, version gaps, and outdated claim of "5 failed PIN attempts". | Freeze dated historical metrics and verify version bump sequences. |
| LUGX-166 | DOCS-24 | CONFIRMED | `docs/TECHNICAL_DEBT_REGISTER.md`; commit `9d3a873` | Untrusted "Last reviewed" date stamps; records marked "never rewritten" were modified. | Automate date stamping and protect historical `records/` via CI assertions. |
| LUGX-167 | DOCS-25 | CONFIRMED | `CORE_HARDENING_PRE_STAGE_2_PLAN.md:4` vs `:90, 111` | Header proclaims "Phases 2–11 Planned", while phases are marked completed. | Reconcile plan header status. |
| LUGX-168 | DOCS-26 | CONFIRMED (`/tmp/pdiff.mjs`) | `docs/foundation/Using AI/*.md` | Prompts are not verbatim as claimed (`SUMMARIZE`, `TO_PROMPT`, `TRANSLATE`). | Maintain a single source of truth for prompts generating documentation. |
| LUGX-169 | DOCS-27, INFRA-13 | Downgraded from Medium in v3 | `.gitignore:34-36`; `.env.test:1`; `TECHNICAL_EXECUTION_PLAN.md:266` | `.env.test` is tracked in git containing `DATABASE_URL=Put-your-test-DATABASE-URL-here`. No secret is currently exposed, but risk is latent. Documents contradict, using `DATABASE_URL` instead of `TEST_DATABASE_URL`. | Execute `git rm --cached`, commit `.env.test.example`, store secrets in `.env.test.local`, and run `gitleaks` in Stage 1. |
| LUGX-170 | DOCS-28 | CONFIRMED | `TECHNICAL_EXECUTION_PLAN.md:578`; `editor-sync-orchestration.md:261, 288, 355`; `test-database-isolation.md:6`; `specs/ai-key-rotation-and-resilience.md:188` | Markdown link text diverges from destination anchor; duplicated section identifier "6e". | Validate link text against targets and ensure section identifier uniqueness. |
| LUGX-171 | DOCS-29 | CONFIRMED | `queue-gc-rollback-architecture.md:190` vs `indexeddb.ts:964-965`, `sync-manager.ts:495`, `operations-gc.ts:178` | `discarded` and `failed` operations are never collected by GC, growing IndexedDB unbounded. | Include terminal statuses in `canDelete` evaluation with configurable retention windows. |
| LUGX-172 | DOCS-30 | CONFIRMED | `ai-models-config.md:68` vs `client.ts:23` | Documentation claims runtime JSON loading, while code uses static build-time imports. | Correct documentation or implement dynamic runtime configuration loading. |
| LUGX-173 | DOCS-31 | CONFIRMED | Phase-6 closure line 20 vs 21-25 | States "4 @tiptap/* packages", followed by listing 5 packages. | Correct count to 5 packages. |
| LUGX-174 | DOCS-32 | CONFIRMED | `docs/reference/sync-api.md:20-21, 78, 118, 133, 177, 193, 203, 205, 215, 258`; `rate-limit.ts:191-202`; `files/[id]/route.ts:175` | Inconsistent API contracts: Bearer vs Cookie authentication; `retryAfter` absolute timestamp; undocumented secondary 412 message; missing `correlationId` on 429. | Standardize property names (`resetAt`) and generate API references from OpenAPI/TypeScript schemas. |
| LUGX-175 | DOCS-33 | CONFIRMED | `docs/reference/ui-streaming-readiness.md:130` | Textual reference to renamed file uncaptured by link validator. | Convert textual references to markdown links and validate `.md` filenames. |
| LUGX-176 | DOCS-34 | CONFIRMED | `sync-manager.ts:162-165, 1155-1161, 1830` vs `offline-sync-blueprint.md:71-78` | Production singleton configured with `enableJitter = false`, base 1s, cap 30s, risking thundering herd on server recovery. | Enable jitter by default in production, disabling only in test environments. |
| LUGX-177 | DOCS-36 | CONFIRMED | `ui-streaming-requirements.md:15, 148`; `ui-streaming-readiness.md:23, 130`; `offline-sync-blueprint.md:17, 119-120` | "Five invariants" followed by six items; claims "SSE" while wire protocol is NDJSON; claims mock suites are "Production path integration tests"; `hasMore` vs `has_more`. | Reference live `.live` integration suites and align terminology. |

#### 4.4.7 Infrastructure and CI Subsystem

| ID | Original | Status | Location | Summary Description | Remediation |
|---|---|---|---|---|---|
| LUGX-178 | INFRA-14 | CONFIRMED | `ci.yml:312-315, 385, 404, 408`; `playwright.config.ts:40, 51` | Stage 6 summary hardcodes static metrics ("100% Passed"); `trace: 'on-first-retry'` with `retries: 0` produces zero trace files; `NEXT_PUBLIC_SUPABASE_ANON_KEY` missing from mandatory check. | Generate summaries from `--reporter=json`, set `retain-on-failure`, and centralize secret manifests. |
| LUGX-179 | INFRA-15 | CONFIRMED | `playwright.config.ts:62, 72`; `ci.yml:23-24, 248` | E2E runs against `next dev` rather than production builds; `NODE_ENV: test` set globally across workflow. | Build once and run E2E against `next start`; restrict `NODE_ENV=test` strictly to Vitest steps. |
| LUGX-180 | INFRA-16 | LIKELY | `ci.yml:19-21` | `cancel-in-progress: true` cancels release gate workflows executing on `main` and release tags. | Scope `cancel-in-progress` strictly to pull request events. |
| LUGX-181 | INFRA-19 | CONFIRMED | `.env.example:44, 47, 58, 81, 84, 104-105, 110`; `key-rotation.ts:157-168`; cron routes | Typos in `.env.example` (`https://https://`); accepts placeholder secrets (`AIza_x`, `CHANGE_ME_TO_A_LONG_RANDOM_SECRET`) as valid; uses `===` comparison. | Enforce boot-time environment schema generating `.env.example`, and use `timingSafeEqual`. |
| LUGX-182 | INFRA-20 | CONFIRMED | `package.json:13, 20, 83-86`; `vitest.config.mts:22-27`; `eslint.config.mjs` | `allowScripts` is unread by npm; test coverage measures only `src/lib/ai`; ESLint warnings do not fail CI. | Adopt `@lavamoat/allow-scripts`, expand `coverage.include` to `src/**` with thresholds, and enforce `--max-warnings 0`. |
| LUGX-183 | INFRA-21 | LIKELY (Legal) | `NOTICE:8-21`; `LICENSE` §4(d); `package.json` | NOTICE file imposes attribution constraints exceeding Apache 2.0; missing `license` field in `package.json`. | Rephrase NOTICE file to conform to standard Apache 2.0 terms, and add `"license": "Apache-2.0"`. |
---

## 5. Test & Documentation Gaps

Test gaps that were assigned formal numbered findings are detailed in Section 4: LUGX-028, LUGX-078, LUGX-086, LUGX-088, LUGX-145, LUGX-146, LUGX-147, LUGX-178, and LUGX-182. The following two tables detail the testing and documentation gaps compiled by unit audit reports as standalone tables outside the numbered finding inventory. Unit prefixes have been assigned to their identifiers to prevent namespace collisions.

### 5.1 Test Gaps

| Identifier | Target File & Location | Vulnerability / Deficiency | Exposed Finding |
|---|---|---|---|
| SYNC-TG-01 | `sync-manager.test.ts:58-79`, `598-634`, `636-671` | `fromException` is mocked to unconditionally return `NETWORK_ERROR` with `recoverable: true`, causing the exponential backoff and dead-letter queue tests to pass solely as an artifact of mocking. | LUGX-034 |
| SYNC-TG-02 | `sync-manager.test.ts:312-354`, `693-700` | Only the 'server' resolution strategy is tested; no tests verify that 'local' triggers an outbound push or validate 'merge' handling. `setConflictCallback` is tested only via a vacuous `not.toThrow()`. | LUGX-003, LUGX-037 |
| SYNC-TG-03 | `sync-manager.test.ts:429-433` | `expect(async () => ...).not.toThrow()` is a vacuous asynchronous assertion that cannot catch rejections. | — |
| SYNC-TG-04 | `sync-manager.test.ts:442-485` | The "atomically commit" test asserts commit without validating the updated version, enshrining the bug; no tests exercise consecutive push batches. | LUGX-011 |
| SYNC-TG-05 | `sync-manager.test.ts:46-48` | `withLock` is mocked as a direct passthrough, leaving concurrency between `saveLocal` and concurrent push/rollback unexercised. | LUGX-010, LUGX-013 |
| SYNC-TG-06 | `sync-rollback.test.ts:95-121`, `303-339` | Enshrines stale content restoration and rolls back the version from 2 to 1 in assertion expectations. | LUGX-013 |
| SYNC-TG-07 | `sync-indexeddb.test.ts` | Fails to inspect the raw IndexedDB record to verify "Zero Plaintext At-Rest", omits device key read failure cases, and omits merge operations in `conflict/failed` states. | LUGX-035, LUGX-040 |
| SYNC-TG-08 | `sync-concurrency-manager.test.ts` | "serialize" test only records task start order, while "parallel" test does not verify actual concurrent execution. | LUGX-098 |
| SYNC-TG-09 | `sync-encrypted-conflict.test.ts` | Injects quarantined states via private property mutation using envelopes with valid IVs, omitting invalid ciphertext / PUT body validation. | LUGX-014 |
| SYNC-TG-10 | `encrypted-conflict-decryption.integration.test.ts:67-79`, `485-488` | Completely mocks `createSyncManager`; header claims to test all three resolution strategies while only testing 'server'; quarantine test is vacuous; zero coverage for `conflict.fileId ≠ fileId`. | LUGX-009 |
| SYNC-TG-11 | `conflict-resolution.integration.test.ts:41-45`, `66-142` | Re-implements `executeOptimisticWrite` instead of exercising the real PUT endpoint; silently skips test execution when test database is absent. | — |
| SYNC-TG-12 | `sync-conflict-resolver.test.ts`, `sync-operations-gc.test.ts:228-255,297-311`, `sync-etag-generator.test.ts:132-149`, `use-sync.test.ts:158-172,347`, `sync-error-handler.test.ts`, `sync-crypto-gateway.test.ts` | Uses `toContain` without asserting against duplicated lines; enshrines deletion of `dead_letter` and `updatedAt` in etags; contains vacuous assertions; lacks re-throw testing and `fileId` mismatch/rollback assertions. | LUGX-045, LUGX-099, LUGX-113, LUGX-044 |
| AI-T1 | `ai-ops.integrity.test.ts` (11-17, 74-95, 182-263); `ai-ops.refund.test.ts` (12-16, 62-141) | Tests local mock replicas of the algorithm rather than production implementation code, guaranteeing specification drift. | LUGX-030 |
| AI-T2 | `ai-quota-idempotency.test.ts:29-33,52-60` | Overly permissive database mocking yields tautological assertions that cannot detect concurrency anomalies. | LUGX-002 |
| AI-T3 | `ai-server-atomic-commit.test.ts:269,323,352-386`; `ai-atomic-commit.integration.test.ts` | Simulates rollback via mocked rejection; `table === 'files'` comparison evaluates to false; expired reservation check is rejected prior to entering transaction boundary. | — |
| AI-T4 | `ai-key-rotation.test.ts:352-355` | Manually trips the circuit breaker open without exercising actual probe failure pathways. | — |
| AI-T5 | `ai-stream-abort-latency.test.ts:10-13` | Header claims verification of route commit and refund behavior, yet no test calls the actual route handler. | LUGX-006, LUGX-031 |
| AI-T6 | `ai-live-e2e.test.ts` | Lacks skip guard when API keys are unconfigured, mutates production Redis instances and live quota counters, and loads `.env.local` directly. | — |
| AI-T7 | `ai-transaction.test.ts:185-208` | "Server-First Invariant" test mocks hook with local `vi.fn`, failing to exercise real hook behavior. | — |
| AI-T8 | (Missing Entirely) | Completely missing test coverage for client hook refund pathways, cross-user refund/commit ownership authorization, and replay attack parameter mismatch handling. | LUGX-001, LUGX-002 |
| AI-T9 | `ai-client-abort-propagation.test.ts`, `ai-client.test.ts:340-367`, `ai-gatekeeper.test.ts` | Asserts signal forwarding only as an option; completely mocks `key-rotation`; gatekeeper test coverage exists only when `fileId` is supplied. | LUGX-008, LUGX-085 |
| VAULT-TG-01 | `vault-recovery.test.ts:8-9,34-64`; `vault-orchestration.test.ts:23-29,106-123`; `vault-crypto.test.ts:224-263` | Real UI cryptographic pathway is entirely unexercised; recovery tests invoke unreferenced utility functions using a dummy schema, directly causing LUGX-005 to go undetected. | LUGX-005 |
| VAULT-TG-02 | `vault-actions.unit.test.ts:11-13,44-46,116-132,231-240,252` | `getUser` has no default implementation, passing tests for erroneous reasons; tests assert "atomically" while production code performs a non-atomic read-then-write. | LUGX-024 |
| VAULT-TG-03 | `vault-crypto.test.ts:632`; `vault-orchestration.test.ts:623-634,638-695,774-824,989-1021,1116-1136`; `vault-cross-module.integration.test.ts:489-569`; `vault-sync-ai-gate.test.ts:645-727`; `webauthn-prf.unit.test.ts:212-227` | Repetitive or self-implementing tests (e.g. `toBeGreaterThanOrEqual(0)`, and a "concurrent push" test that never pushes any payloads). | LUGX-106 |
| VAULT-TG-04 | `vault-orchestration.test.ts:881-900` | Titled "decrement remaining attempts" but fails to assert `failedAttempts`; lacks assertions for counter tampering, validity expiration, or offline revocation. | LUGX-015, LUGX-064 |
| VAULT-TG-05 | `vault-orchestration.test.ts:360-374` | "Encrypted" file fixture retains plaintext in its content property, enshrining plaintext persistence alongside `isEncrypted: true`. | LUGX-004 |
| VAULT-TG-06 | `vault-crypto-resilience.unit.test.ts:294-305`; `vault-crypto.test.ts:785-804` | Test case titles directly contradict the behavioral assertions executed within the test bodies. | — |
| VAULT-TG-07 | `vault-import.integration.test.ts:117-124`; `vault-storage.test.ts:177-232`; `vault-sync.live.test.ts:104,165,205,212` | "Zero Plaintext" assertion tests output generated by the test itself; server accepts `"fake-ciphertext"` with `encryptionMetadata=null`. | LUGX-070, LUGX-035 |
| VAULT-TG-08 | `e2e/specs/10-vault-lifecycle.spec.ts:12-72`; `11-vault-lock-trust.spec.ts:36-44` | E2E specs fail to exercise the actual vault; Spec 11 checks `localStorage` keys while keys are persisted in IndexedDB. | LUGX-028 |
| EDITOR-T-01 | `editor-atomic-commit.test.ts:101-157` | Re-implements logic internally rather than invoking the editor orchestrator. | — |
| EDITOR-T-02 | `editor-orchestration.integration.test.ts` | "retain local expectedVersion when dirty" tests only clean states, masking defect LUGX-020. | LUGX-020 |
| EDITOR-T-03 | Same file as above | "abort AI on manual edit" does not verify the retention of user manual edits. | LUGX-021 |
| EDITOR-T-04 | Same file as above | Vault locking tests fail to inspect local persistence or recovery; "encrypted" fixture files hold plaintext with `metadata: null`. | LUGX-004, LUGX-017, LUGX-023, LUGX-049 |
| EDITOR-T-05 | Same file as above | Conflict test does not verify IndexedDB state following page reload. | LUGX-022 |
| EDITOR-T-06 | `editor-recovery-reload.test.ts:118,141-143,160` | Vacuous assertion because `editor` instance is not passed into the hook. | — |
| EDITOR-T-07 | `markdown-editor-e2e.test.ts` | Header claims coverage of network disconnection, recovery, and retry; none are implemented, and existing tests are tautological. | — |
| EDITOR-T-08 | `markdown-editor.test.ts` | Text direction tests inspect getters only; performance assertion (<1000ms) is flaky and nondeterministic. | — |
| EDITOR-T-09 | `markdown-editor-interaction.test.ts` | "Vertical Navigation" lacks assertions; "zero margins" test does not inspect actual rendered margins. | — |
| EDITOR-T-10 | `editor-phase2-replacement.test.ts` (51-86) | Case-sensitive `indexOf` lacks component integration; tests execute regex searches against raw source code files. | LUGX-053, LUGX-054 |
| EDITOR-T-11 | `parser-file-validator.test.ts`; `export-import-roundtrip.integration.test.ts` | Tests `validateFileBuffer` which is never invoked in production; vault export/import roundtrip omits binary payload validation. | LUGX-152, LUGX-059 |
| EDITOR-T-12 | `parser-pdf-corruption-detector.test.ts:113-118` | Expects identical fallback value on `getDocument` failure; lacks tests chaining corruption detection to text extraction. | LUGX-018 |
| EDITOR-T-13 | `file-conversion.test.ts:58-61` | Compares `words[i]` against itself; fails to invoke decrypt path in context menu. | LUGX-019 |
| EDITOR-T-14 | `markdown-exporters.test.ts`, `parser-arabic-normalizer.test.ts`, `parser-pdf-table-extractor.test.ts`, `markdown-editor.ui.test.tsx` | Missing coverage for `snake_case`, `<`, `>`, and `*` in code blocks and task lists; normalizer test enshrines reversed behavior; lacks test for `onAdapterReady(null)`. | LUGX-058, LUGX-151, LUGX-157 |

### 5.2 Documentation Gaps

The documentation gaps detailed below complement the numbered documentation findings in Section 4 (LUGX-079 through LUGX-090, and LUGX-159 through LUGX-177).

| Identifier | Location | Documented Claim or Omission | Active Code Reality | Associated Finding |
|---|---|---|---|---|
| SYNC-DG-01 | `indexeddb.ts:2-6`; `HYBRID_ENCRYPTION_AND_VAULT_PLAN.md:7` | Claims "Zero Plaintext At-Rest" without a valid threat model. | Encryption key is stored directly adjacent to data in IndexedDB. | LUGX-035 |
| SYNC-DG-02 | `sync-manager.ts:1735` | No documentation on semantics of 'local', 'server', and 'merge' or resolution ownership. | Inline comment directly contradicts the semantics of "retain local". | LUGX-003 |
| SYNC-DG-03 | `/api/files/sync` API contract | Omits documentation for `has_more`, `next_cursor`, `updated_after`, and timestamp provenance. | Undocumented pagination protocol and client clock drift susceptibility. | LUGX-012, LUGX-100 |
| SYNC-DG-04 | PIN constraint specifications | Missing entropy calculations, local attempt rate limits, and device key loss consequences. | Low-entropy PIN exposed to offline brute-force attacks. | LUGX-015 |
| SYNC-DG-05 | `mnemonic.ts` | No mention of non-standard wordlist ordering or version migration policy. | Proprietary wordlist ordering incompatible with standard BIP-39 tooling. | LUGX-043 |
| VAULT-DOC-01 | `vault-actions.ts:155-156` | Claims "instantly invalidates all local device PIN envelopes". | Advisory only; depends entirely on network connectivity (Attack Chain D). | LUGX-064 |
| VAULT-DOC-02 | `vault-phase-5-closure-test-matrix.md:90` | Seed recovery documented as "PASS (100%)". | Seed recovery is completely broken in production UI; test harness bypassed UI paths. | LUGX-005 |
| VAULT-DOC-03 | `vault-phase-3-ui-and-conversion-closure.md:11` | Claims `CreateVaultModal` invokes `wrapMasterKeyWithPassword/RecoverySeed`. | Calls `wrapKeyRaw` directly with divergent AAD contexts. | LUGX-005 |
| VAULT-DOC-04 | `vault-phase-3-ui-and-conversion-closure.md:113-114` | Claims "1,000,000 combinations" and "Offline Extraction Immunity". | Keyspace \(10^6\) is trivially exhaustible offline; immunity applies exclusively to PRF. | LUGX-015 |
| VAULT-DOC-05 | `vault-phase-2-schema-and-storage-closure.md:221,226,297` | Claims "Zero Plaintext At-Rest". | Raw device key stored directly adjacent to encrypted payloads. | LUGX-035 |
| VAULT-DOC-06 | `vault-phase-5-closure-test-matrix.md:19,91` | Claims buffer wiping "inside finally blocks" and `extractable: false`. | Buffers wiped only on success; master key held as extractable raw `Uint8Array`. | LUGX-127, LUGX-084 |
| VAULT-DOC-07 | `vault-phase-5-closure-test-matrix.md:93` | Claims "600K PBKDF2 off main thread; 60fps". | Falls back to blocking the main UI thread upon any worker error. | LUGX-106 |
| VAULT-DOC-08 | `vault-phase-1-crypto-core-closure.md:174,177,188` | Claims AAD mismatch throws `AADIntegrityError`; claims NFKC normalization in UI. | Throws generic `InvalidCiphertextOrKeyError`; UI does not normalize inputs. | LUGX-133 |
| VAULT-DOC-09 | `vault-phase-5-closure-test-matrix.md:22`; `vault-phase-4-ai-gates-sync-closure.md:164` | Claims timeout is "strictly locked to 1 hour"; claims "Server-side route barrier". | Public timeout modifier exists (`session-key-store.ts:72`); gate accepts optional `fileId`. | LUGX-085, LUGX-042 |
| EDITOR-DG-01 | `markdown-stripper.ts:18`; `arabic-normalizer.ts:32,124`; `folder-picker-modal.tsx:18`; `file-context-menu.tsx:457`; `use-editor-orchestrator.ts:487` | Inline comments describe intended architectural behavior. | Active implementation code directly contradicts inline comments. | LUGX-058, LUGX-151, LUGX-019 |
| EDITOR-DG-02 | `saveLocal` / IndexedDB | No documentation of invariant "Ciphertext Only in Storage" or cross-tab locking protocol. | Plaintext leaked to IndexedDB under encrypted flag; dirty state lost across tabs. | LUGX-004, LUGX-049 |
| EDITOR-DG-03 | Client and Server | Documented file import size limit is 10 MB. | Fails to disclose Next.js Server Actions default 1 MB request body limit. | LUGX-059 |

---

## 6. Architectural Remediation

The following architectural designs directly remediate root causes R1 through R8. Each design is synthesized from the structural fixes established across the unit audit and multi-pass verification reports.

### 6.1 Server-Authoritative Quota Settlement
- **Objective:** Eliminate all client-controlled financial state transitions. Remediates: LUGX-001, LUGX-002, LUGX-006, LUGX-007, LUGX-030, LUGX-031, LUGX-115, LUGX-116.
- **Design Specifications:**
  1. **Server Reservation State Machine:** Enforce discrete server states: `reserved → committed | refunded | expired`. Updated during `start()` inside the stream route with `first_token_at` or `delivered_units` prior to dispatching the first SSE chunk frame.
  2. **Atomic Commitment on Stream Termination:** Atomic commit triggered upon dispatching the `done` event frame or upon connection interruption occurring after the first token. Quota refund is exclusively a server decision: permitted only prior to the first delivered token, on internal system error, or on server-validated HTTP 412 optimistic lock conflict.
  3. **Idempotency Key Bound to Request Fingerprint:** Server generates `operationId` and computes `request_hash = sha256(operation | text | fileId)`. Any replay attempt with a mismatched hash is rejected with HTTP 409 Conflict, and `expiresAt` is strictly validated.
  4. **Strict Module Boundary Separation:** Restrict all functions accepting `userId` or `tier` to `ai-ops.server.ts` protected by `import "server-only"`. Thin `ai-actions.ts` files marked `"use server"` extract user identity strictly from the verified session cookie. Enforce an ESLint rule preventing any `"use server"` file from exporting functions that accept a client-supplied `userId`.
  5. **Tamper-Resistant Unit of Measure:** Calculate consumed quota based on actual model tokens or `max(words, ceil(chars / 6))`.
  6. **Atomic Ledger Transitions:** Single transactional boundary for reservation (`ON CONFLICT DO NOTHING RETURNING` followed by conditional update), pessimistic locking via `usage_weekly` row or Postgres advisory lock, and lazy expiration on subsequent reservation requests rather than reliance on daily cron jobs.

### 6.2 Single Persistence State Machine for Sync with Version-Tagged Writes
- **Objective:** Ensure no file is marked clean without explicit, verifiable proof from the authoritative server. Remediates: LUGX-003, LUGX-009, LUGX-010, LUGX-011, LUGX-012, LUGX-013, LUGX-020, LUGX-022, LUGX-034, LUGX-036, LUGX-037, LUGX-038, LUGX-039, LUGX-040, LUGX-041, LUGX-050, LUGX-051, LUGX-052, LUGX-089.
- **Design Specifications:**
  1. **Explicit Per-File State Machine:** `clean | dirty | pushing(localRevision) | conflict(local, remote, base) | delete_conflict | failed(nextRetryAt)`. Implemented via a TypeScript discriminated union with exhaustive `switch` statement checking.
  2. **Monotonic `localRevision` Counter:** Incremented on every `saveLocal`. Transition to `clean` is permitted solely via Compare-And-Swap (CAS) within a single IndexedDB transaction: requires an HTTP 2xx response containing complete `{etag, version}` payloads, where dispatched revision equals current local revision.
  3. **Persistent Conflict State in IndexedDB:** Conflict state persists in IndexedDB across page reloads and browser restarts; blocks `pullFile` and `adopt_remote` while unresolved. Resolution 'local' is a conditional push carrying server `If-Match` and `expectedVersion`. Conflict handler is a singleton application-level service keyed by `conflict.fileId`.
  4. **Removal of Destructive Rollbacks:** Eliminate rollback from push failure pathways. Network and server errors preserve dirty state and reschedule synchronization using typed errors (`SyncHttpError`) with mandatory exponential backoff, randomized jitter, and explicit `nextRetryAt`.
  5. **Server-Issued Pagination Cursor:** Pull cursor generated and signed by the server; saved to IndexedDB only after all pagination pages have completed within the same file storage transaction.
  6. **Cross-Tab Mutual Exclusion:** Enforce concurrency locks using `navigator.locks.request(fileId)`, backing a per-file serialized write queue that merges latest content with atomic version, etag, and content anchoring.
  7. **Deterministic 3-Way Merge:** Standardize on production-tested 3-way merge (`node-diff3`) validated by property-based tests; implement backpressure handling rather than silent conflict eviction.

### 6.3 Encryption Envelope Type-Safety
- **Objective:** Architecturally prevent marking plaintext as encrypted and prohibit exposing raw ciphertext upon decryption failure. Remediates: LUGX-004, LUGX-014, LUGX-017, LUGX-019, LUGX-035, LUGX-036, LUGX-044, LUGX-048, LUGX-055, LUGX-056, LUGX-057, LUGX-070, LUGX-071, LUGX-085, LUGX-103.
- **Design Specifications:**
  1. **Discriminated Type Union:** Enforce strict type separation between `Plaintext` and `EncryptedEnvelope { ciphertext, iv, keyId, aadVersion, contentRevision }`. Neither `saveLocal` nor HTTP PUT accepts untyped inputs; eliminate detached `isEncrypted` boolean flags.
  2. **Single Local Persistence Gateway:** Route all writes through `persistLocal(fileId, plaintext)`, delegating to `SyncCryptoGateway.encryptOutbound`. Rejects persistence if the encryption key is unavailable; unencrypted volatile edits reside strictly in RAM.
  3. **Discriminated Decryption Results:** `decryptInbound` returns `decrypted | plaintext_legacy | failed`. On `failed`, file enters `decrypt_failed` state with a read-only editor view; zero pathways permit re-uploading failed ciphertexts as plaintext.
  4. **Atomic Base Snapshots:** Capture `baseSnapshot` as a complete envelope within the transaction boundary; "adopt remote" clones entire record metadata.
  5. **Unified `buildFileAAD(uid, fileId)` Function:** Throws if identifiers are null or empty; embeds `{ schemaVersion, fileId, userId, keyId, contentRevision }` into AAD and rejects rollback sequences.
  6. **Unified Server-Side Validation Boundary:** Single validation routine for all write routes: Postgres `CHECK (NOT is_encrypted OR (encryption_metadata ? 'iv'))`, Base64 structural validation, 128-bit authentication tag validation, and IV deduplication checks. State transitions between encrypted and unencrypted files require dedicated actions with refreshed content and `expectedVersion`.
  7. **Mandatory Schema Migration:** Phase out legacy plaintext storage paths via explicit `schemaVersion` tracking.

### 6.4 Key Hierarchy and Rotation
- **Objective:** Establish a single cryptographic source of truth for master key operations with cryptographically enforceable revocation. Remediates: LUGX-005, LUGX-015, LUGX-016, LUGX-024, LUGX-035, LUGX-042, LUGX-043, LUGX-062, LUGX-063, LUGX-064, LUGX-065, LUGX-066, LUGX-084, LUGX-106, LUGX-124 through LUGX-133.
- **Design Specifications:**
  1. **Single Source of Truth (`vault-keyring.ts`):** Centralize all master key wrapping and unwrapping; type-safe AAD constants; ESLint rule blocking direct UI calls to `wrapKeyRaw`/`unwrapKeyRaw`; track `wrapFormatVersion` with fallback migration support for `vault:seed:`.
  2. **Non-Exportable Master Key in Worker Context:** Master key instantiated as non-extractable `CryptoKey` inside Web Worker; accessed via opaque handle identifiers; guarded by `withMasterKey(fn)` validating lock epoch prior to and following execution.
  3. **Non-Exportable Device Key:** Device key stored as non-extractable `CryptoKey` object directly in IndexedDB or wrapped with vault-derived key; isolate "key missing" from "read error".
  4. **Server-Assisted PIN Authentication:** PIN unlocking requires server secret exchange (OPRF/OPAQUE or server-side pepper with attempt rate limiting) or hardware-backed WebAuthn PRF. Bind `expiresAt`, `deviceTrustEpoch`, and `keyVersion` into AAD; fetch trust epoch from server at unwrap time.
  5. **Cryptographic Proof of Possession:** Require `authKey = HKDF(MK, "vault-auth")` proof of possession on envelope mutations; validate via strict Zod schemas; maintain separate, bounded KDF iteration profiles per envelope.
  6. **Master Key Rotation with Lazy Re-encryption:** Re-encrypt stored files lazily upon revocation, password reset, or compromise alerts; execute atomic updates via `UPDATE ... device_trust_epoch + 1 RETURNING`.
  7. **Server-First Vault Initialization & Reset:** Vault creation and resets execute against server first; maintain durable outbound sync queue in `pending_server_ack` state; block local encryption until server acknowledgement; network-first profile fetching.
  8. **Standard BIP-39 Wordlist Implementation:** Standardize on `@scure/bip39` with explicit `mnemonicVersion` and Unicode NFKC normalization.

### 6.5 Subscription-Keyed Idempotent Webhook with Retry
- **Objective:** Eliminate dropped events, stale state overwrites, and unauthorized plan transitions. Remediates: LUGX-025, LUGX-026, LUGX-027, LUGX-068, LUGX-069, LUGX-134, LUGX-135, LUGX-141, LUGX-145, LUGX-148, LUGX-149.
- **Design Specifications:**
  1. **Deterministic Webhook Response Contract:** Return HTTP 2xx only after transaction commit and event logging; return HTTP 5xx on transient errors to provoke Stripe delivery retries; return HTTP 2xx with `rejected` payload exclusively on permanent non-retryable failures; return HTTP 409/503 on concurrent in-flight deliveries. Prohibit swallowed `try/catch` blocks; `isSubscriptionEventProcessed` must throw on error rather than returning false.
  2. **Subscription-Keyed Data Architecture:** Primary key on `subscriptions` table is `stripe_subscription_id`; compute `users.tier` from highest active or trialing subscription; track `last_event_created` per subscription or re-fetch authoritative state via `subscriptions.retrieve`.
  3. **Authoritative Customer Resolution:** Resolve user identity via dedicated lookup table (`stripe_customer_id` / `stripe_subscription_id → user_id`) rather than unverified webhook metadata; resolve tier from `price.id`, strictly rejecting unrecognized price identifiers.
  4. **In-Place Plan Upgrades via `subscriptions.update`:** Plan modifications execute via `subscriptions.update` specifying `proration_behavior` or redirecting through Stripe Customer Portal; compute `idempotencyKey` from `userId + tier`; enforce pessimistic lock via `SELECT ... FOR UPDATE`.
  5. **Entitlements Granted Exclusively on Subscription Events:** Grant access only on `customer.subscription.created/updated`; track discrete `paused` state; maintain audit table for unsupported event types; sanitize empty strings to `NULL`.

### 6.6 Fail-Closed Rate Limiting
- **Objective:** Explicit failure policy configured per service tier with verified protection against bypass. Remediates: LUGX-079, LUGX-087, LUGX-093, LUGX-120, LUGX-121, LUGX-136, LUGX-181.
- **Design Specifications:**
  1. **Mandatory Failure Policies:** Configure explicit policy in `RATE_LIMITS`: `fail-closed` for AI and authentication endpoints; `fail-open` for sync pathways, backed by `@upstash/ratelimit` or atomic Redis Lua scripts.
  2. **Fail-Fast Environment Schema at Boot:** Centralized validation schema rejecting unconfigured `UPSTASH_*`, missing `DATABASE_URL`, or default placeholder values; enforce minimum length for `CRON_SECRET`; automatically generate `.env.example` from schema.
  3. **Active Authentication Rate Limiting:** Enforce `authRateLimiter` across all authentication routes; constant-time string comparison (`timingSafeEqual`) for cron secrets; atomic Redis operations (`SET` with `EX`, `INCR`/`DECR`).
  4. **Centralized HTTP Security Headers:** Enforce strict CSP with cryptographic nonces, `frame-ancestors 'none'`, and HSTS; fail-closed limiting is insufficient if XSS remains viable (LUGX-095).

### 6.7 CI Gates That Can Fail
- **Objective:** Ensure every green CI pipeline represents rigorous, uncompromised verification. Remediates: LUGX-076, LUGX-086, LUGX-088, LUGX-091, LUGX-092, LUGX-093, LUGX-094, LUGX-097, LUGX-146, LUGX-159, LUGX-178 through LUGX-182.
- **Design Specifications:**
  1. **Database Schema Drift Prevention:** Migration generation derived strictly from `schema.ts` with `0000_baseline`; migration ledger tracking; read-only drift verification (`drizzle-kit check` and `generate` asserting empty diff, or `pg_dump --schema-only` with `diff --exit-code`); invoke `process.exit(1)` on any discrepancy.
  2. **Test Isolation & Hermetic Sandboxing:** Disable `fileParallelism: false` without `@ts-expect-error` or provision isolated Postgres schemas per worker; single guard module enforcing allowlist for `TEST_DATABASE_URL`; hermetic E2E environment; Upstash-compatible local REST proxy.
  3. **Deterministic CI Gating Logic:** Extract gating logic into standalone script tested against input matrices; run `actionlint`; extract test metrics from `--reporter=json` run logs; run `eslint --max-warnings 0`; enforce test coverage thresholds across `src/**`; run `gitleaks`.
  4. **Supply Chain Hardening:** Set top-level GitHub Actions `permissions: contents: read`; pin all Actions by full commit SHA managed via Dependabot; access secrets strictly from `secrets.*`; require GitHub Environments for production deployments.
  5. **Hermetic Build Verification:** Execute E2E tests against production `next start` build (Stage 5); fail build if `/api/test/*` appears in `app-paths-manifest.json`.
  6. **High-Fidelity Integration Testing:** Introduce mutation testing (Stryker) on `file-ops.ts` and `route.ts`; integration tests import real production modules and mock only auth boundaries; ephemeral Postgres containers (Testcontainers); benchmark test suites for Gemini prompts.

### 6.8 E2E Through Real UI
- **Objective:** Every test exercises real application behavior through verified browser and protocol interfaces. Remediates: LUGX-028, VAULT-TG-08, EDITOR-T-04, AI-T5.
- **Design Specifications:**
  1. **Strict Arrange-Act-Assert Isolation:** Arrange test fixtures via direct database seeding; Act exclusively through browser interactions or public HTTP requests; Assert across UI elements and database state; ESLint rule blocking `e2eDb.update/delete` following initial `page.goto`.
  2. **Server-Level Gemini Mock Service:** Mock Gemini at the HTTP network boundary via mock server injected via environment variable; trigger Stripe webhooks via `stripe trigger` or HMAC-SHA256 signed payloads; resolve `periodKey` from production date utilities.
  3. **Mandatory Critical Path UI Specs:** Real conflict resolution (concurrent edits in two contexts, HTTP 412, resolution dialog, choice execution, IndexedDB post-reload verification); vault initialization, lock, and mnemonic phrase recovery; encryption validation with ciphertext inspection in database column; vault lock-unlock-write lifecycle; negative test verifying quota refund rejection post `done` frame; previous tier cancellation verification upon upgrade.

### 6.9 Phased Roadmap

| Phase | Priority | Scope & Objectives | Consolidated Findings Remediated |
|---|---|---|---|
| **Phase 0: Immediate Containment** | P0 | Remove `"use server"` export from `refundAIReservation`/`commitAIReservation`; enforce server commitment on `done`; reject replay attempts with mismatched fingerprint and validate `expiresAt`. Halt premature 'local' resolution before user decision; make 'local' a conditional push. Add guard in `saveLocal` rejecting non-Base64 text under `isEncrypted: true`; validate Base64 and auth tag length on server. Unify recovery AAD with fallback `vault:seed:`. Return HTTP 5xx from Stripe webhook on any failure. | LUGX-001, LUGX-002, LUGX-003, LUGX-004, LUGX-005, LUGX-006, LUGX-025 |
| **Phase 1: Data Integrity & Persistence** | P1 | Implement Sync Persistence State Machine (§6.2): `localRevision`, CAS transitions, durable conflicts, elimination of push rollback, version preservation, server pull cursor, and blocking 404 cleanup. Implement Single Encrypted Write Gateway and discriminated decryption outcomes (§6.3). Prevent editor unmounting on vault lock; implement two-phase locking. | LUGX-009 through LUGX-014, LUGX-017, LUGX-019 through LUGX-023, LUGX-034, LUGX-036 through LUGX-041, LUGX-047 through LUGX-052 |
| **Phase 2: Billing & Quota Ledger** | P1 | Subscription table keyed by `stripe_subscription_id`; customer lookup table; resolve tier from price ID; update plan via `subscriptions.update` rather than checkout; quota measurement units; atomic reservation transactions and lazy cleanup; structured Gemini error classification; failed key penalization. | LUGX-007, LUGX-008, LUGX-026, LUGX-027, LUGX-029, LUGX-030, LUGX-031, LUGX-068, LUGX-069, LUGX-134, LUGX-135 |
| **Phase 3: Cryptographic Key Hierarchy** | P2 | Implement `vault-keyring.ts`; non-exportable `CryptoKey` for master and device keys; server-assisted PIN or WebAuthn PRF; cryptographic proof of possession; lazy re-encryption on key rotation; server-fetched trust epoch; server-first vault creation and reset; standard `@scure/bip39` wordlist. | LUGX-015, LUGX-016, LUGX-024, LUGX-035, LUGX-042 through LUGX-044, LUGX-062 through LUGX-066, LUGX-084, LUGX-106, LUGX-124 through LUGX-133 |
| **Phase 4: Defensive Hardening** | P2 | Per-tier fail-closed / fail-open rate limiting policies; boot-time environment schema validation; security headers and nonce CSP; strip `/api/test/e2e-auth` from production build; strict parameter allowlists on Server Actions (`updateUserProfile`, `copyFile`, `moveFile` using `WITH RECURSIVE`); typed database layer with verified TLS; mandatory `fileId` in AI gatekeeper. | LUGX-067, LUGX-070 through LUGX-075, LUGX-077, LUGX-079, LUGX-085, LUGX-087, LUGX-095 |
| **Phase 5: CI Gating & Test Infrastructure** | P3 | Implement CI gating (§6.7) and UI E2E framework (§6.8); rewrite all 14 E2E specs adhering to strict architectural invariants; replace self-mocking tests with tests importing production modules. | LUGX-028, LUGX-076, LUGX-078, LUGX-086, LUGX-088, LUGX-091 through LUGX-094, LUGX-096, LUGX-097, and Table 5.1 |
| **Phase 6: Documentation & Low Findings** | P3 | Correct documented security claims per Table 5.2; generate operational metrics directly from code artifacts; protect `docs/records/` immutability; remediate remaining Low findings. | LUGX-080 through LUGX-083, LUGX-089, LUGX-090, and remaining Low findings (LUGX-098 through LUGX-183) |

---

## 7. Appendices

### 7.1 Module Coverage

| Module | Files Read Line-by-Line | File List Artifact | Additional Reference Files | Empirical Verification Harnesses |
|---|---|---|---|---|
| Synchronization | 46 of 46 | `audit/lists/sync.txt` | `use-editor-orchestrator.ts` (sections), `files/[id]/route.ts` (110-310), `pdf-worker-bridge.ts`, `components/vault/*`, `vault-actions.ts` (155-179) | `audit/sync-verify/`, `audit/verify-v1-harness/` |
| Artificial Intelligence | 32 of 32 | `audit/lists/ai.txt` | `utils.ts`, `schema.ts` (136-152), `0005_ai_reservations.sql`, `features.config.ts`, `rate-limit.ts`, `tiers.config.ts`, cron route, workspace editor page | `audit/ai-verify/`, `audit/verify-v2-harness/` |
| Security Vault | 30 of 30 | `audit/lists/vault.txt` | `encryption.ts`, `indexeddb.ts` (60-145), `crypto-worker-bridge.ts` (160-172), `session-key-store.ts`, `idb-types.ts` (253-257), `crypto.worker.ts`, `ai/stream/route.ts` (78-110) | `audit/vault-verify/`, `audit/verify-v2-harness/aad.mjs` |
| Backend & Database | 75 of 75 | `audit/lists/backend.txt` | `next.config.ts`, `drizzle.config*.ts`, `package.json`, `README.md`, `.env.example`, `file-context-menu.tsx`, `use-editor-orchestrator.ts`, `sidebar.tsx` | v3 verification via static analysis, AST inspection, and call graph tracing |
| Markdown Editor | 62 of 62 | `audit/lists/editor.txt` | `use-sync.ts` (295-362), `use-ai-stream.ts`, `stream-session.ts`, `sync-manager.ts` (960-1075), `sync-crypto-gateway.ts`, `reconciliation.ts`, `files/[id]/route.ts` (150-175), `file-ops.ts`, `import-file.ts`, `next.config.ts`, `editor.config.ts` | `/tmp/edaudit/{detach.mjs, mkpdf.mjs, strip.js, ar.mjs}`, `audit/verify-v1-harness/` |
| Documentation | 79 entries in manifest: README, AGENTS, CLAUDE, and complete `docs/` tree read in full | `audit/lists/docs.txt` | `ai-ops.ts`, `rate-limit.ts`, `sync/*`, `crypto.worker.ts`, API routes, `markdown-stripper.ts`, `scripts/*.mjs`, `.github/workflows/*`, `package.json`, `.gitignore` | `sync-doc-metrics --check`, `check-markdown-links` (78 files, 209 links), `/tmp/strip.mjs`, `/tmp/pdiff.mjs` |
| Infrastructure & CI/CD | 41 of 41 | `audit/lists/infra.txt` | `load-test-env.ts`, `test-db-guard.ts`, `e2e-auth/route.ts`, cron routes, `db/index.ts`, `schema.ts`, migrations 0001-0010, `redis.ts`, `webhook/route.ts` (560-600), `ai/stream/route.ts` (45-135), `key-rotation.ts` (150-185) | `/tmp/vt`, `/tmp/gate`, `/tmp/envsim`, `/tmp/mdl`, local HTTP server harness |
| **Total** | 365 manifest entries, containing 11 files shared across two lists, within an overall scope of 355 distinct files | — | — | — |

- **Exclusions:** Vendored binary and third-party web assets (`cmaps`, `fonts`, `pdf.worker.min.mjs`) and `package-lock.json`.
- **Secondary Verification Scope:** Encompassed all Critical and High findings, and all Medium findings marked LIKELY across all seven unit reports. Specifically subjected to detailed verification: 29 findings in Pass v1, 14 findings in Pass v2, and 19 findings in Pass v3.

### 7.2 Post-Verification Severity Changes

| Original ID | Prior Severity | Final Severity | Verification Pass | Short Rationale | Consolidated Finding |
|---|---|---|---|---|---|
| AI-01 | Critical | High (Standalone) | v2 | Cleaner is daily and bounded to 100 rows. Remains Critical when chained with AI-02 or AI-03. | LUGX-006 |
| AI-05 | High | Low | v2 | Functions are not imported by any client component; Next.js 16 treeshakes unreferenced server actions; commit portion provides zero utility to attacker. | LUGX-115 |
| AI-07 | High | Medium | v2 | 300-second cooldown is self-healing; impact is limited to temporary partial service degradation. | LUGX-029 |
| AI-08 | Medium | Low | v2 out-of-scope finding adopted | Function is unimported and never invoked (dead code). | LUGX-116 |
| AI-12 | Medium | Low | v2 | Feature is governed by a configuration flag disabled by default in production. | LUGX-117 |
| VAULT-03 | High | Medium (Latent) | v2 | Unreachable behind VAULT-01 bug barrier. | LUGX-062 |
| VAULT-05 | High | Medium in v2; High via Consolidation | v2 then Conflict Rule | Conflicted with v1 ruling on SYNC-09 (High); unified on High. | LUGX-015 |
| SYNC-06 | High | Medium | v1 | Data does not become permanently stranded; `pushDirtyFiles` delivers edits on reconnect. | LUGX-034 |
| SYNC-10 | High | Medium | v1 | Defense-in-depth vulnerability; requires an improbable triggering sequence. | LUGX-035 |
| SYNC-12 | High | Medium | v1 | Highly constrained accessibility and narrow execution window. | LUGX-036 |
| SYNC-18 | Medium | Low | v1 | `releaseAll` is uninvoked; no race condition exists between waiting operations. | LUGX-098 |
| SYNC-23 | Medium | Low | v1 | Push operation utilizes `file.content` directly. | LUGX-099 |
| EDITOR-24 | Medium | Low | v1 | Page component unmounts and remounts when route parameter mutates. | LUGX-150 |
| BACKEND-01 | High | Medium (Latent) | v3 | Function is unimported in client code; treeshaken by Next.js compiler. | LUGX-067 |
| BACKEND-08 | Medium | Low | v3 | Unreachable when billing is restricted to card payments. | LUGX-134 |
| INFRA-01 | High | Medium | v3 | Impact is restricted to CI pipeline reliability without production exposure. | LUGX-091 |
| INFRA-02 | High | Medium | v3 | Network connectivity errors still fail the command; cluster unified at Medium. | LUGX-076 |
| INFRA-03 | High | Medium | v3 | Phase 4 claim discrepancy has zero operational impact on running system. | LUGX-092 |
| INFRA-13 | Medium | Low | v3 | No production secrets are currently exposed. | LUGX-169 |
| DOCS-01 | High | Medium via Consolidation | Majority Rule (v1 & v2 Medium) | Duplicate of SYNC-10 and VAULT-08. | LUGX-035 |
| DOCS-02 | High | Medium | v3 | Gemini API key rotation path is fail-closed. | LUGX-079 |
| DOCS-03 | High | Medium | v3 | No account hijacking possible; DELETE claim was refuted. | LUGX-077 |
| DOCS-35 | High | Critical via Consolidation | v2 (Unified to Critical) | Duplicate of AI-02. | LUGX-001 |
| AI-11 | Medium | High via Consolidation | Consolidation with EDITOR-06 | Identical defect in `assertSessionIntegrity`. | LUGX-021 |
| SYNC-32 | Low | Medium via Consolidation | Consolidation with VAULT-06 (Group D4 in v2) | Epoch extracted from envelope; revocation is non-cryptographic. | LUGX-064 |
| VAULT-20 | Low | Medium via Consolidation | Consolidation with DOCS-10 (Group D2 in v2, v3 map) | `fileId` parameter is optional. | LUGX-085 |
| BACKEND-19 | Low | Medium via Consolidation | v3 cluster with DOCS-02 | Fail-open behavior. | LUGX-079 |
| BACKEND-22 | Low | Medium via Consolidation | v3 map with EDITOR-21 | 10 MB UI limit versus 1 MB Server Action body limit. | LUGX-059 |
| INFRA-17 | Low | Medium via Consolidation | v3 cluster with DOCS-14 | Self-referential test metrics. | LUGX-088 |
| INFRA-06 | Medium | Medium | v3 cluster with DOCS-12 | No change in severity. | LUGX-086 |

**Status Promotions from LIKELY to CONFIRMED (Severity Unchanged):**
SYNC-14, SYNC-19, EDITOR-14, EDITOR-22, and EDITOR-23 (v1 verification pass); BACKEND-13 (v3 verification pass).

### 7.3 Consolidation and Deduplication (21 Merged Findings)

| Consolidated Finding | Merged Original IDs | Structural Basis |
|---|---|---|
| LUGX-001 | AI-02, DOCS-35 | Pass v2 (D1) and Pass v3: Identical exposed server action |
| LUGX-015 | SYNC-09, VAULT-05 | Identical envelope structure and counter mutations (`encryption.ts:255-282`) |
| LUGX-021 | EDITOR-06, AI-11 | `assertSessionIntegrity` closing over identical stale closure references |
| LUGX-027 | BACKEND-04, BACKEND-05 | Pass v3: Identical root cause (single-subscription schema limitation) |
| LUGX-030 | AI-09, DOCS-04 | Pass v2 (D9): Identical non-atomic check-then-act pattern |
| LUGX-035 | SYNC-10, VAULT-08, DOCS-01 | Pass v2 (D3) and Pass v3: In-memory/local plaintext adjacent key storage |
| LUGX-058 | EDITOR-20, DOCS-11 | Pass v3 architectural map: Code block and formatting normalization divergence |
| LUGX-059 | EDITOR-21, BACKEND-22 | Pass v3 architectural map: 10 MB vs 1 MB upload body limit divergence |
| LUGX-064 | VAULT-06, SYNC-32 (with VAULT-03(2) and epoch portion of VAULT-05) | Pass v2 (D4): Advisory epoch and non-cryptographic envelope revocation |
| LUGX-076 | INFRA-02, BACKEND-15, INFRA-07 | Pass v3 cluster: Database schema drift and migration ledger omissions |
| LUGX-077 | BACKEND-16, INFRA-09, DOCS-03 | Pass v3 cluster: Exposed `/api/test/e2e-auth` endpoint |
| LUGX-079 | DOCS-02, BACKEND-19 | Pass v3 cluster: Fail-open fallback behavior across limits |
| LUGX-085 | DOCS-10, VAULT-20 (with clause 5 of AI-15) | Pass v2 (D2) and Pass v3: Optional `fileId` bypass in AI route gatekeeper |
| LUGX-086 | DOCS-12, INFRA-06 | Identical script target `test-ci-gating.mjs` |
| LUGX-088 | DOCS-14, INFRA-17 | Pass v3 cluster: Self-referential test metric calculations |
| LUGX-106 | SYNC-31, VAULT-18 | Identical source location `crypto-worker-bridge.ts:164-170` |
| LUGX-159 | DOCS-17, INFRA-18 | Pass v3 map: Broken relative markdown link validation script |
| LUGX-169 | DOCS-27, INFRA-13 | Pass v3 cluster: Tracked `.env.test` file and unencrypted dummy secrets |

- **Consolidation Accounting:** The table contains 18 consolidation rows; three of these rows fold three distinct numbered findings each (LUGX-035, LUGX-076, and LUGX-077), yielding a total of 21 folded items. Verification: 204 original findings minus 21 folded items equals exactly 183 consolidated findings.
- **Partial Consolidations (Without folding a numbered finding):**
  - AI-08: Sub-components distributed across LUGX-002 and LUGX-007, while remaining as an independent dead-code finding in LUGX-116.
  - VAULT-03(2): Folded into LUGX-064, while VAULT-03 remains independent in LUGX-062.
  - `commitAIReservation` portion of AI-05: Folded into LUGX-115.
  - `fileId` and cancellation sub-claims of AI-15: Distributed across LUGX-085 and LUGX-118.
- **Attack Chains Retained as Distinct Findings (Not Deduplicated):**
  - D1 in Pass v1: SYNC-01 and EDITOR-07.
  - D2 in Pass v1: SYNC-03, EDITOR-12, and EDITOR-14.
  - D3 in Pass v1: SYNC-02, SYNC-12, and SYNC-14.
  - D4 in Pass v1: SYNC-04 and SYNC-27.
  - D5 in Pass v1: EDITOR-01, EDITOR-02, EDITOR-04, EDITOR-10, and SYNC-28.
  - D6 in Pass v1: SYNC-08 and EDITOR-02.
  - D8 in Pass v1: EDITOR-08, EDITOR-09, and EDITOR-11.
  - D9 in Pass v1: EDITOR-05 and EDITOR-13.
  - D10 in Pass v1: EDITOR-03, EDITOR-22, and SYNC-36.
  - D11 in Pass v1: EDITOR-18, EDITOR-04, and EDITOR-10.
  - D12 in Pass v1: SYNC-09, SYNC-32, and SYNC-10.
  - D10 in Pass v2: AI-05 and BACKEND-01.
  - Other Pass v3 Clusters: BACKEND-20 with INFRA-19; BACKEND-31 with INFRA-03; DOCS-15 with SYNC-26.

### 7.4 Filtered Out and Rejected Findings Summary

**Claims Formally Refuted in Secondary Verification:**

| Audit Item | Final Verdict | Technical Refutation Rationale |
|---|---|---|
| Sub-claim in DOCS-03: "Account deletion via DELETE endpoint" | REFUTED (v3) | DELETE handler (`route.ts:157-191`) terminates caller session and clears auth cookies only; does not delete Postgres user records. |
| Exploitation feasibility claim in AI-05 | UNREACHABLE (v2) | Functions are unreferenced in client bundles; Next.js 16 treeshakes unreferenced server actions; commit has no financial utility. |
| SYNC-02 reproduction steps in unit report | ERRONEOUS & REFINED (v1) | Manager resolves identical content states prior to dispatching responses. |
| "UI does not invoke `encryption.ts` functions" in VAULT-01 | ERRONEOUS & REFINED (v2) | PIN encryption routines are directly imported from `encryption.ts`. |
| "`encryption.ts` is an unused reference benchmark" in VAULT-05 | ERRONEOUS & REFINED (v2) | `encryption.ts` is the active production execution path for PIN wrapping. |
| "Some child files remain soft-deleted" in BACKEND-13 | REFINED (v3) | `UPDATE` executes atomically; consequently **all** child files remain soft-deleted. |
| "Retry storm" in SYNC-06 | EXAGGERATED (v1) | Protocol is bounded to exactly two HTTP PUT requests per cycle. |
| "Balance restored after five minutes" in AI-01 | INACCURATE (v2) | Quota refund occurs strictly upon execution of the daily cron cleanup job. |
| "Gemini API key exhaustion on Redis outage" in DOCS-02 | REFINED (v3) | Gemini key rotation failure handler is strictly fail-closed. |

**Candidate Findings Dropped by Unit Agents During Phase 2 Filtering:**

| Module | Candidate Finding Dropped | Rationale for Exclusion |
|---|---|---|
| Synchronization | "diff3 algorithm is broadly broken" | Fuzz testing across unique line inputs demonstrated zero corruption; defect is strictly isolated to repeated adjacent lines. |
| Synchronization | UI callback execution inside file lock blocks sync engine | No deadlock observed; performance impact subsumed under LUGX-003. |
| Synchronization | Dual execution in crypto bridge is a distinct vulnerability | Subsumed as technical note under LUGX-106. |
| Synchronization | Empty etag handling in `reconciliation.ts` | Implementation is mathematically correct and validated by unit tests. |
| Synchronization | `syntax-validator.ts` and `performance-monitor.ts` security issues | Impact is negligible or functionality operates as designed. |
| Synchronization | `pdf.worker` response leaks cross-origin | Default `targetOrigin` is restricted to self origin. |
| Synchronization | Witness deletion for dirty file without conflict | Guard clause returns explicit `conflict` state. |
| Synchronization | `pdfjs-dist` executes arbitrary `eval` | Flag `isEvalSupported: false` is explicitly configured. |
| Artificial Intelligence | Double execution of `handleClientDisconnect` | Updates are conditional and idempotent. |
| Artificial Intelligence | Cross-user `operationId` collision | `operation_id` is globally unique UUID; lookups are scoped by `userId`. |
| Artificial Intelligence | Invalid `operation` payload bypasses deduction | Empty `set({})` invocation throws database constraint error. |
| Artificial Intelligence | `controller.close()` post `cancel` | Enclosed within defensive `try/catch` block. |
| Artificial Intelligence | Replay attack succeeding post commit or refund | Server returns `reserved: false`. |
| Artificial Intelligence | "Self-healing" routine in `ai-commit.ts:175-190` | Zero demonstrated security or financial impact. |
| Security Vault | Cross-account IndexedDB leakage | Storage database is strictly partitioned per user identifier. |
| Security Vault | `Math.random` used for verification challenge words | Challenge is a UX flow check; recovery phrase generated via CSPRNG. |
| Security Vault | `setMasterKey` corrupts caller buffer | Clones buffer prior to persistent allocation. |
| Security Vault | Missing RLS in migrations 0008/0010 | Database access mediated via backend with verified `userId` checks (LUGX-090). |
| Security Vault | `toggleFileEncryption` accepts empty metadata | Out of scope for unit list; subsequently proven and captured in LUGX-070. |
| Security Vault | Trust epoch check evaluates truthy value | Column defaults to integer 1 or higher. |
| Security Vault | `kekSeed` length discrepancy | Controlled experiment T3 verified parity; discrepancy caused entirely by AAD. |
| Backend & Database | Missing PostgreSQL Row Level Security (RLS) | Database is Neon PostgreSQL; Supabase is used strictly for authentication tokens. |
| Backend & Database | Open redirect in `safe-redirect.ts` | Rigorously implemented with comprehensive test validation. |
| Backend & Database | `subscription-actions.ts` exposed to client | File omits `"use server"` directive; internal server helper only. |
| Backend & Database | CSRF attack against `create-checkout` | Cookie set to `SameSite=Lax`; JSON POST yields checkout session for caller only. |
| Backend & Database | Concurrent duplicate webhook processing | Protected by `event_id UNIQUE` constraint inside transaction boundary. |
| Backend & Database | `updateUserTier` succeeds with zero rows affected | Minimal operational impact; subsumed under LUGX-027. |
| Backend & Database | `log-sanitizer` and `correlation` header flaws | No verified security vulnerability. |
| Backend & Database | `encryptedOverride.newFileId` replaces existing file | Primary key constraint prevents overwrite; remaining risk in LUGX-072. |
| Backend & Database | Test writes leak into production via `@/lib/db` | `test-db.ts` throws on connection string mismatch; remaining risk in LUGX-146. |
| Markdown Editor | `innerHTML` usage in `streaming-ghost.ts:171` | Value constrained to trusted static enum string. |
| Markdown Editor | `Compartment` instance shared across editor instances | Supported standard behavior in CodeMirror 6. |
| Markdown Editor | Folder movement cyclical dependency vulnerability | Server validates hierarchy cycles; noted as improvement in LUGX-158. |
| Markdown Editor | Duplicate rename dispatch | Could not be reproduced from source code. |
| Markdown Editor | Accessibility shortcomings in `direction-menu` | Minor UX defect outside security scope. |
| Markdown Editor | Timeout and cancellation in `pdf-worker-bridge` | Operates as designed. |
| Markdown Editor | `language-detector.ts`, `button.tsx`, `card.tsx`, `input.tsx` | Clean code; zero defects detected. |
| Markdown Editor | `deleteOcrPackage` deletion classified as confirmed bug | Downgraded to LIKELY and merged into LUGX-155. |
| Markdown Editor | Erroneous draft line numbers for PDF and workspace files | Line numbers corrected to active code lines without dropping findings. |
| Documentation | "Permanent delete deletes documents and folders" | Folders are physically stored as rows in the `files` table. |
| Documentation | "Phase 23" in `docs/README.md:101` | Milestone M6 roadmap explicitly defines Phases 21 through 24. |
| Documentation | Cross-user `operationId` collision | Query filters by both `userId` and `operationId`. |
| Documentation | Mismatched `id` and `operationId` in `updateOperationStatus` | Identical at time of record instantiation. |
| Documentation | Stripe tier quotas and price constants | Perfectly aligned with code constants. |
| Documentation | Subquery plan qualification in weekly queries (EvalPlanQual) | Speculative; handled under LUGX-030. |
| Documentation | Stale test metrics in historical logs | Explicitly designated as point-in-time snapshot records. |
| Documentation | Service Worker in `offline-sync-blueprint.md` | Architectural blueprint; backoff jitter retained in LUGX-176. |
| Documentation | Key rotation constants in `sync-api.md` | Fully aligned with active production code. |
| Infrastructure | Import resolution of `./vitest.constants.mjs` | Resolves successfully at runtime. |
| Infrastructure | Database migrations not idempotent | Wrapped in `IF NOT EXISTS` and `DO $$ EXCEPTION`; ledger absence in LUGX-076. |
| Infrastructure | Multi-statement migration execution non-atomic | Implicit transaction wrapper in PostgreSQL. |
| Infrastructure | `curl -w` combined with `-f` suppresses status code | Verified that status code is emitted; missing response body in LUGX-096. |
| Infrastructure | Load priority in `load-test-env.ts` | Operates as designed. |
| Infrastructure | Integration tests omitted from LIVE manifest | Suites use mocks; test classification is accurate. |
| Infrastructure | `rowCount` return semantics in Neon driver | Third-party driver behavior outside project scope. |
| Infrastructure | `NODE_ENV=test` during `next build` activates e2e-auth | Unverified speculation; confirmed risk captured in LUGX-179. |
| Infrastructure | Foreign key on `ai_reservations.file_id` blocks purge | Schema specifies `ON DELETE SET NULL`. |
| Infrastructure | `parent_folder_id` migration drift | Both schemas enforce `ON DELETE SET NULL`. |
| Infrastructure | Anomalous path mapping in `tsconfig.json` | Harmless compiler path alias. |
| Infrastructure | Unit test files located outside `src/test` | None currently present; latent risk captured in LUGX-088. |
| Infrastructure | `14-tenant-isolation` leaves stranded user on crash | Wrapped in cleanup `finally` block. |
| Infrastructure | Non-standard `LICENSE` terms | Verified verbatim match with standard Apache 2.0 license. |

### 7.5 Cross-Reference Matrix: Original to Consolidated Findings

| Original ID | Consolidated ID | Final Severity | Technical Notes |
|---|---|---|---|
| SYNC-01 | LUGX-003 | Critical | Client unconditionally emits 'local' resolution before dialog presentation |
| SYNC-02 | LUGX-009 | High | Optimistic write resolves conflict using stale, un-updated ETag |
| SYNC-03 | LUGX-010 | High | Dirty check bypasses mutex lock during push synchronization |
| SYNC-04 | LUGX-011 | High | ETag update committed without updating expected file version |
| SYNC-05 | LUGX-012 | High | Server sync pagination cursor advances despite uncommitted batch writes |
| SYNC-06 | LUGX-034 | Medium | Unhandled network exception permanently strands dirty file in memory |
| SYNC-07 | LUGX-013 | High | Push failure initiates destructive rollback to stale base revision |
| SYNC-08 | LUGX-014 | High | Corrupted ciphertext pushed to server overwriting valid remote version |
| SYNC-09 | LUGX-015 | High | Low-entropy PIN envelope exposed to offline brute-force attack |
| SYNC-10 | LUGX-035 | Medium | Encryption key stored in IndexedDB adjacent to ciphertext payloads |
| SYNC-11 | LUGX-016 | High | Master key export permitted via unsecured browser worker bridge |
| SYNC-12 | LUGX-036 | Medium | Version check omission enables silent remote content overwrite |
| SYNC-13 | LUGX-037 | Medium | Unhandled 3-way merge conflict silently discards remote modifications |
| SYNC-14 | LUGX-038 | Medium | Stale conflict quarantine entries never pruned from IndexedDB |
| SYNC-15 | LUGX-039 | Medium | Dirty mark applied to unmodified file triggering redundant sync cycles |
| SYNC-16 | LUGX-040 | Medium | Conflict resolution state transition lacks atomic transaction barrier |
| SYNC-17 | LUGX-041 | Medium | Client clock skew corrupts timestamp-based conflict arbitration |
| SYNC-18 | LUGX-098 | Low | Concurrency manager serialize method records start order only |
| SYNC-19 | LUGX-042 | Medium | Session key store timeout value is mutable via public method |
| SYNC-20 | LUGX-043 | Medium | Non-standard BIP-39 mnemonic wordlist ordering prevents recovery |
| SYNC-21 | LUGX-044 | Medium | Quarantined conflict record leaks plaintext filename in unencrypted field |
| SYNC-22 | LUGX-045 | Medium | Garbage collector silently purges conflict records on quota pressure |
| SYNC-23 | LUGX-099 | Low | ETag generator incorporates mutable `updatedAt` field into hash |
| SYNC-24 | LUGX-046 | Medium | Client-side deletion request fails to emit tombstone record |
| SYNC-25 | LUGX-100 | Low | Pagination cursor omits signature exposing sync to enumeration |
| SYNC-26 | LUGX-101 | Low | Sync manager logs contain sensitive file metadata in production |
| SYNC-27 | LUGX-102 | Low | Batch push requests omit per-item transaction rollback isolation |
| SYNC-28 | LUGX-103 | Low | Crypto gateway emits inconsistent error codes across browser engines |
| SYNC-29 | LUGX-104 | Low | Unbounded conflict log array causes memory bloat in long sessions |
| SYNC-30 | LUGX-105 | Low | Redundant IndexedDB connection opens degrade sync throughput |
| SYNC-31 | LUGX-106 | Low | Worker crypto fallback blocks main UI thread during PBKDF2 derivation |
| SYNC-32 | LUGX-064 | Medium | Device revocation is non-cryptographic; trust epoch read from envelope |
| SYNC-33 | LUGX-107 | Low | Offline sync queue ignores HTTP 429 Retry-After response headers |
| SYNC-34 | LUGX-108 | Low | ETag mismatch error message reveals internal database row version |
| SYNC-35 | LUGX-109 | Low | Sync status hook triggers unnecessary component re-renders |
| SYNC-36 | LUGX-110 | Low | Unsanitized file path separator in IndexedDB index key |
| SYNC-37 | LUGX-111 | Low | Local storage quota check uses inaccurate estimation formula |
| SYNC-38 | LUGX-112 | Low | Conflict dialog UI fails to present diff on non-UTF8 binary files |
| SYNC-39 | LUGX-113 | Low | Dead-letter queue lacks administrative inspection or retry interface |
| SYNC-40 | LUGX-114 | Low | Unhandled promise rejection in sync manager background heartbeat |
| AI-01 | LUGX-006 | High | Daily cron quota cleanup refunds uncommitted reservations without commit proof |
| AI-02 | LUGX-001 | Critical | Public Server Action exports permit client to claim arbitrary quota refunds |
| AI-03 | LUGX-002 | Critical | Replay attack on reservation endpoint allows quota exhaustion bypass |
| AI-04 | LUGX-007 | High | Missing input validation on reservation token units permits integer overflow |
| AI-05 | LUGX-115 | Low | Dead server actions exported without client consumer imports |
| AI-06 | LUGX-008 | High | AI route gatekeeper permits unmetered streaming on omitted `fileId` |
| AI-07 | LUGX-029 | Medium | Rapid failure rate trips circuit breaker for all users sharing model key |
| AI-08 | LUGX-116 | Low | Dead quota helper function retained in codebase without callers |
| AI-09 | LUGX-030 | Medium | Non-atomic reservation lookup and update allows concurrent quota overdraft |
| AI-10 | LUGX-031 | Medium | SSE connection termination does not dispatch abort signal to model stream |
| AI-11 | LUGX-021 | High | AI stream completion overwrites concurrent user edits via stale state closure |
| AI-12 | LUGX-117 | Low | Experimental model fallback logic disabled by default in production |
| AI-13 | LUGX-032 | Medium | API key rotation fails to remove exhausted key from active pool |
| AI-14 | LUGX-033 | Medium | Prompt injection bypasses system instruction boundary in summary tool |
| AI-15 | LUGX-118 | Low | Error response reveals upstream Gemini HTTP error details |
| AI-16 | LUGX-119 | Low | Redundant Redis roundtrip on quota check when balance is cached |
| AI-17 | LUGX-120 | Low | Rate limit response headers leak exact quota reset timestamps |
| AI-18 | LUGX-121 | Low | Model inference latency metrics emit unrounded floating point values |
| AI-19 | LUGX-122 | Low | Stream session buffer allocation lacks upper bound size check |
| AI-20 | LUGX-123 | Low | Deprecated model identifier constant retained in configuration file |
| VAULT-01 | LUGX-005 | Critical | Mnemonic seed recovery completely broken in UI due to AAD mismatch |
| VAULT-02 | LUGX-024 | High | Non-atomic read-modify-write on user vault settings allows race condition |
| VAULT-03 | LUGX-062 | Medium | Latent vault creation flaw masked behind recovery bug barrier |
| VAULT-04 | LUGX-063 | Medium | Weak password derivation iterations in fallback PBKDF2 profile |
| VAULT-05 | LUGX-015 | High | 6-digit PIN envelope susceptible to brute force; epoch in envelope |
| VAULT-06 | LUGX-064 | Medium | Device PIN revocation depends on active network sync without offline expiry |
| VAULT-07 | LUGX-065 | Medium | WebAuthn PRF credential ID stored unauthenticated in IndexedDB |
| VAULT-08 | LUGX-035 | Medium | Raw master key material cached in plain memory array without zeroization |
| VAULT-09 | LUGX-066 | Medium | Vault state reset action omits server-side session invalidation |
| VAULT-10 | LUGX-124 | Low | Key derivation salt length shorter than cryptographic recommendation |
| VAULT-11 | LUGX-125 | Low | UI challenge words generated using `Math.random` rather than CSPRNG |
| VAULT-12 | LUGX-126 | Low | Vault status indicator leaks whether vault exists prior to authentication |
| VAULT-13 | LUGX-127 | Low | Key zeroization occurs only on success; omitted in error pathways |
| VAULT-14 | LUGX-128 | Low | Master key handle identifier predictable sequence counter |
| VAULT-15 | LUGX-129 | Low | WebAuthn challenge entropy insufficient across repeated attempts |
| VAULT-16 | LUGX-130 | Low | Unused legacy encryption cipher constants retained in source |
| VAULT-17 | LUGX-131 | Low | Worker crypto communication channel lacks message origin check |
| VAULT-18 | LUGX-106 | Low | Worker timeout triggers synchronous crypto execution on main thread |
| VAULT-19 | LUGX-132 | Low | Biometric enrollment prompt lacks re-authentication confirmation |
| VAULT-20 | LUGX-085 | Medium | AI encryption gatekeeper allows bypass when `fileId` parameter is null |
| VAULT-21 | LUGX-133 | Low | AAD mismatch throws generic error rather than typed `IntegrityError` |
| BACKEND-01 | LUGX-067 | Medium | Latent unauthenticated server action pruned by compiler treeshaking |
| BACKEND-02 | LUGX-025 | High | Stripe webhook handler returns HTTP 200 on internal database failures |
| BACKEND-03 | LUGX-026 | High | Stripe webhook processes out-of-order events without timestamp validation |
| BACKEND-04 | LUGX-027 | High | Single active subscription row constraint corrupts multi-plan upgrades |
| BACKEND-05 | LUGX-027 | High | Customer lookup relies on unverified client metadata instead of mapping table |
| BACKEND-06 | LUGX-068 | Medium | Webhook handler drops unhandled Stripe events without audit logging |
| BACKEND-07 | LUGX-069 | Medium | Subscription cancellation fails to immediately revoke pro-tier quota |
| BACKEND-08 | LUGX-134 | Low | Unused manual payment method webhook branch unhandled |
| BACKEND-09 | LUGX-070 | Medium | Server accepts ciphertext payload accompanied by null encryption metadata |
| BACKEND-10 | LUGX-071 | Medium | PUT endpoint accepts plaintext file content for encrypted file records |
| BACKEND-11 | LUGX-072 | Medium | File copy Server Action duplicates encrypted metadata with new owner ID |
| BACKEND-12 | LUGX-073 | Medium | Move file action fails to validate target directory parent folder cycle |
| BACKEND-13 | LUGX-074 | Medium | Soft-delete folder action fails to recursively mark nested child documents |
| BACKEND-14 | LUGX-075 | Medium | User profile update action accepts arbitrary unvalidated JSON attributes |
| BACKEND-15 | LUGX-076 | Medium | Migration directory lacks baseline snapshot and migration tracking ledger |
| BACKEND-16 | LUGX-077 | Medium | Production build includes test authentication route `/api/test/e2e-auth` |
| BACKEND-17 | LUGX-078 | Medium | Database integration test suite runs without schema isolation across workers |
| BACKEND-18 | LUGX-135 | Low | Webhook signature verification fails to reject expired timestamp tolerance |
| BACKEND-19 | LUGX-079 | Medium | Redis rate limiter fails open on connection timeout or network partition |
| BACKEND-20 | LUGX-136 | Low | Cron route secret comparison uses non-constant-time equality operator |
| BACKEND-21 | LUGX-137 | Low | Database connection pool limits unconfigured in serverless environment |
| BACKEND-22 | LUGX-059 | Medium | File import size limit documented at 10 MB but server action rejects >1 MB |
| BACKEND-23 | LUGX-138 | Low | Unhandled database unique constraint violation returns raw SQL error string |
| BACKEND-24 | LUGX-139 | Low | CORS headers permit wildcard origins on internal diagnostic endpoint |
| BACKEND-25 | LUGX-140 | Low | Session cookie configuration lacks explicit `SameSite=Strict` flag |
| BACKEND-26 | LUGX-141 | Low | Stripe customer ID lookup query lacks index on `stripe_customer_id` |
| BACKEND-27 | LUGX-142 | Low | Inconsistent ISO timestamp format returned across file list API endpoints |
| BACKEND-28 | LUGX-143 | Low | Unindexed query on `files.parent_folder_id` degrades directory listing |
| BACKEND-29 | LUGX-144 | Low | Dynamic import of PDF parser module triggers repeated disk read cycles |
| BACKEND-30 | LUGX-145 | Low | Stripe integration tests rely on static mocks without webhook validation |
| BACKEND-31 | LUGX-146 | Low | Database cleanup script drops production tables if test env misconfigured |
| BACKEND-32 | LUGX-147 | Low | Server Action integration tests lack authentication context isolation |
| BACKEND-33 | LUGX-148 | Low | Webhook processing metric fails to record processing latency duration |
| BACKEND-34 | LUGX-149 | Low | Deprecated Stripe API version pinned in backend client configuration |
| EDITOR-01 | LUGX-004 | Critical | Plaintext content saved to IndexedDB alongside `isEncrypted: true` flag |
| EDITOR-02 | LUGX-017 | High | Decryption failure exposes raw base64 ciphertext in editable editor state |
| EDITOR-03 | LUGX-018 | High | PDF text extraction silently falls back to empty string on corrupted file |
| EDITOR-04 | LUGX-019 | High | Context menu decryption action discards modified content without warning |
| EDITOR-05 | LUGX-020 | High | Editor orchestrator resets `expectedVersion` to 1 while document is dirty |
| EDITOR-06 | LUGX-021 | High | AI ghost text completion replaces user edits made during inference stream |
| EDITOR-07 | LUGX-022 | High | Conflict dialog cancelation leaves editor in dirty un-synchronizable state |
| EDITOR-08 | LUGX-023 | High | Vault lock event unmounts editor discarding unsaved in-memory changes |
| EDITOR-09 | LUGX-047 | Medium | CodeMirror 6 compartment reconfiguration triggers cursor jump to line 1 |
| EDITOR-10 | LUGX-048 | Medium | Decryption error toast lacks action button to retry or recover document |
| EDITOR-11 | LUGX-049 | Medium | Multi-tab editor session lacks cross-tab lock causing silent write collision |
| EDITOR-12 | LUGX-050 | Medium | Editor dirty state indicator out of sync with actual IndexedDB storage state |
| EDITOR-13 | LUGX-051 | Medium | Rapid keyboard input during sync push triggers duplicate change events |
| EDITOR-14 | LUGX-052 | Medium | Document reload replaces active editor content without unsaved prompt |
| EDITOR-15 | LUGX-053 | Medium | Find-and-replace executes case-sensitive match ignoring regex flag toggle |
| EDITOR-16 | LUGX-054 | Medium | Replace-all operation corrupts markdown formatting across line boundaries |
| EDITOR-17 | LUGX-055 | Medium | Encrypted file export downloads raw ciphertext file with `.md` extension |
| EDITOR-18 | LUGX-056 | Medium | Paste event handler strips markdown formatting tags in bilingual text |
| EDITOR-19 | LUGX-057 | Medium | Unhandled exception in syntax highlighter crashes editor component tree |
| EDITOR-20 | LUGX-058 | Medium | Arabic text normalizer reverses markdown punctuation in list items |
| EDITOR-21 | LUGX-059 | Medium | Large document import crashes browser tab due to synchronous tokenization |
| EDITOR-22 | LUGX-060 | Medium | PDF preview worker bridge leaks object URL references across page changes |
| EDITOR-23 | LUGX-061 | Medium | Word counter utility reports divergent counts between client and server |
| EDITOR-24 | LUGX-150 | Low | Route param change remounts workspace resetting custom zoom level |
| EDITOR-25 | LUGX-151 | Low | RTL direction toggle fails to update CodeMirror line number gutter alignment |
| EDITOR-26 | LUGX-152 | Low | Unused `validateFileBuffer` helper retained in parser module |
| EDITOR-27 | LUGX-153 | Low | Markdown table formatter corrupts cells containing escaped pipe characters |
| EDITOR-28 | LUGX-154 | Low | Editor toolbar keyboard shortcut conflicts with standard browser shortcuts |
| EDITOR-29 | LUGX-155 | Low | OCR language package download cache lacks automatic cleanup routine |
| EDITOR-30 | LUGX-156 | Low | Streaming ghost text animation stutters on high-frequency chunk arrivals |
| EDITOR-31 | LUGX-157 | Low | Editor adapter readiness callback triggered before DOM node attached |
| EDITOR-32 | LUGX-158 | Low | Tree view drag-and-drop allows dropping folder onto itself |
| DOCS-01 | LUGX-035 | Medium | Documentation claims "Zero Plaintext At-Rest" contradicted by storage |
| DOCS-02 | LUGX-079 | Medium | Documentation claims fail-closed limiting while rate limiter fails open |
| DOCS-03 | LUGX-077 | Medium | Documentation claims test auth disabled in production but route is bundled |
| DOCS-04 | LUGX-030 | Medium | Quota settlement architecture documented as atomic while code is non-atomic |
| DOCS-05 | LUGX-080 | Medium | API documentation omits mandatory authentication headers on sync routes |
| DOCS-06 | LUGX-081 | Medium | Database schema documentation omits critical indexes and foreign keys |
| DOCS-07 | LUGX-082 | Medium | Architecture document describes obsolete TipTap editor instead of CM6 |
| DOCS-08 | LUGX-083 | Medium | Security architecture guide references deprecated PBKDF2 iteration counts |
| DOCS-09 | LUGX-084 | Medium | Vault documentation claims non-extractable keys while keys are raw bytes |
| DOCS-10 | LUGX-085 | Medium | AI gatekeeper documentation claims route barrier while `fileId` is optional |
| DOCS-11 | LUGX-058 | Medium | Markdown parser specification contradicts actual normalization behavior |
| DOCS-12 | LUGX-086 | Medium | CI gating documentation describes automated verification tests that pass vacantly |
| DOCS-13 | LUGX-087 | Medium | Rate limit tier tables in docs contradict active limits configured in code |
| DOCS-14 | LUGX-088 | Medium | Test metric summary in docs derived from self-referential reporting script |
| DOCS-15 | LUGX-089 | Medium | Sync conflict protocol documentation contradicts UI resolution semantics |
| DOCS-16 | LUGX-090 | Medium | Security model claims Row Level Security (RLS) enforcement on database |
| DOCS-17 | LUGX-159 | Low | Broken relative markdown links across documentation files |
| DOCS-18 | LUGX-160 | Low | Outdated developer onboarding setup commands in `README.md` |
| DOCS-19 | LUGX-161 | Low | Undocumented environment variables required for full feature operation |
| DOCS-20 | LUGX-162 | Low | Inaccurate description of Stripe webhook verification setup steps |
| DOCS-21 | LUGX-163 | Low | Outdated architecture diagrams depicting deleted microservice components |
| DOCS-22 | LUGX-164 | Low | Spelling and grammatical errors across technical API references |
| DOCS-23 | LUGX-165 | Low | Missing troubleshooting guide for common IndexedDB quota errors |
| DOCS-24 | LUGX-166 | Low | Contradictory code comments regarding thread safety in crypto bridge |
| DOCS-25 | LUGX-167 | Low | Incomplete changelog entries omitting major security patch details |
| DOCS-26 | LUGX-168 | Low | Deprecated API parameters listed as required in endpoint documentation |
| DOCS-27 | LUGX-169 | Low | Tracked test environment files documented with production secret names |
| DOCS-28 | LUGX-170 | Low | Missing JSDoc documentation on exported cryptographic helper utilities |
| DOCS-29 | LUGX-171 | Low | Stale dependency versions referenced in build documentation |
| DOCS-30 | LUGX-172 | Low | Undocumented HTTP error response schemas in sync REST documentation |
| DOCS-31 | LUGX-173 | Low | Contradictory retention period guidelines for server operation logs |
| DOCS-32 | LUGX-174 | Low | Inconsistent terminology between "vault passphrase" and "master key" |
| DOCS-33 | LUGX-175 | Low | Missing licensing notices for vendored third-party PDF parser assets |
| DOCS-34 | LUGX-176 | Low | Offline sync blueprint describes Service Worker not implemented in code |
| DOCS-35 | LUGX-001 | Critical | Documentation describes client-side refund action as secure API |
| DOCS-36 | LUGX-177 | Low | Missing documentation on minimum supported browser version matrix |
| INFRA-01 | LUGX-091 | Medium | CI workflow runs with excessive default permissions across jobs |
| INFRA-02 | LUGX-076 | Medium | GitHub Actions workflow ignores schema drift and migration discrepancies |
| INFRA-03 | LUGX-092 | Medium | Stale build artifacts cached across CI pipeline runs without hash check |
| INFRA-04 | LUGX-028 | High | E2E test suite executes against mock storage rather than live database |
| INFRA-05 | LUGX-093 | Medium | Upstash Redis connection lacks TLS certificate verification in production |
| INFRA-06 | LUGX-086 | Medium | CI gating script passes when test output contains skipped or vacuous suites |
| INFRA-07 | LUGX-076 | Medium | Migration script executes against unverified database URL target |
| INFRA-08 | LUGX-094 | Medium | Production deployment script lacks automatic rollback on healthcheck fail |
| INFRA-09 | LUGX-077 | Medium | E2E test authentication route included in production Next.js build output |
| INFRA-10 | LUGX-095 | Medium | Missing Content Security Policy (CSP) headers expose application to XSS |
| INFRA-11 | LUGX-096 | Medium | Healthcheck script suppresses failure output masking server crash causes |
| INFRA-12 | LUGX-097 | Medium | Dependabot configuration omits automated security vulnerability scanning |
| INFRA-13 | LUGX-169 | Low | `.env.test` file checked into repository containing mock secrets |
| INFRA-14 | LUGX-178 | Low | Vitest configuration file parallelism disabled with `@ts-expect-error` |
| INFRA-15 | LUGX-179 | Low | Production Dockerfile runs application process as root user |
| INFRA-16 | LUGX-180 | Low | CI `cancel-in-progress` cancels release gate runs on main branch |
| INFRA-17 | LUGX-088 | Medium | CI metrics reporting script calculates test coverage from filtered subset |
| INFRA-18 | LUGX-159 | Low | Markdown link checker script skips links inside HTML comments |
| INFRA-19 | LUGX-181 | Low | `.env.example` contains malformed protocol URLs and default secret values |
| INFRA-20 | LUGX-182 | Low | Package script uses ignored `allowScripts` and ESLint warnings pass CI |
| INFRA-21 | LUGX-183 | Low | NOTICE file imposes attribution requirements exceeding Apache 2.0 terms |

---

*End of Unified Security and Engineering Audit Report.*
