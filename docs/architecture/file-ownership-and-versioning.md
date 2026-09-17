# File Ownership Enforcement, Hierarchy Safety, and Concurrency Control

## 1. Overview & Objectives

Phase 3 establishes end-to-end server-side ownership enforcement, hierarchy validity (cycle and descendant protections), and optimistic version-locking semantics across all file operations in LUGX.

### Key Guarantees
1. **Server-Derived Identity:** All file operations derive user identity directly from `getUser()` on the server. Client-provided `userId` parameters are strictly rejected or stripped.
2. **Parent Ownership & Tree Integrity:** Creating, moving, copying, or importing files requires validating that the target parent folder exists, is owned by the authenticated user, is not soft-deleted, and is a valid directory (`isFolder === true`).
3. **Cycle & Descendant Protection:** The system detects and rejects cycles (e.g. moving a folder into itself or into any of its descendants) with HTTP `409 Conflict`.
4. **Mandatory Preconditions (`If-Match` / `expectedVersion`):** Updating a file requires an `If-Match` ETag header or `expectedVersion` in the payload. Missing preconditions return HTTP `428 Precondition Required`, while version mismatches return HTTP `412 Precondition Failed` with current `serverVersion` payload.
5. **Atomic Concurrency & ETag Mutation:** Comparison of version/ETag and version increment are executed in a single atomic SQL transaction.

---

## 2. API & Response Semantics

| Status Code | Reason | Behavior |
| :--- | :--- | :--- |
| `401 Unauthorized` | Missing/expired server session | Fails closed before executing database queries. |
| `404 Not Found` | Target file/folder does not exist, is soft-deleted, or belongs to another user | Unified anti-enumeration response preventing discovery of foreign resources. |
| `409 Conflict` | Semantic collision or cycle | Triggered when moving a folder into itself or its descendant. |
| `412 Precondition Failed` | Stale ETag or version mismatch | Returns `412` with current `serverVersion` data for conflict resolution. |
| `428 Precondition Required` | Missing `If-Match` and `expectedVersion` | Enforces optimistic locking protocol on all mutations. |
| `429 Too Many Requests` | Rate limit threshold exceeded | Protected by `fileApiRateLimiter`. |
| `500 Internal Server Error` | Database/runtime exception | Logged securely on server; generic error returned to client. |

---

## 3. Implementation Details

