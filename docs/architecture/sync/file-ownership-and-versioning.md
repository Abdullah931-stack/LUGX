# File Ownership Enforcement, Hierarchy Safety, and Concurrency Control

## 1. Overview & Objectives

Phase 3 and Phase 8 establish end-to-end server-side ownership enforcement, hierarchy validity (unbounded cycle and descendant protections), and optimistic version-locking semantics across all file operations in LUGX.

### Key Guarantees
1. **Server-Derived Identity & Resource Guards (`src/server/auth/session.ts`):** All file operations derive user identity directly from `requireAuthenticatedUser()` on the server. Resource ownership is validated via `requireOwnedFile(fileId, userId)` with UUID validation, returning uniform `404 Not Found` for unowned or missing files to prevent resource enumeration attacks. Client-provided `userId` parameters are strictly rejected or stripped.
2. **Parent Ownership & Tree Integrity:** Creating, moving, copying, or importing files requires validating that the target parent folder exists, is owned by the authenticated user, is not soft-deleted, and is a valid directory (`isFolder === true`).
3. **Unbounded Cycle & Descendant Protection:** The system detects and rejects cycles (e.g. moving a folder into itself, circular directory loops, or moving into any descendant) with HTTP `409 Conflict`.
4. **Mandatory Preconditions (`If-Match` / `expectedVersion`):** Mutating or deleting a file requires an `If-Match` ETag header or `expectedVersion` in the payload. Missing preconditions return HTTP `428 Precondition Required`, while version mismatches return HTTP `412 Precondition Failed` with current `serverVersion` payload.
5. **Atomic Concurrency & ETag Mutation:** Comparison of version/ETag and version increment are executed in a single atomic SQL transaction.

---

## 2. API & Response Semantics

| Status Code | Reason | Behavior |
| :--- | :--- | :--- |
| `401 Unauthorized` | Missing/expired server session | Fails closed before executing database queries via `requireAuthenticatedUser()`. |
| `404 Not Found` | Target file/folder does not exist, is soft-deleted, or belongs to another user | Unified anti-enumeration response preventing discovery of foreign resources via `requireOwnedFile()`. |
| `409 Conflict` | Semantic collision or cycle | Triggered when moving a folder into itself, into a descendant, or detecting circular folder loops. |
| `412 Precondition Failed` | Stale ETag or version mismatch | Returns `412` with current `serverVersion` data for conflict resolution (applies to `PUT` and `DELETE`). |
| `428 Precondition Required` | Missing `If-Match` and `expectedVersion` | Enforces optimistic locking protocol on all mutations and deletions. |
| `429 Too Many Requests` | Rate limit threshold exceeded | Protected by `fileApiRateLimiter`. |
| `500 Internal Server Error` | Database/runtime exception | Logged securely on server; generic error returned to client. |

---

## 3. Implementation Details

### A. Unbounded Cycle Detection Algorithm (`moveFile` - LUGX-073)
When moving a folder (`target.isFolder === true`) to `newParentFolderId`:
```typescript
let currentAncestorId: string | null = parent.parentFolderId;
const visited = new Set<string>([newParentFolderId]);

while (currentAncestorId) {
    if (currentAncestorId === fileId) {
        return {
            success: false,
            status: "conflict",
            error: "Cannot move a folder into one of its descendants",
        };
    }
    if (visited.has(currentAncestorId)) {
        return {
            success: false,
            status: "conflict",
            error: "Circular hierarchy detected in folder structure",
        };
    }
    visited.add(currentAncestorId);

    const ancestor = await db.query.files.findFirst({
        where: and(
            eq(schema.files.id, currentAncestorId),
            eq(schema.files.userId, user.id),
            isNull(schema.files.deletedAt)
        ),
        columns: { parentFolderId: true },
    });
    currentAncestorId = ancestor?.parentFolderId ?? null;
}
```

### B. Title Collision Resolution on Restore (`restoreFile` - ADV-01)
When restoring a soft-deleted file or folder, if an active live file with the same title exists in the target destination, the restored file is automatically renamed by appending `(Restored)` or `(Restored N)` before the extension (e.g. `Report (Restored).md`), preventing Postgres `23505` unique index crashes.

### C. Unique Copy Naming, Length Clamping & Recursion Depth Guard (`copyFile` - LUGX-072 & LUGX-138)
- When creating copies of documents or folders, duplicate collisions are resolved by appending ` (Copy)` or ` (Copy N)` before the file extension.
- **PostgreSQL Varchar Bounds (LUGX-138):** Generated titles are clamped to `<= 500` characters (`MAX_TITLE_LENGTH = 500`) in `src/lib/utils/file-naming.ts` by truncating the base name prior to suffix/extension concatenation, preventing database column overflow errors.
- **Copy Depth Clamping (LUGX-072):** The recursive depth is clamped using `Math.max(0, depth)` with a maximum depth limit (`MAX_DEPTH = 20`), and copying a folder into itself or its descendants is strictly prohibited.

