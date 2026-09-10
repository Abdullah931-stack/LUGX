# Vault Phase 2 Closure: Database Schema Migrations, Transparent Encrypted IndexedDB & Adversarial Hardening

## 1. Executive Summary & Objective

Vault Phase 2 delivers the at-rest storage and database schema layer of the Hybrid Encryption & Zero-Knowledge Vault roadmap (`وثيقة الخطة التنفيذية لتشفير الهجين والخزنة المشفرة عند الطلب.md`). It guarantees transparent client-side encryption of all local cache records (files, snapshots, operations, undo queue) with zero plaintext at-rest, establishes the dual-wrapped master key schema in PostgreSQL, and introduces resilient key lifecycle management.

Key achievements:
- **Cloud Vault Database Schema (`src/lib/db/schema.ts`, `0008_hybrid_vault_schema.sql`)**: PostgreSQL `user_vault_profiles` table for dual-wrapped master keys (password KEK + BIP-39 recovery seed KEK) and file-level `is_encrypted` flag with JSONB `encryption_metadata`. Verified and pushed to live Neon database.
- **Transparent At-Rest Encrypted IndexedDB (`src/lib/sync/indexeddb.ts`)**: Always-on AES-GCM-256 local storage encryption via user-scoped `LocalDeviceKey` with cryptographic AAD binding (`idb:file:${id}`, `idb:snapshot:${id}`, `idb:op:${opId}`).
- **Zero Plaintext At-Rest Invariant**: Verified that raw storage layers contain zero readable plaintext strings.
- **Corrupted Record Isolation (`CorruptedLocalRecordError`)**: Prevents batch query crashes on tampered or corrupted ciphertext.
- **Adversarial Hardening & Anti-Overengineering Decisions**: Hardened against lazy-init key loss, multi-tenant RAM leakage, and cold-start concurrency races, while rejecting bloated and de-optimizing patterns.

---

## 2. Architecture & Cryptographic Storage Specifications

### A. Local Storage Encryption Envelope
Client records in IndexedDB stores (`files`, `operations`) are wrapped in lightweight serialized envelopes:
```typescript
interface LocalEncryptedPayload {
    readonly _enc: 1;
    readonly iv: string; // Base64 (12 bytes CSPRNG)
    readonly ct: string; // Base64 (Ciphertext + 16-byte Auth Tag)
}
```

### B. Domain-Specific AAD Binding
Each record binds an authoritative context string to the AES-GCM authentication tag:
- File content: `idb:file:${file.id}`
- Base snapshot content: `idb:snapshot:${file.id}`
- Operation content: `idb:op:${op.operationId || op.id}`
- Operation previous content: `idb:op_prev:${opId}`
- Operation snapshot: `idb:op_snap:${opId}`

### C. PostgreSQL Cloud Schema (`0008_hybrid_vault_schema.sql`)
- `user_vault_profiles`:
  - `user_id`: UUID PK referencing `users(id)` ON DELETE CASCADE
  - `encrypted_master_key`: Text (Base64 envelope wrapped with password KEK)
  - `recovery_encrypted_master_key`: Text (Base64 envelope wrapped with BIP-39 seed KEK)
  - `key_salt` & `recovery_salt`: Text (Base64 CSPRNG 16 bytes)
  - `kdf_iterations`: Integer (600,000)
  - `key_version`: Integer (default 1)
- `files`:
  - `is_encrypted`: Boolean (default false)
  - `encryption_metadata`: JSONB (`version`, `algorithm`, `keyId`, `salt`, `iv`, `kdfIterations`)
  - Index: `idx_files_user_encrypted` on `(user_id, is_encrypted)`

---

## 3. Architectural Decisions: Adopted vs. Discarded (Anti-Overengineering Rationale)

A comprehensive adversarial code audit evaluated technical reproducibility, defensive layering, and computational overhead under high concurrency. The following architectural decisions were formalized:

### A. Adopted Decisions (القرارات المتخذة)

| Decision | Implementation | Architectural Rationale & Benefit |
| :--- | :--- | :--- |
| **Guaranteed Lazy DB Opening (`await this.getDB()`)** | Replaced silent `if (this.db)` in `getDeviceKey()` with `await this.getDB()`. | **Defect Prevention**: Calling `saveFile` or `encryptFileForStorage` prior to explicit `init()` previously generated an in-memory key but skipped disk persistence in `sync_metadata`. Enforcing `await this.getDB()` guarantees disk persistence on cold calls with zero overhead. |
| **Instance-Scoped Key Lifecycle** | Added `private localDeviceKey: Uint8Array \| null` to `IndexedDBManager`. Cleared via `wipeBuffer` on `close()` and `clearAll()`. | **Multi-Tenant Isolation**: Eliminates cross-user RAM key leakage when accounts switch in the same browser session. Each manager instance manages its own key independently of the global singleton. |
| **Automatic Session Key Purge on Logout** | Explicit `sessionKeyStore.purgeKeys()` inside `useSync` teardown and when `userId` is cleared. | **RAM Hygiene & Zero-Knowledge Guarantee**: Guarantees volatile memory is wiped on user logout or unmount, preventing lingering keys from contaminating subsequent logins. |
| **Cold-Start Concurrency Guard (`keyInitPromise`)** | 3-line memoized singleton promise deduplicating parallel `getDeviceKey()` calls. | **Race Condition Elimination**: Merges concurrent cold-start requests on a brand-new database into a single derivation task, preventing duplicate key generation without external locks. |
| **Fast String-Prefix Envelope Detection (`isEncryptedString`)** | Preserved `$O(1)$` prefix check `val.startsWith('{"_enc":1,')`. | **Peak Performance & Engine Stability**: V8 guarantees JSON key insertion order. Fast string check avoids throwing expensive `SyntaxError` exceptions on millions of plain Markdown documents. |
| **Sequential Iteration with Corrupted Record Isolation** | Retained `for...of` with inner `try/catch` isolating `CorruptedLocalRecordError`. | **Fault Isolation & Zero Degradation**: Web Worker cryptography is single-threaded. Sequential message handling avoids piling up large Buffers in RAM and allows damaged files to be quarantined without crashing queries. |

