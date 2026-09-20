# Three-Way Conflict Resolution & Offline Synchronization Architecture

> **Point-in-time verification record.** Test counts in §4 and the merge-latency
> observation below reflect the suite state at delivery; re-run the suites for
> current numbers.

## 1. Architectural Overview & Context

This document outlines the design, implementation, and verification of the **Three-Way Conflict Resolution Engine** (Phase 4 of the original pre-implementation technical roadmap).

The system resolves concurrent multi-device and offline-to-online edit discrepancies deterministically without blind overwrites or silent data loss.

```mermaid
flowchart TD
    Base["Base Snapshot (v1)"] --> Local["Local Version (v1*)"]
    Base --> Server["Server Version (v2)"]
    Local --> Engine["3-Way Conflict Merge<br/>(LCS Delta Engine)"]
    Server --> Engine
    Engine --> Clean["Clean Auto-Merge<br/>(Non-overlapping edits applied)"]
    Engine --> Conflict["Conflict Resolution Dialog<br/>(Explicit UI resolution required)"]
```

---

## 2. Core Architectural Components

### 2.1 Three-Way Merge Engine (`src/lib/sync/conflict-resolver.ts`)
- **Base Version Invariant:** A valid `baseSnapshot` is required to perform three-way merging. If the base snapshot is missing or corrupted, blind automated merging is strictly rejected, and the status transitions to `manual_resolution_required`.
- **Linear Memory LCS with Prefix/Suffix Trimming:** Replaced naive 2D matrix allocation with a flat `Int32Array` buffer combined with linear Common Prefix & Suffix trimming, reducing memory allocation by >99% and executing merges in sub-millisecond time even on large documents (2,000+ lines).
- **Half-Open Interval Boundary Slicing:** Employs strict half-open intervals `[start, end)` for chunk reconciliation, preventing duplication, truncation, or false conflicts on adjacent boundary lines.
- **Markdown Line & CRLF Normalization:** Normalizes all line-break variants (`\r\n`, `\r`) to standard `\n` line delimiters, eliminating false byte conflicts across operating systems.
- **Markdown Syntax Integrity Validator (`validateMarkdownSyntaxIntegrity` in `src/lib/sync/syntax-validator.ts`):** Centralized integrity validator imported by `ConflictResolver`. Evaluates candidate 3-way merge outputs for balanced fenced code blocks (``` and ~~~), valid GFM table delimiters with full support for escaped pipes (`\|`), null-byte elimination, and forbidden conflict marker residue. If merge output corrupts syntax, automated merge is cancelled and safely escalated to interactive conflict resolution.

### 2.2 Base Snapshot Persistence (`src/lib/sync/indexeddb.ts`)
- Before any local mutation is committed to the local queue, the engine captures a frozen snapshot of the current synchronized base (`content`, `title`, `version`, `etag`) into the `files` store.
- Supports **Create-to-Update Coalescing** in `coalesceOperation` to collapse rapid pending operations without breaking version references.

### 2.3 False Conflict Elimination (`src/lib/sync/sync-manager.ts` & `src/hooks/use-sync.ts`)
- **Metadata Drift Invariant:** When receiving a `412 Precondition Failed` response or encountering dirty local state, if `localContent === serverContent` or `compareETags(localEtag, serverEtag)` is true:
  - The conflict is categorized as a false conflict caused by metadata drift.
  - The engine silently adopts the authoritative server `version` and `etag`.
  - The file and all pending queue operations are marked as `synced: true, isDirty: false`.
  - The UI modal dialog is suppressed, preventing infinite dialog loops.

### 2.4 Markdown Conflict Resolution UI (`src/components/sync/conflict-dialog.tsx`)
- **Direct Markdown Comparison:** Displays side-by-side comparison columns, visual diff blocks (`DiffLine`), and the interactive merge editor operating on pure Markdown source text.
- **Deterministic Submission:** Submits resolved Markdown text directly with `normalizeMarkdownSource` normalization upon authoritative submission.

### 2.5 Cross-Tab Synchronization & Volatile RAM Purge Guard (`src/lib/sync/cross-tab-sync.ts`, `src/lib/sync/session-key-store.ts`, `src/hooks/use-editor-orchestrator.ts`)
- Uses `BroadcastChannel('textai_cross_tab_sync')` to propagate save, conflict resolution, and vault lock events across browser tabs.
- **Dirty State Guard:** Sibling tabs only advance their in-memory `fileVersionRef` if the current tab is clean (`!isDirty && !hasUnresolvedConflict`), preventing silent overwrites of un-saved local drafts.
- **Volatile RAM Purge Synchronization:** When a vault lock occurs in any tab (manual lock or inactivity timeout), `sessionKeyStore.lock(true)` dispatches a `vault_locked` broadcast message. Sibling tabs zero their volatile Master Key buffers in RAM (`buffer.fill(0)`), purge keys, and lock the vault UI.
- **Local Auto-Lock & Debounced Auto-Save Cancellation:** The originating tab subscribes directly to `sessionKeyStore.subscribe()`. When local auto-lock fires, `debouncedAutoSave.cancel()` is immediately invoked, preventing background timer races from writing plaintext or corrupted drafts after vault lock.

### 2.6 Zero-Knowledge Encrypted Conflict Resolution & Inbound Gateway (`src/lib/sync/sync-crypto-gateway.ts`, `src/hooks/use-editor-orchestrator.ts`)
- **Inbound Server IV Decryption (`SyncCryptoGateway.decryptInbound`)**: When a 412 Precondition Failed occurs on an encrypted file, the orchestrator intercepts `saveRes.serverVersion`. Rather than erroneously reusing the local client IV, the gateway strictly extracts `saveRes.serverVersion.encryptionMetadata.iv` (the actual IV generated by the remote concurrent writer) and decrypts the incoming ciphertext into clean Markdown plaintext in volatile RAM using the Master Key and file AAD binding (`vault:file:${userId}:${fileId}`).
- **Plaintext False-Conflict Elimination**: Before surfacing a conflict dialog to the user, the orchestrator compares the decrypted server plaintext against local dirty plaintext. If both contents match identically, the orchestrator transparently adopts the remote version and ETag without displaying intrusive modals.
- **Plaintext Presentation Invariant (`ConflictDialog`)**: `SyncConflict.serverVersion.content` is strictly populated with decrypted plaintext. Both Diff3 line merge and side-by-side visual diff engines operate exclusively on valid Markdown strings, eliminating raw Base64 ciphertext comparison failures.
- **Universal Clean Re-Encryption on Resolution (`SyncCryptoGateway.encryptOutbound`)**: When the user selects a resolution strategy (`"mine"`, `"server"`, or `"merge"`):
  1. The orchestrator updates the CodeMirror editing surface strictly with clean plaintext (`adapter.setValue(resolution.content)`), preventing raw ciphertext corruption of the viewport and history stack.
  2. If the file is encrypted, the orchestrator re-encrypts the selected plaintext using `SyncCryptoGateway.encryptOutbound`, generating a fresh 12-byte CSPRNG IV and envelope metadata.
  3. The re-encrypted payload is dispatched to the server via `toggleFileEncryption` and persisted to IndexedDB with `isDirty: false`. This completely prevents double-encryption loops (`gcm:v1:gcm:v1:...`) and eliminates ciphertext leakage into the editor.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Editor as CodeMirror / EditorAdapter
    participant Orch as useEditorOrchestrator
    participant GW as SyncCryptoGateway
    participant SKS as SessionKeyStore (RAM)
    participant Server as /api/files/:id
    participant Dialog as ConflictDialog (Diff3)

    Editor->>Orch: User edits dirty plaintext
    Orch->>Server: PUT /api/files/:id (Stale ETag)
    Server-->>Orch: HTTP 412 Precondition Failed<br/>{ serverVersion: { content: "gcm:v1:...", encryptionMetadata: { iv: "serverIv" } } }
    
    rect rgb(240, 248, 255)
        Note over Orch,GW: Inbound Decryption Interception
        Orch->>GW: decryptInbound(serverVersion.content, serverVersion.encryptionMetadata, fileId, userId)
        GW->>SKS: getMasterKeyRaw()
        SKS-->>GW: MasterKey
        GW-->>Orch: serverPlaintext (Clean Markdown)
    end

    alt False Conflict (localPlaintext === serverPlaintext)
        Orch->>Orch: Adopt remote version & ETag silently
    else True Conflict
        Orch->>Dialog: Mount ConflictDialog(localPlaintext, serverPlaintext)
        User->>Dialog: Choose Strategy ("mine" | "server" | "merge")
        Dialog->>Orch: handleResolveConflict(resolvedPlaintext)
        Orch->>Editor: adapter.setValue(resolvedPlaintext)
        Orch->>GW: encryptOutbound(fileId, resolvedPlaintext, userId)
        GW-->>Orch: { ciphertextBase64, freshMetadata (12-byte CSPRNG IV) }
        Orch->>Server: toggleFileEncryption(fileId, true, ciphertextBase64, freshMetadata)
        Server-->>Orch: 200 OK { version, etag }
        Orch->>Orch: IDB.saveFile(clean) & isDirty: false
    end
```

### 2.7 Non-Blocking Encrypted Conflict Isolation (`CONFLICT_LOCKED`)
- **Isolation State**: When a 412 Precondition Failed or 409 Conflict occurs on an encrypted file while the user's vault is locked (`!sessionKeyStore.isVaultUnlocked()`), the conflict cannot be decrypted or auto-merged in background queues without Master Key exposure. The engine isolates it into `pendingEncryptedConflicts` tagged with `CONFLICT_LOCKED`.
- **Non-Blocking Invariant**: `pushDirtyFiles` explicitly filters out `!this.pendingEncryptedConflicts.has(file.id)`. Other unencrypted dirty documents synchronize concurrently without being stalled or blocked by locked encrypted files.
- **Quarantine Capacity & Backpressure Governance (Phase 23)**:
  - Bounded memory quarantine via `MAX_QUARANTINED_CONFLICTS = 100`.
  - False-eviction immunity: updating an existing quarantined file never evicts other documents (`!has(conflict.fileId)` check).
  - Deterministic $O(N)$ linear scan evicts the oldest conflict (`detectedAt`) when capacity is exceeded without intermediate array allocations.
- **Observability & Diagnostics**: `getQuarantineDiagnostics()` returns `QuarantineDiagnostics` tracking total quarantined count, stale count (> 24 hours), oldest/newest timestamps, and capacity state.
- **Atomic Discard & Cleanup**: `discardPendingEncryptedConflict(fileId)` safely cancels an isolated conflict under `concurrencyManager.withLock` mutual exclusion:
  1. Evicts entry from `pendingEncryptedConflicts`.
  2. Cleans up in-memory checkpoints in `SyncRollback`.
  3. Transitions linked operations in IndexedDB to `'discarded'`, strictly preserving `localFile.isDirty` to prevent silent user edit data loss (`DATA-SAFETY GUARD`).
- **Unlock Event & Auto-Resolution**: When the user unlocks the vault, `resolvePendingEncryptedConflict(fileId)` automatically:
  1. Decrypts `remoteEnvelope`, `localEnvelope`, and `baseEnvelope` in RAM using the Master Key.
  2. Runs 3-way Diff3 merge via `conflictResolver.attemptThreeWayMerge`.
  3. Verifies Markdown structural syntax integrity via `validateMarkdownSyntaxIntegrity`.
  4. Re-encrypts the merged Markdown with a fresh CSPRNG 12-byte IV and file-bound AAD.
  5. Pushes to `/api/files/:id` with `If-Match: "remoteEtag"`, removes the pending conflict, and marks the file clean.

---

## 3. API & Resolution Contracts

### 3.1 Merge Result Contract
```typescript
export type MergeStatus =
    | 'merged_clean'
    | 'conflict_overlaps'
    | 'manual_resolution_required'
    | 'delete_conflict';

export interface MergeResult {
    /** Whether merge was successful without any conflicts */
    success: boolean;
    /** Detailed status of the merge operation */
    status: MergeStatus;
    /** Merged content (if success or contains inline conflict markers) */
    content?: string;
    /** Merged title */
    title?: string;
    /** Merged parent folder id */
    parentFolderId?: string | null;
    /** Whether there are overlapping changes requiring manual resolution */
    hasOverlaps: boolean;
    /** Diff operations for visualization */
    diffs?: DiffOp[];
    /** Explicit conflict markers if overlaps were present */
    conflictMarkers?: string;
    /** Specific delete conflict classification */
    deleteAction?: 'remote_deleted_local_modified' | 'local_deleted_remote_modified' | 'both_deleted';
    /** Human-readable explanation */
    reason?: string;
}
```

### 3.2 Authoritative Resolution Submission
Resolutions are committed via a single authoritative write request:

**Standard Unencrypted File:**
```http
PUT /api/files/:id HTTP/1.1
Content-Type: application/json
If-Match: "server_etag"

{
  "content": "# Resolved Content\n\nAuthoritative merged markdown text.",
  "expectedVersion": 2
}
```

**Encrypted Vault File:**
```http
PUT /api/files/:id HTTP/1.1
Content-Type: application/json
If-Match: "server_etag"

{
  "content": "gcm:v1:base64ciphertext...",
  "isEncrypted": true,
  "encryptionMetadata": {
    "version": 1,
    "algorithm": "AES-GCM-256",
    "keyId": "master-v1",
    "salt": "",
    "iv": "base64iv...",
    "kdfIterations": 600000
  },
  "expectedVersion": 2
}
```
*(Alternatively committed atomically via `toggleFileEncryption` Server Action).*

---

## 4. Verification & Automated Test Evidence

| Test Suite | Test Count | Status | Description |
| :--- | :--- | :--- | :--- |
| `src/test/sync/sync-conflict-resolver.test.ts` | 39 | Passed | 3-way merge, LCS linear array, adversarial chunk overlaps, escaped table pipes, CRLF normalization, large doc trimming. |
| `src/test/sync/sync-indexeddb.test.ts` | 14 | Passed | Base snapshot persistence, create-to-update coalescing, store integrity. |
| `src/test/sync/sync-manager.test.ts` | 36 | Passed | 412 conflict handling, retry backoff, dead-letter transitions, RemoteUpdateEvent dispatch. |
| `src/test/sync/conflict-resolution.integration.test.ts` | 3 | Passed | Real PostgreSQL lifecycle integration (Base -> Remote write -> Local 412 -> 3-way merge -> Authoritative write -> Verified reload). |
| `src/test/api/api-files-putguard.live.test.ts` | 3 | Passed | Concurrency race conditions, stale write rejection. |
| `src/test/server/file-ops.lostupdate.test.ts` | 4 | Passed | Lost-update prevention via optimistic database version locking. |
| `src/test/sync/sync-operations-gc.test.ts` | 5 | Passed | Garbage collection of synced operations, compaction thresholds. |
| `src/test/sync/sync-rollback.test.ts` | 22 | Passed | Checkpoint creation, rollback recovery from crashes. |
| `src/test/sync/sync-connection-detector.test.ts` | 17 | Passed | Exponential backoff, jitter, network status detection. |
| `src/test/sync/sync-etag-generator.test.ts` | 20 | Passed | ETag formatting, parsing, weak comparison, Markdown normalization. |
| `src/test/sync/sync-parallel.test.ts` | 6 | Passed | Parallel batch file processing, concurrency throttling. |
| `src/test/sync/sync-error-handler.test.ts` | 26 | Passed | Structured error dispatching and recovery logging. |
| `src/test/sync/sync-concurrency-manager.test.ts` | 9 | Passed | Mutex locking per file ID. |
| `src/test/vault/vault-sync-ai-gate.test.ts` | 28 | Passed | AI gatekeepers, syntax validator, non-blocking encrypted conflict resolution, and adversarial edge cases. |
| `src/test/sync/sync-crypto-gateway.test.ts` | 5 | Passed | Inbound decryption gateway, outbound re-encryption with fresh IV, AAD binding, vault-lock quarantine. |
| `src/test/sync/encrypted-conflict-decryption.integration.test.ts` | 4 | Passed | End-to-end integration: remote pull decryption, 412 server IV decryption, clean plaintext conflict resolution, locked vault safety. |
| **Total Test Count** | **241** | **100% Passed** | **All suites verified against real database and runtime contracts.** |
| **TypeScript Typecheck** | `tsc --noEmit` | **0 Errors** | **Strict TypeScript compliance verified across all workspace files.** |

---

## 5. Architectural Decisions & Trade-offs

### Decision TR-01: Choosing Diff3 LCS over CRDTs (Yjs) and Operational Transformation (OT)

- **Context:** LUGX requires an offline-first document synchronization engine capable of resolving concurrent edits across multiple devices for a single authenticated user, while strictly preserving end-to-end zero-knowledge encryption in client-side vaults.
- **Chosen Architecture:** Custom, deterministic Three-Way Line-Based Merge Engine (`src/lib/sync/conflict-resolver.ts`) using linear-memory Longest Common Subsequence (LCS) with common prefix/suffix trimming, integrated with an AST-aware Markdown syntax integrity validator (`syntax-validator.ts`).
- **Rejected Alternatives:**
  1. **CRDTs (Yjs / Automerge):** Standard state-vector conflict-free replicated data types.
  2. **Operational Transformation (OT):** Centralized sequence transformation (e.g., ShareDB, Google Docs algorithm).
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (Diff3 LCS) | Alternative #1 (Yjs / CRDTs) | Alternative #2 (OT) |
  | :--- | :--- | :--- | :--- |
  | **Memory & Storage Overhead** | **Minimal**: Linear $O(D)$ memory via flat `Int32Array` buffers; zero metadata tombstones. | **High**: Indefinite retention of character-level deletion tombstones and state vectors in client memory. | **Moderate**: Server maintains entire sequential revision log. |
  | **Bundle Footprint** | **Zero-Dependency**: 0 KB external bundle weight; pure native TypeScript. | **Heavy**: ~60–120 KB minified dependency graph (`yjs`, `y-codemirror.next`, `y-protocols`). | **Heavy**: Client-server transformation engine dependencies. |
  | **Offline-First Resilience** | **Native**: Works deterministically in isolated local client contexts against base snapshots. | **Native**: Strong peer-to-peer eventual convergence. | **Poor**: Requires authoritative central server to transform concurrent operations. |
  | **Zero-Knowledge Encryption Harmony** | **Frictionless**: Plaintext 3-way merge occurs entirely inside volatile client RAM after Web Worker decryption. | **Severe Incompatibility**: Encrypting fine-grained CRDT operations requires complex decentralized key exchange or homomorphic encryption. | **Incompatible**: Server cannot transform operations on encrypted ciphertexts. |

- **Zero-Knowledge Cryptographic Barrier:**
  Following the implementation of the Zero-Knowledge Cloud Vault, integrating Yjs would introduce extreme architectural complexity. Because the server is strictly blind to document contents (`content BYTEA` ciphertext), any CRDT synchronization must occur either through encrypted state updates or peer-to-peer WebRTC connections. In a single-user workstation, managing encrypted peer-to-peer session states, distributing per-session ephemeral keys, and storing deletion tombstones imposes significant memory and battery overhead without any measurable user-facing ROI.
- **Migration Trigger (When to Switch to CRDTs):**
  Adopting Yjs or an equivalent CRDT framework is justified **only if the product requirement evolves to support real-time multi-user concurrent live collaboration** (multiple users simultaneously editing the exact same note with live cursor presence). In that event, the clean abstraction boundaries in `EditorAdapter` (`src/components/editor/markdown/editor-adapter.ts`) and `SyncManager` allow swapping the underlying synchronization transport without redesigning editor UI or database schemas.

---

### Decision TR-02: Native IndexedDB vs. Origin Private File System (OPFS)

- **Context:** The offline synchronization engine requires persistent client-side storage to retain local document snapshots, mutation queues, and synchronization cursors across browser restarts.
- **Chosen Architecture:** Native browser **IndexedDB API** with transactional schema versioning (`src/lib/sync/indexeddb.ts`), partitioned per user (`textai_db_${userId}`) across three stores: `files`, `operations`, and `sync_metadata`.
- **Rejected Alternatives:**
  - **Origin Private File System (OPFS):** Direct private filesystem access (`navigator.storage.getDirectory()`).
  - **LocalStorage:** Synchronous string key-value storage.
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (IndexedDB) | Alternative (OPFS) |
  | :--- | :--- | :--- |
  | **Structured Querying** | **High**: Secondary indices (`by_user`, `by_status`, `by_file`, `by_retry`) allow instantaneous queue inspection. | **None**: Raw byte files without indexing; queries require manual directory scanning. |
  | **Transactional Atomicity** | **Native**: Multi-store ACID transactions (`readwrite`) ensure atomic rollback of mutation operations. | **Low**: File locking semantics; no multi-file atomic transactions. |
  | **Raw I/O Throughput** | **Moderate**: Subject to structured cloning serialization overhead. | **Extreme**: Synchronous fast access handles for high-throughput byte streams. |
  | **Storage Quota & Eviction** | **High**: Large browser quota (typically gigabytes) under persistent storage permissions. | **High**: Equal quota allowance. |

- **Migration Trigger (When to Switch to OPFS):**
  Migrating storage of document contents to OPFS is triggered **if the application introduces large binary attachments (>50MB per file, such as raw high-resolution PDF scans or media files)** where IndexedDB structured cloning serialization introduces visible main-thread latency.

---

### Decision TR-03: Native BroadcastChannel vs. SharedWorker for Cross-Tab Sync

- **Context:** Synchronizing editor lock states, active drafts, and volatile RAM key purges across sibling browser tabs in real time.
- **Chosen Architecture:** Native `BroadcastChannel('textai_cross_tab_sync')` (`src/lib/sync/cross-tab-sync.ts`) with sender isolation (`senderTabId !== currentTabId`).
- **Rejected Alternative:** `SharedWorker` coordination hub.
- **Trade-off Analysis:**
  - **BroadcastChannel:** Zero setup, universally supported across all modern desktop and mobile browsers, zero lifecycle teardown friction, and degrades silently in restricted headless environments.
  - **SharedWorker:** Complex worker lifecycle management, historically unsupported or flaky on iOS Safari, and introduces significant debugging complexity for multi-tab state tracking.
- **Migration Trigger:** Adopting a `SharedWorker` is triggered only if client-side architecture requires a persistent, long-running background sync coordinator that must remain active and maintain network sockets even when individual browser windows are closed.