### D. Single-Step Atomic ETag Generation & Client-Side Extraction (`createFile` / `copyFile` / `importFile` - CRIT-01)
Pre-generates UUIDs and computes strong SHA-256 ETags in-memory before issuing the database `INSERT`. This eliminates the intermediate window where files were momentarily persisted with `etag = null`, preventing transient 412 conflicts during concurrent sync polling.

`importFile` receives UTF-8 extracted plain text strings (`textContent: string`) or client-encrypted AES-GCM ciphertext (`isEncrypted: true`) directly from the browser runtime, completely bypassing binary PDF handling and removing heavy `pdf-parse` processing from the server runtime:
- **Client-Side Web Worker Isolation (`pdf.worker.ts` / `pdf-worker-bridge.ts`):** PDF text extraction runs inside a dedicated Web Worker via `pdfjs-dist` with per-page memory cleanup (`page.cleanup()`) and document destruction (`pdfDoc.destroy()`).
- **2D Spatial Markdown Table Extractor (`pdf-table-extractor.ts`):** Geometrically clusters text coordinates into lines and columns, reorders RTL columns for Arabic, and formats tabular data into GitHub-Flavored Markdown tables with user toggle capability (`pdf-settings.ts`).
- **Arabic Unicode Normalizer (`arabic-normalizer.ts`):** Performs lookahead de-spacing on disjointed Arabic characters, NFKC presentation forms un-shaping, and BiDi directionality preservation.
- **On-Demand Bilingual OCR & Font Corruption Detector:** Detects Private Use Area (PUA) glyphs in corrupted embedded fonts (`pdf-corruption-detector.ts`) and triggers an on-demand bilingual OCR engine (`pdf-ocr-engine.ts` with `tesseract.js`).
- **Direct Vault Encrypted Import:** Encrypts content directly on the client with AES-GCM-256 using deterministic AAD (`vault:file:${userId}:${fileId}`) and optimistic IndexedDB cache persistence before server dispatch.
- **Server Ingestion Safeguards & Adversarial Defense:** Enforces a strict 10MB UTF-8 byte limit, checks magic bytes for disguised binaries (`isDisguisedBinary`), strips directory traversal patterns and invalid OS characters (`sanitizeFilename`), eliminates PostgreSQL null bytes (`\0`), counts words via an $O(1)$ memory streaming regex, and prevents infinite loops with a title deduplication circuit breaker (`counter <= 100`).

### E. Cascading Soft-Delete with Precondition Locking (`deleteFile` & `DELETE /api/files/[id]` - LUGX-074)
- **Precondition Requirement:** File deletions require either `expectedVersion` in the parameters or an `If-Match` ETag header. Missing preconditions return `428 Precondition Required`, and version mismatches return `412 Precondition Failed` with current `serverVersion` state.
- **Atomic Deletion & Cascade:** Upon successful version comparison, the target file is marked with `deletedAt: now` and its version incremented atomically. If the entity is a folder, `getDescendantIds` traverses all subfolders and documents, cascading the tombstone in a single operation.

### F. Optimistic Locking & Atomic Mutation (`PUT /api/files/[id]`)
```typescript
const [updatedFile] = await db.update(schema.files)
    .set({
        content: newContent,
        title: newTitle,
        etag: newEtag,
        version: newVersion,
        updatedAt: now,
    })
    .where(and(
        eq(schema.files.id, fileId),
        eq(schema.files.userId, user.id),
        eq(schema.files.version, currentVersion),
        isNull(schema.files.deletedAt)
    ))
    .returning();
```

### G. Next.js Turbopack Server Actions Separation
All pure synchronous utilities (such as `generateRestoredTitle` and `generateCopyTitle`) reside in `src/lib/utils/file-naming.ts` outside of `"use server"` files, ensuring full compliance with Next.js 16 requirements where all exported functions in server action files must be `async`.

### I. BFS Hierarchy Traversal Cycle Guards (`getDescendantIds` & `restoreFile`)
When recursively collecting descendant file/folder IDs for cascading deletion or tree restoration, BFS queue traversals maintain a `visited = new Set<string>()` guard. If corrupt or cyclic parent pointers exist in the database, the traversal terminates safely without infinite loops or memory exhaustion.

### J. Zero-Knowledge Encryption Toggle Invariants (`toggleFileEncryption`)
- **Strict Non-Folder Invariant**: Folders cannot be encrypted (`isFolder === false`); attempting to toggle encryption on a folder immediately returns an error.
- **Optimistic Concurrency Guard**: Validates `expectedVersion` and `expectedETag` against live database state. On mismatch, returns 412 Conflict with the current `serverVersion` including `isEncrypted` and `encryptionMetadata`.
- **Atomic Metadata & ETag Update**: Inverts `isEncrypted`, sets/clears structured `encryptionMetadata`, updates normalized content, computes strong SHA-256 ETag, and increments version atomically in a single SQL operation.