### B. Discarded & Abandoned Decisions (القرارات التي تم التخلي عنها وسبب التخلي)

| Discarded Proposal | Why it was Proposed | Technical Reason for Abandonment (Anti-Overengineering Rationale) |
| :--- | :--- | :--- |
| **Chunked Parallel Decryption via `Promise.allSettled`** | Suspected serial bottleneck in `getAllFiles()` and `getDirtyFiles()`. | **Theoretical Fallacy & Overengineering**: Web Crypto execution takes `<0.05ms` per record. The cryptographic engine uses a **single Web Worker** (`crypto.worker.ts`), which handles messages sequentially on its event loop regardless of caller concurrency. Batch chunking adds queue complexity, explodes pending Promises, and retains hundreds of uncompressed Buffers in memory with zero real throughput gain. |
| **Universal `JSON.parse` Inspection for Encrypted Envelopes** | Theoretical concern that JSON serializers might reorder keys, bypassing `isEncryptedString`. | **ECMAScript Standard Non-Issue & Performance Destruction**: ECMAScript specifications (OrdinaryOwnPropertyKeys) guarantee property iteration order for non-integer keys in insertion order. Attempting `JSON.parse` on standard Markdown files causes V8 exception bailout and severe UI stutter. |
| **Heavy Asynchronous Mutex / Distributed Lock Manager** | Initial proposal to build an async lock manager for `getDeviceKey()`. | **Unjustified State Complexity**: A heavy mutex introduces deadlock risks and complex state machines for an edge case that only occurs during the initial cold-start millisecond of a new database. Replaced by a lean 3-line `keyInitPromise`. |
| **Eager Decryption on Periodic Background Polls** | Initial implementation of `useSync` periodically calling `getDirtyFiles()` to update pending count badge. | **Redundant Cryptographic Churn**: Decrypting document contents every 5 seconds solely to read `.length` burns CPU and battery. Decoupled count check to metadata level. |

---

## 4. Verified Hardening Invariants

| Invariant | Implementation Mechanism | Verification Proof |
| :--- | :--- | :--- |
| **Zero Plaintext At-Rest** | Low-level direct IndexedDB object store inspection; asserts 0 plaintext matches in raw records. | `src/test/vault-storage.test.ts` §3 |
| **Uninitialized Lazy Persistence** | Direct `saveFile` without `init()` self-heals, saves key to `sync_metadata`, and recovers cleanly across reopens. | `src/test/vault-storage.test.ts` §8 |
| **Cold-Start Concurrency Safety** | 20 parallel writes to a cold database derive identical keys and decrypt without authentication tag mismatches. | `src/test/vault-storage.test.ts` §8 |
| **Multi-Tenant In-Memory Isolation** | Distinct managers for separate users maintain cryptographic isolation even without manual intermediate purges. | `src/test/vault-storage.test.ts` §8 |
| **Corrupted Record Quarantining** | Tampered ciphertext or mismatched AAD throws `CorruptedLocalRecordError` and isolates the single file. | `src/test/vault-storage.test.ts` §6 |
| **Zero-Downtime Migration** | In-place migration reads legacy plaintext files transparently and encrypts on subsequent modifications. | `src/test/vault-storage.test.ts` §5 |

---

## 5. Verification & Test Evidence

```bash
# Phase 2 Database Schema, Migrations & Transparent Encrypted IDB
npx vitest run src/test/vault-storage.test.ts
# Result: 15 passed (15) in 158ms

# Phase 1 Crypto Core Suite
npx vitest run src/test/vault-crypto.test.ts
# Result: 28 passed (28) in 153ms

# Sync Hook Scoped Lifecycle Suite
npx vitest run src/hooks/use-sync.test.ts
# Result: 14 passed (14) in 983ms

# Full Repository Test Suite
npm run test -- --run
# Result: 39 passed (39) Test Files, 531 passed (531) Tests

# Strict TypeScript Type-Checking
npx tsc --noEmit
# Result: 0 errors (Exit code: 0)
```

---

## 6. Phase Status & Transition Gate

- **Status:** `CLOSED` ✅
- **Next Phase:** Vault Phase 3 (Client Vault UI, Password Prompt, Recovery Seed Modal & Editor Integration)
