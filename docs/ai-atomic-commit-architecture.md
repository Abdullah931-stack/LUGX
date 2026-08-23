# AI Atomic Commit & Transactional Settlement Architecture

## 1. Overview & Technical Objective

This document defines the architecture, invariant guarantees, and operational hardening for **Phase 8: AI Atomic Commit Inside File**.
The goal is to ensure a strictly verified, single-transaction atomic commit mechanism that binds the AI generation result to the file state, quota reservation settlement, and expected optimistic version/ETag without allowing partial document mutations, connection leaks, or quota desynchronization.

---

## 2. Invariant Guarantees

1. **Transactional Atomicity & Production Enforcement**:
   - File content update (`files` table), version increment, ETag generation, and reservation settlement (`aiReservations` table -> `committed`) execute inside a single transactional boundary (`txDb.transaction`).
   - If reservation settlement or file update fails, the entire transaction is rolled back.
   - In production (`NODE_ENV !== "test"`), transactional support via `txDb.transaction` is strictly required; any missing transaction driver triggers a hard exception rather than silently slipping into non-atomic fallbacks.

2. **Strict Ownership & File Association**:
   - The committing user must own both the target file and the AI reservation record.
   - The reservation record's `fileId` must match the target `fileId`.

3. **Optimistic Version, ETag Preconditions & TOCTOU Hardening**:
   - Optimistic concurrency control is enforced both at the initial validation check and atomically inside the update statement (`WHERE version = expectedVersion`).
   - If a concurrent write occurs between validation and transaction commit, the update yields zero rows, rolling back the transaction and triggering an explicit `412 conflict` response.
   - Conflict responses return minimal metadata (`version`, `etag`, `updatedAt`) without leaking full document payloads across the network.

4. **Connection Pool Bounds & Timeout Protection**:
   - The transactional WebSocket pool is bounded with explicit resource limits (`max: 5`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`) to prevent unhandled connection hangs or orphaned reservations during Neon database network latency.

5. **Idempotency via `operationId`**:
   - If a commit is retried after a network partition where the reservation was already marked `committed`, the endpoint idempotently returns the current committed version/ETag instead of applying redundant version increments or throwing unhandled errors.

6. **Server-First Commit Invariant in Editor**:
   - The client editor maintains ephemeral preview decorations (`StreamingGhostExtension`) during generation.
   - Stream completion does NOT commit: the sanitized output is parked in `preview_ready` until an explicit user decision (v1.6.0 Explicit Decision Model).
   - On user **Accept** (`commitPreview`), local TipTap document modifications are applied as a single history step **only after** server commit confirms success.
   - In case of network failure or 412 conflict, the ephemeral preview is dismantled and the document remains in its pristine state.
   - On user **Reject** or **Retry**, no document mutation occurs at all; the quota reservation is settled as consumed per the Explicit Settlement Policy (`docs/ai-quota-reservation-lifecycle.md` §4-D).

7. **Autosave & Sync Isolation**:
   - Background autosave and cross-tab sync broadcasts are suppressed while `aiStream.isLoading` / `aiStream.isCommitting` is active **or while the session rests in `preview_ready` awaiting the user's decision**, and resume only after the editor generation and file version are updated with the server's response.

---

## 3. Component Reference & Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Editor as TipTap Editor
    participant Hook as useAIStream Hook
    participant Server as commitAIFileOperation
    participant DB as Neon Database (txDb)

    User->>Editor: Trigger AI Action (e.g. improve/summarize)
    Editor->>Hook: Start stream (Selection: [from, to])
    Hook->>Editor: Attach StreamingGhost (Zero doc mutation)
    Hook->>Server: consumeAIStream & Quota Reserve
    Server-->>Hook: Stream tokens -> Ghost decoration update
    Hook->>Server: commitAIFileOperation(fileId, opId, expectedVersion, expectedETag)
    
    rect rgb(240, 248, 255)
        Note over Server,DB: Transactional Boundary
        Server->>DB: Check Ownership, Version & ETag
        alt Precondition Failed (Version / ETag mismatch)
            Server-->>Hook: 412 Conflict (version, etag, updatedAt)
            Hook->>Editor: Clear Ghost & Rollback Preview
        else Precondition Valid
            Server->>DB: BEGIN TRANSACTION
            Server->>DB: UPDATE files SET content, version+1, etag WHERE version = expectedVersion
            Server->>DB: UPDATE aiReservations SET status='committed'
            Server->>DB: COMMIT TRANSACTION
            Server-->>Hook: { success: true, status: 'committed', version, etag }
            Hook->>Editor: Clear Ghost & Apply Atomic TipTap Transaction (1 History Step)
        end
    end
```

---

## 4. Verification & Test Evidence

The atomic commit guarantees are verified across the following automated test suites:
- `src/test/ai-atomic-commit.integration.test.ts`: **Real PostgreSQL Integration Test** executing the actual production actions (`commitAIFileOperation`, `refundAIReservation`) against real PostgreSQL tables, enforcing foreign keys, live interactive transactions, and rollback verification.
- `src/test/ai-server-atomic-commit.test.ts`: Covers auth verification, parameter validation, file-reservation association, idempotent retries, ETag/version conflict guards, production transaction requirement, and transactional execution/rollback.
- `src/lib/ai-transaction.test.ts`: Verifies ephemeral ghost decoration isolation, single-action undo invariants, and server-first confirmation.
- `src/test/editor-atomic-commit.test.ts`: Verifies partial and full replacement single undo invariants, conflict rollbacks, and pristine document preservation upon server failure.
- `src/test/ai-quota-idempotency.test.ts` & `src/server/actions/ai-ops.refund.test.ts` & `src/server/actions/ai-ops.integrity.test.ts`: Verifies quota reservation state machine, cross-midnight resilience, and concurrency idempotency.

---

## 5. Technical Debt & Future Considerations

1. **Transaction Pool Scaling**:
   - The current `max: 5` Pool configuration in `src/lib/db/transactional.ts` is sized for serverless container instances. Under future horizontal serverless scaling with high concurrency per instance, connection pooling may need PgBouncer / Neon connection pooling proxy integration.
2. **Conflict UI Differentiation**:
   - The conflict response intentionally omits `content` to optimize network bandwidth and prevent data leaks. If a three-way merge dialog is designed specifically for AI conflicts in the future (similar to `useSync` conflict modal), a dedicated comparison endpoint should be created rather than transmitting document payloads in all conflict error states.
3. **Driver-Level Unit Test Mocking**:
   - In `NODE_ENV === "test"`, a sequential fallback path remains to accommodate mock DB environments where interactive transactions are simulated. Full end-to-end integration tests run against real Postgres to ensure real transactional semantics.