### A. Cycle Detection Algorithm (`moveFile`)
When moving a folder (`target.isFolder === true`) to `newParentFolderId`:
```typescript
let currentAncestorId: string | null = parent.parentFolderId;
const visited = new Set<string>([newParentFolderId]);

while (currentAncestorId) {
    if (currentAncestorId === fileId) {
        return { success: false, status: "conflict", error: "Cannot move a folder into one of its descendants" };
    }
    if (visited.has(currentAncestorId)) break;
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

### C. Unique Copy Naming & Recursion Depth Guard (`copyFile` - CRIT-02 & CRIT-03)
- When creating copies of documents or folders, duplicate collisions are resolved by appending ` (Copy)` or ` (Copy N)` before the file extension (e.g., `Notes (Copy).md`, `Notes (Copy 2).md`, or `Projects (Copy)`).
- Recursive copying of nested folders is safeguarded with a maximum depth limit (`MAX_DEPTH = 20`) to prevent stack overflow or timeout on complex trees.

### D. Single-Step Atomic ETag Generation & Client-Side Extraction (`createFile` / `copyFile` / `importFile` - CRIT-01)
Pre-generates UUIDs and computes strong SHA-256 ETags in-memory before issuing the database `INSERT`. This eliminates the intermediate window where files were momentarily persisted with `etag = null`, preventing transient 412 conflicts during concurrent sync polling.

`importFile` receives UTF-8 extracted plain text strings (`textContent: string`) or client-encrypted AES-GCM ciphertext (`isEncrypted: true`) directly from the browser runtime, completely bypassing binary PDF handling and removing heavy `pdf-parse` processing from the server runtime:
- **Client-Side Web Worker Isolation (`pdf.worker.ts` / `pdf-worker-bridge.ts`):** PDF text extraction runs inside a dedicated Web Worker via `pdfjs-dist` with per-page memory cleanup (`page.cleanup()`) and document destruction (`pdfDoc.destroy()`).
- **2D Spatial Markdown Table Extractor (`pdf-table-extractor.ts`):** Geometrically clusters text coordinates into lines and columns, reorders RTL columns for Arabic, and formats tabular data into GitHub-Flavored Markdown tables with user toggle capability (`pdf-settings.ts`).
- **Arabic Unicode Normalizer (`arabic-normalizer.ts`):** Performs lookahead de-spacing on disjointed Arabic characters, NFKC presentation forms un-shaping, and BiDi directionality preservation.
- **On-Demand Bilingual OCR & Font Corruption Detector:** Detects Private Use Area (PUA) glyphs in corrupted embedded fonts (`pdf-corruption-detector.ts`) and triggers an on-demand bilingual OCR engine (`pdf-ocr-engine.ts` with `tesseract.js`).
- **Direct Vault Encrypted Import:** Encrypts content directly on the client with AES-GCM-256 using deterministic AAD (`vault:file:${userId}:${fileId}`) and optimistic IndexedDB cache persistence before server dispatch.
- **Server Ingestion Safeguards & Adversarial Defense:** Enforces a strict 10MB UTF-8 byte limit, checks magic bytes for disguised binaries (`isDisguisedBinary`), strips directory traversal patterns and invalid OS characters (`sanitizeFilename`), eliminates PostgreSQL null bytes (`\0`), counts words via an $O(1)$ memory streaming regex, and prevents infinite loops with a title deduplication circuit breaker (`counter <= 100`).

### E. Cascading Soft-Delete for Folders (`deleteFile`)
Deleting a folder cascades the `deletedAt` tombstone to all recursive descendant files and subfolders, preventing sync routes from exposing orphaned children whose parent folder is deleted.

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

### K. Encrypted File Copy Guard & Client-Side Re-Encryption (`copyFile` / AUD-02)
- **Zero-Knowledge Blind Copy Prohibition**: Server-side `copyFile` strictly refuses to copy any file marked `is_encrypted: true` if no client-side `encryptedOverride` is provided. Reusing identical ciphertexts under a different file ID violates AAD integrity constraints (`vault:file:${userId}:${newFileId}`).
- **Client-Side Re-Encryption Pipeline**: The client decrypts in volatile RAM, generates a new UUID (`newFileId`) and a fresh random 12-byte IV, and re-encrypts with the target AAD. The resulting payload is supplied as `encryptedOverride`.
- **Selective Folder Copying**: When deep-copying folders with nested children, unencrypted files are copied recursively, while encrypted children are safely skipped unless individually re-encrypted on the client.

---

## 4. Verification & Testing Evidence
 
 - `src/test/cross-user-ownership.test.ts`: 11 integration tests verifying cross-user isolation across `createFile`, `copyFile`, `moveFile`, `getFile`, `updateFileContent`, `deleteFile`, `importFile`, AI reservations, streaming, and atomic UPSERT user sync.
 - `src/server/actions/file-ops.ownership.test.ts`: Covers cross-user parent validation, cycle detection across arbitrary hierarchy depth, and precondition enforcement (428/412).
 - `src/app/api/files/[id]/route.putguard.test.ts`: Verifies lost-update mitigation and atomic ETag/version updates.
 - `src/server/actions/file-ops.lostupdate.test.ts`: Validates concurrent write isolation and monotonic version increments.
 - `src/server/actions/file-ops.softdelete.test.ts`: Verifies tombstone lifecycle, unique title index handling, and bounded purge job.
 - `src/test/file-ops-vault.unit.test.ts`: 10 unit tests covering `toggleFileEncryption` optimistic locking, folder rejection, and `copyFile` zero-knowledge encrypted overrides.
 - `src/server/actions/import-file.test.ts`: Tests text import, 10MB payload size ceiling, title deduplication, and null-byte sanitization.
 - `src/lib/parsers/pdf-settings.test.ts`: Unit tests verifying local preference toggling for spatial table extraction.
 - `src/test/vault-import.integration.test.ts`: Integration test verifying direct client-encrypted vault import pipeline.
 - Full suite execution: 60 test files, 740 tests passing (100% pass rate).