### L. Modular Action Architecture & Facade Pattern (`src/server/actions/*`)
To guarantee high cohesion and single-responsibility isolation, file and directory operations are divided into two dedicated server action modules:
- **`src/server/actions/files.ts`:** Governs individual file life cycles, including `createFile`, `updateFileContent`, `toggleFileEncryption`, `renameFile`, `deleteFile`, `restoreFile`, and `copyFile`.
- **`src/server/actions/folders.ts`:** Governs folder hierarchy graph logic, including `moveFile`, `getFolderChildren`, `getDescendantIds`, and `isDescendantOf`.
- **`src/server/actions/file-ops.ts` Facade:** Re-exports all functions and types from `files.ts` and `folders.ts`, preserving 100% backward compatibility across all existing UI and server callers.

---

## 4. Verification & Testing Evidence
 
 - `src/test/server/phase-08-ownership-and-cycles.test.ts`: 18 tests verifying server session enforcement, UUID validation, cross-tenant 404 shielding, cycle detection, copy depth bounds, 412 deletion preconditions, and test route isolation.
 - `src/test/server/cross-user-ownership.test.ts`: 11 integration tests verifying cross-user isolation across `createFile`, `copyFile`, `moveFile`, `getFile`, `updateFileContent`, `deleteFile`, `importFile`, AI reservations, streaming, and atomic UPSERT user sync.
 - `src/test/server/file-ops.ownership.test.ts`: Covers cross-user parent validation, cycle detection across arbitrary hierarchy depth, and precondition enforcement (428/412).
 - `src/test/api/api-files-putguard.live.test.ts`: Verifies lost-update mitigation and atomic ETag/version updates.
 - `src/test/server/file-ops.lostupdate.test.ts`: Validates concurrent write isolation and monotonic version increments.
 - `src/test/server/file-ops.softdelete.test.ts`: Verifies tombstone lifecycle, unique title index handling, and bounded purge job.
 - `src/test/vault/file-ops-vault.unit.test.ts`: 10 unit tests covering `toggleFileEncryption` optimistic locking, folder rejection, and `copyFile` zero-knowledge encrypted overrides.
 - `src/test/server/import-file.test.ts`: Tests text import, 10MB payload size ceiling, title deduplication, and null-byte sanitization.
 - `src/test/parsers/parser-pdf-settings.test.ts`: Unit tests verifying local preference toggling for spatial table extraction.
 - `src/test/vault/vault-import.integration.test.ts`: Integration test verifying direct client-encrypted vault import pipeline.

<!-- BEGIN:SSOT_TEST_METRICS_INLINE -->
**Active Verification Baseline:** 87 unit suites (1058 tests) · 21 live suites (117 tests) · 14 E2E specs (15 journeys) — 100% Passing.
<!-- END:SSOT_TEST_METRICS_INLINE -->

---

## 5. Storage Engine Decisions & Trade-offs

### Decision TR-11: PostgreSQL Direct BYTEA/TEXT Storage vs. External Object Storage (S3 / Cloudflare R2)

- **Context:** Storing user Markdown notes and encrypted zero-knowledge ciphertexts in the cloud backend.
- **Chosen Architecture:** Direct persistence in the primary PostgreSQL `files` table (`src/server/db/schema/files.ts`) using the `content` column (`text` / binary-safe string), co-located with version metadata, ETag, and encryption parameters.
- **Rejected Alternatives:**
  1. **External S3 / Cloudflare R2 Object Storage:** Storing content blobs in S3 buckets and referencing URLs in Postgres.
  2. **Supabase Storage:** Third-party storage abstraction (formally evaluated and dropped; see [`docs/foundation/DESIGN_VS_REALITY.md`](../../foundation/DESIGN_VS_REALITY.md)).
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution (Postgres Direct Storage) | Alternative (External S3 / R2) |
  | :--- | :--- | :--- |
  | **Transaction Atomicity (ACID)** | **100% Atomic**: File metadata, folder hierarchy, version counter, ETag, and encrypted payload mutate within a single database transaction. | **Dual-State Vulnerability**: Requires two-phase commits between DB and S3. Network crashes leave orphaned S3 objects or dangling DB pointers. |
  | **Latency & Round-Trips** | **Single Round-Trip**: One SQL query saves/retrieves complete note state. | **Multi-Step Overhead**: Presigned URL generation, client upload to S3, followed by DB confirmation write. |
  | **Zero-Knowledge Security** | **Unified Security Boundary**: Client-encrypted ciphertext is stored directly in DB; no external third-party storage credentials or bucket access policies to leak. | **Complex Policy Management**: S3 bucket policies, CORS configuration, and presigned URL token expiration. |
  | **Storage Cost at Scale** | **Higher per Gigabyte**: Database NVMe block storage costs more than S3 object storage ($0.12/GB vs $0.015/GB). | **Lowest Cost**: S3/R2 is orders of magnitude cheaper for massive media archives. |

- **Migration Trigger (When to Switch to Object Storage):**
  Migrating document content payloads to external object storage (e.g., Cloudflare R2 / AWS S3) is triggered **if the application expands to support large multimedia attachments or arbitrary file uploads exceeding 5MB–10MB per document**, at which point database row bloat and Neon write IOPS outweigh the architectural benefits of single-transaction ACID co-location. Text and code notes remain optimal in Postgres.
