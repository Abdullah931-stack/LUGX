# Sync API Documentation

> Complete API documentation for synchronization endpoints

## Base URL
```
/api/files
```

---

## Endpoints

### 1. GET /api/files/sync

Retrieve files modified since a specific timestamp.

#### Request
```http
GET /api/files/sync?updated_after=2026-02-01T00:00:00.000Z&cursor=abc&limit=50
Authorization: Bearer <token>
```

#### Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `updated_after` | string | ✗ | ISO-8601 timestamp (e.g. `2026-02-01T00:00:00.000Z`) |
| `cursor` | string | ✗ | Pagination cursor |
| `limit` | number | ✗ | Max items (default: 50, max: 100) |

#### Response (200 OK)
Response shape from `src/app/api/files/sync/route.ts`:
```json
{
  "files": [
    {
      "id": "file-uuid",
      "title": "Document Title",
      "content": "file content...",
      "etag": "abc123def456",
      "version": 5,
      "parentFolderId": "folder-uuid",
      "isFolder": false,
      "isEncrypted": false,
      "encryptionMetadata": null,
      "deletedAt": null,
      "updatedAt": "2026-02-01T12:00:00.000Z",
      "createdAt": "2026-01-15T09:30:00.000Z"
    }
  ],
  "has_more": true,
  "next_cursor": "eyJ1cGRhdGVkQXQiOiIuLi4iLCJpZCI6Ii4uLiJ9",
  "sync_timestamp": "2026-02-01T12:00:00.000Z"
}
```

Field notes:
- `next_cursor`: Base64-encoded JSON `{ updatedAt, id }` keyset cursor; pass it
  back as the `cursor` query parameter. `null` when no more pages.
- `sync_timestamp`: ISO-8601 string of the server time at query execution.
- `isEncrypted` & `encryptionMetadata`: Structured envelope `{ version, algorithm, keyId, salt, iv, kdfIterations }` for Zero-Knowledge files; `null` for plaintext files.
- Soft-deleted files are excluded; there is **no** `deletedIds` field — deletions
  propagate via pull reconciliation against missing/absent files.

#### Rate Limiting
- **Limiter:** `syncApiRateLimiter` — **100 requests per user per 15-minute
  sliding window** (`RATE_LIMITS.SYNC_API`).
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

---

### 2. GET /api/files/:id

Retrieve a specific file with ETag caching support.

#### Request
```http
GET /api/files/abc123
Authorization: Bearer <token>
If-None-Match: "stored-etag"
```

#### Response (200 OK)
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "new-etag-value"
Cache-Control: private, must-revalidate, max-age=0
Vary: If-None-Match

{
  "id": "abc123",
  "content": "file content...",
  "title": "Document Title",
  "isEncrypted": false,
  "encryptionMetadata": null,
  "etag": "new-etag-value",
  "version": 5,
  "updatedAt": "2026-02-01T12:00:00Z"
}
```

#### Response (304 Not Modified)
```http
HTTP/1.1 304 Not Modified
ETag: "stored-etag"
```

---

### 3. PUT /api/files/:id

Update a file with Optimistic Locking.

#### Request (Standard Markdown)
```http
PUT /api/files/abc123
Authorization: Bearer <token>
Content-Type: application/json
If-Match: "current-etag"

{
  "content": "updated content...",
  "title": "Updated Title",
  "isEncrypted": false,
  "encryptionMetadata": null,
  "expectedVersion": 5
}
```

#### Request (Zero-Knowledge Encrypted Vault File)
```http
PUT /api/files/abc123
Authorization: Bearer <token>
Content-Type: application/json
If-Match: "current-etag"

{
  "content": "base64ciphertext...",
  "title": "Document Title",
  "isEncrypted": true,
  "encryptionMetadata": {
    "version": 1,
    "algorithm": "AES-GCM-256",
    "keyId": "master-v1",
    "salt": "",
    "iv": "base64iv...",
    "kdfIterations": 600000
  },
  "expectedVersion": 5
}
```

> **Note on Normalization:** For unencrypted files, `content` undergoes `normalizeMarkdownSource` (Unicode NFC, LF newline conversion, and null-byte stripping). For encrypted files, raw ciphertext Base64 strings bypass Markdown normalization to prevent tampering with cryptographic encoding.

#### Response (200 OK)
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "new-etag-value"

{
  "id": "abc123",
  "etag": "new-etag-value",
  "version": 6,
  "updatedAt": "2026-02-01T12:30:00Z"
}
```

> **Client-Side Lean CAS Invariant:** When receiving a `200 OK` response with `{ id, etag, version }`, the client (`IndexedDBManager.commitFileAndOperationSync` or `markFileClean`) evaluates Lean Compare-And-Swap (CAS) gating:
> - If `file.localRevision === sentRevision`: the file is cleanly marked `isDirty = false`, recording `etag`, `version`, and updating `baseSnapshot`.
> - If `file.localRevision > sentRevision`: concurrent local modifications occurred while the network request was in flight (LUGX-010). The client adopts server `version` and `etag` in `baseSnapshot` to prevent false 412 conflicts on subsequent pushes, but **strictly retains `isDirty = true`** on the file to ensure the newer edits are queued and pushed.

#### Response (412 Precondition Failed - Conflict)
```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/json
ETag: "server-etag"

{
  "error": "Precondition Failed: version mismatch",
  "serverVersion": {
    "etag": "server-etag",
    "version": 6,
    "content": "# Current Server Title\n\nAuthoritative server markdown content.",
    "isEncrypted": false,
    "encryptionMetadata": null,
    "updatedAt": "2026-02-01T12:25:00.000Z"
  }
}
```

---

### 4. DELETE /api/files/:id

Soft-delete a file or folder with optimistic concurrency control and recursive descendant cascading.

#### Request
```http
DELETE /api/files/abc123?expectedVersion=5
Authorization: Bearer <token>
If-Match: "current-etag"
```

#### Precondition Requirements (LUGX-074)
- **Mandatory Precondition:** Requires either the `If-Match` header containing the current file ETag or the `expectedVersion` query parameter.
- **Missing Precondition (428):** Returns `428 Precondition Required` if neither is provided.
- **Mismatch (412):** Returns `412 Precondition Failed` with current `serverVersion` if the database ETag or version has diverged.

#### Response (200 OK)
```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, must-revalidate, max-age=0

{
  "success": true,
  "id": "abc123",
  "version": 6,
  "deletedAt": "2026-09-30T16:00:00.000Z"
}
```

#### Cascade Invariant
If the deleted resource is a folder (`isFolder === true`), `getDescendantIds` traverses all child documents and subfolders, marking them with `deletedAt: now` in a single operation.

---

## Error Responses

Error bodies are structured JSON produced by the handlers; all error responses include a standardized `correlationId` property for distributed tracing. Shapes below are taken directly from the route sources (`src/app/api/files/[id]/route.ts`, `src/app/api/files/sync/route.ts`, `src/lib/rate-limit.ts`):

| Status | Actual response body | Trigger |
|--------|----------------------|---------|
| 400 | `{ "error": "Encrypted files require valid encryptionMetadata with an IV", "correlationId": "<uuid>" }` | PUT on encrypted file without valid `encryptionMetadata.iv` |
| 400 | `{ "error": "<validation message>", "correlationId": "<uuid>" }` | Invalid request parameters or updating a folder's content |
| 401 | `{ "error": "Authentication required", "correlationId": "<uuid>" }` | Missing/expired server session |
| 403 | `{ "error": "<forbidden message>", "correlationId": "<uuid>" }` | Not authorized |
| 404 | `{ "error": "File not found", "correlationId": "<uuid>" }` | File missing, foreign tenant, or soft-deleted |
| 409 | `{ "error": "<conflict message>", "correlationId": "<uuid>" }` | Semantic conflict or folder hierarchy cycle |
| 412 | `{ "error": "Precondition Failed: version mismatch", "correlationId": "<uuid>", "serverVersion": { etag, version, content, isEncrypted, encryptionMetadata, updatedAt } }` | Stale ETag or version on PUT or DELETE |
| 428 | `{ "error": "Precondition Required: If-Match header or expectedVersion is required for file updates/deletions", "correlationId": "<uuid>" }` | Missing precondition on PUT or DELETE |
| 429 | `{ "error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later.", "retryAfter": <epoch-seconds> }` | Rate limiter exhausted (`rateLimitExceededResponse`) |
| 500 | `{ "error": "Internal server error", "correlationId": "<uuid>" }` | Unhandled server exception |

### RFC 7807 Standardized Problem Details Contract

As established in `src/types/problem-details.ts`, standardized API error envelopes follow RFC 7807:

```json
{
  "type": "urn:lugx:error:sync:conflict",
  "title": "Conflict Detected",
  "status": 409,
  "detail": "ETag mismatch between local revision and remote version",
  "instance": "/api/files/123e4567-e89b-12d3-a456-426614174000",
  "correlationId": "req-c73bcdcc-2669-4bf6-81d3-e4ae73fb11fd",
  "retryAfterSeconds": 5
}
```

### Discriminated Storage Payloads Contract

File contents and sync payloads adhere to the discriminated union defined in `src/types/storage-payload.ts`:

- **Plaintext Payload:**
  `{ "type": "plaintext", "content": string, "isEncrypted": false, "encryptionMetadata": null }`
- **Zero-Knowledge Encrypted Payload:**
  `{ "type": "encrypted", "ciphertextBase64": string, "isEncrypted": true, "encryptionMetadata": FileEncryptionMetadata }`

### Sync Operation Sequence Invariants

Operations in `src/types/sync-contracts.ts` enforce monotonic revision tracking:
- `localRevision`: Monotonically increasing local revision counter (integer > 0).
- `sentRevision`: Optional revision acknowledged by the server.
- `baseVersion`: Server version on which the operation was applied.


---

## Headers

### Request Headers
| Header | Description |
|--------|-------------|
| `Authorization` | Session cookie (Supabase auth); raw bearer tokens are not used by the app client |
| `Content-Type` | `application/json` |
| `If-Match` | ETag for update verification (PUT) |
| `If-None-Match` | ETag for caching (GET) |
| `X-Correlation-ID` | Optional client-generated request correlation identifier (UUID v4) for end-to-end tracing |

### Response Headers
Set by `addRateLimitHeaders()` / `addCorrelationHeader()` / route handlers:
| Header | Description |
|--------|-------------|
| `ETag` | Current file ETag |
| `Cache-Control` | Caching instructions |
| `X-Correlation-ID` | Server-authoritative correlation identifier for distributed tracing and error diagnosis |
| `X-RateLimit-Limit` | Configured limit for the endpoint's limiter tier |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Window reset time (epoch seconds) |
| `Retry-After` | Wait time in seconds (on 429 only; guaranteed $\ge 1$) |

---

## Rate Limiting

Configuration lives in `RATE_LIMITS` (`src/lib/rate-limit.ts`) — a sliding-window
counter backed by Upstash Redis, keyed per user:

| Limiter | Applied to | Limit | Window | Fallback Policy |
|---------|-----------|-------|--------|-----------------|
| `syncApiRateLimiter` | `GET /api/files/sync` | **100 requests** | **15 minutes** | Fail-Open (Redis outage allows requests to preserve offline-first continuity) |
| `fileApiRateLimiter` | `GET` / `PUT` / `DELETE /api/files/:id` | **200 requests** | **15 minutes** | Fail-Open (Redis outage allows requests) |
| `generalRateLimiter` | General application endpoints | **300 requests** | **15 minutes** | Fail-Open (Redis outage allows requests) |
| `authRateLimiter` | Authentication endpoints | **20 requests** | **15 minutes** | Fail-Closed (Redis outage returns HTTP 503 Service Unavailable) |
| `aiStreamRateLimiter` | `POST /api/ai/stream` | **30 requests** | **60 seconds** | Fail-Closed (Redis outage returns HTTP 503 Service Unavailable) |

### Response (429 Too Many Requests — Exhaustion)
```http
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>
X-Correlation-ID: <uuid>
X-RateLimit-Limit: 200
X-RateLimit-Remaining: 0
X-RateLimit-Reset: <epoch-seconds>

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please try again later.",
  "retryAfter": <seconds>
}
```

### Response (503 Service Unavailable — Fail-Closed Degradation)
```http
HTTP/1.1 503 Service Unavailable
Retry-After: 10
X-Correlation-ID: <uuid>
X-RateLimit-Degraded: 1

{
  "error": "Service Unavailable",
  "message": "Rate limiting service is temporarily unavailable. Request blocked under fail-closed security policy."
}
```

---

## Protected Maintenance Crons

### 1. GET / POST `/api/cron/expire-reservations` (TD-02 Sweeper)

Automated expiration of leaked or orphaned in-flight AI quota reservations past 5-minute TTL:

```http
POST /api/cron/expire-reservations
Authorization: Bearer <CRON_SECRET>
```

- **Authentication:** Shared secret `Authorization: Bearer $CRON_SECRET` verified via constant-time `crypto.timingSafeEqual`.
- **Distributed Concurrency Lock:** Protected by `acquireCronLock("expire-reservations", 300)` via atomic Redis `SET ... NX EX` with in-memory TTL fallback. Overlapping executions safely skip execution.
- **Batch Processing:** Bounded batch processing (`limit: 100`) preventing serverless execution timeouts.
- **Method Parity:** Full support for both `GET` and `POST` methods (`export const POST = GET;`).
- **Normal Execution Response (200 OK):**
  ```json
  {
    "success": true,
    "expiredCount": 3,
    "timestamp": "2026-09-18T01:30:00.000Z"
  }
  ```
- **Overlapping Execution Response (200 OK):**
  ```json
  {
    "success": true,
    "skipped": true,
    "reason": "Overlapping execution prevented by distributed lock",
    "timestamp": "2026-09-18T01:30:00.000Z"
  }
  ```

### 2. GET / POST `/api/cron/purge-deleted` (Soft-Delete Tombstone Purge)

Permanent deletion of soft-deleted file tombstones older than 30 days (`RETENTION_DAYS`), bounded to batches of 500 rows.

```http
POST /api/cron/purge-deleted
Authorization: Bearer <CRON_SECRET>
```

- **Authentication:** Shared secret `Authorization: Bearer $CRON_SECRET` verified via constant-time `crypto.timingSafeEqual`.
- **Distributed Concurrency Lock:** Protected by `acquireCronLock("purge-deleted", 600)` via atomic Redis `SET ... NX EX` with in-memory TTL fallback. Overlapping executions safely skip execution.
- **Method Parity:** Full support for both `GET` and `POST` methods (`export const POST = GET;`).
- **Normal Execution Response (200 OK):**
  ```json
  {
    "success": true,
    "deleted": 12,
    "cutoff": "2026-09-02T00:00:00.000Z",
    "retentionDays": 30,
    "batchLimit": 500,
    "done": true
  }
  ```
- **Overlapping Execution Response (200 OK):**
  ```json
  {
    "success": true,
    "skipped": true,
    "reason": "Overlapping execution prevented by distributed lock",
    "timestamp": "2026-09-18T01:30:00.000Z"
  }
  ```


---

## Usage Examples

### Fetch updates since last sync
```typescript
const response = await fetch('/api/files/sync?updated_after=' + encodeURIComponent(lastSyncedAtIso), {
  credentials: 'include', // Supabase session cookie
});

const { files, has_more, next_cursor, sync_timestamp } = await response.json();
if (has_more && next_cursor) {
  // Fetch the next page
  const next = await fetch(`/api/files/sync?updated_after=${encodeURIComponent(lastSyncedAtIso)}&cursor=${encodeURIComponent(next_cursor)}`, {
    credentials: 'include',
  });
}
```

### Update with conflict detection
```typescript
const response = await fetch(`/api/files/${fileId}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'If-Match': currentEtag,
  },
  credentials: 'include',
  body: JSON.stringify({ content, title, expectedVersion: currentVersion }),
});

if (response.status === 412) {
  // Handle conflict
  const { serverVersion } = await response.json();
  // Open ConflictDialog and perform 3-way merge
}
```

---

## Three-Way Conflict Resolution Architecture

### 1. Overview
The sync system implements a deterministic Three-Way Merge protocol to resolve concurrent edits between local offline/ephemeral writes and upstream server writes:

- **Base Version (`baseSnapshot`):** The clean, confirmed state before local modifications occurred.
- **Local Version (`localVersion`):** Unsynced changes made locally on the client.
- **Server Version (`serverVersion`):** The conflicting upstream state returned with 412 Precondition Failed.

### 2. Resolution Lifecycle & Invariants
1. **Base Snapshot Requirement:** Automatic 3-way merge is rejected with `manual_resolution_required` if `baseSnapshot` is missing or unreadable, preventing blind overwrites.
2. **Hunt-McIlroy / Pierce Diff3 Engine (`diff3.ts` & `conflict-resolver.ts`):**
   - Implements deterministic token-based 3-way line merge with half-open intervals `[start, end)`.
   - Eliminates token erasure bugs on repeated lines (e.g. duplicate lines `D\nC\nC`, `LUGX-045`) and adjacent empty lines.
   - Non-overlapping line/block changes are cleanly merged (`merged_clean`).
   - Overlapping regions insert explicit Git-style conflict markers (`<<<<<<< LOCAL ... ======= ... >>>>>>> REMOTE`).
   - Title (`title`) and Move (`parentFolderId`) metadata are merged independently.
   - Delete conflicts (remote delete vs local edit) produce `delete_conflict` requiring explicit "Restore" or "Delete" selection.
   - **Ciphertext Execution Guard:** Strictly enforces that Diff3 runs exclusively on decrypted plaintext. Passing raw encrypted payloads or Base64 ciphertexts triggers an immediate fail-closed guard error.
3. **Durable IDB Conflict Quarantine (`src/lib/idb/conflict-store.ts` & `src/lib/sync/indexeddb.ts`):**
   - Upon encountering HTTP 412 or 409 conflict, the file is persisted in IndexedDB with `syncStatus = 'conflict'` and `conflictData: { serverVersion, localVersion, baseVersion, detectedAt }`.
   - Quarantined conflicts survive page reloads and browser crashes without data loss.
4. **Pull Protection Guard:** `SyncPullEngine.pullFile` (orchestrated via `SyncManager`) strictly refuses to overwrite, modify, or delete (via tombstone) any file in `syncStatus === 'conflict'` or quarantined within `ConflictStore`.
5. **Single Authoritative Write:** After user resolution (Local, Server, 3-Way Merge, or Restore), exactly one write request is dispatched to the server containing `expectedVersion: serverVersion.version`.
6. **Verified State Transition:** Editor state (MarkdownEditor / EditorAdapter) and IndexedDB cache are only transitioned to clean (`isDirty: false`, `syncStatus = 'synced'`) after receiving 200 OK confirmation from the server. If local resolution is selected, `isDirty = true` and `syncStatus = 'dirty'` are preserved to trigger subsequent sync push.
7. **Autosave Lockout:** Autosave is strictly inhibited whenever an unresolved conflict is active.
8. **User-Scoped Multi-Tab Isolation (`src/lib/sync/tab-sync.ts` & `src/lib/sync/cross-tab-sync.ts`):** Broadcast channels are scoped per authenticated user (`lugx_sync_${userId}`) to prevent cross-tenant event bleed, filtering echo messages (`senderTabId !== currentTabId`) and only advancing clean tab versions.

---

## Zero-Knowledge Vault Server Actions & Endpoints

### 1. `toggleFileEncryption` (`src/server/actions/files.ts`, re-exported via `file-ops.ts`)
Converts a file between plaintext and encrypted states:
- **Signature:**
  ```typescript
  toggleFileEncryption(
    fileId: string,
    isEncrypted: boolean,
    content: string,
    encryptionMetadata?: {
      version: number;
      algorithm: string;
      keyId: string;
      salt: string;
      iv: string;
      kdfIterations?: number;
    } | null,
    options?: { expectedVersion?: number; expectedETag?: string }
  ): Promise<FileOpResult>
  ```
- **Invariants:** Folders cannot be encrypted (`isFolder === false`). Preconditions `expectedVersion` and `expectedETag` are verified optimistically; returns 412 with `serverVersion` on conflict.

### 2. `copyFile` with Encrypted Override (`src/server/actions/files.ts`, re-exported via `file-ops.ts` / AUD-02)
Creates a copy of a document or folder:
- **Encrypted File Invariant:** If `original.isEncrypted` is true, `copyFile` strictly requires an `encryptedOverride` containing `{ newFileId, content, encryptionMetadata }` re-encrypted on the client with unique AAD. Server-side blind copy is rejected.
- **Copy Depth Clamping (LUGX-072):** Clamps `depth` via `Math.max(0, depth)` with a maximum depth limit of 20 and blocks copying into self/subfolder.

### 3. Server-Authoritative Identity & Ownership Guards (`src/server/auth/session.ts`)
Server-side guard primitives eliminating client-supplied `userId` parameters:
- `requireAuthenticatedUser()`: Extracts user strictly from verified server session, throwing `AuthenticationRequiredError` (401) on missing sessions.
- `requireOwnedFile(fileId, userId, options)`: Enforces UUID syntax check (preventing PostgreSQL `22P02` exceptions) and asserts ownership. Returns `ResourceNotFoundError` (404) on foreign or deleted records, eliminating resource enumeration.

### 4. Vault Profile Server Actions (`src/server/actions/vault-actions.ts`)
Atomic server actions managing zero-knowledge profiles:
- `getUserVaultProfile()`: Retrieves user's profile (`userVaultProfiles`) or `null`.
- `createUserVaultProfile(input)`: Atomically inserts dual-wrapped master keys (`encryptedMasterKey` and `recoveryEncryptedMasterKey`) with 409 conflict guard.
- `updateVaultPassword(input)`: Updates password-wrapped master key and salt with 404 guard.
- `revokeAllTrustedDevices()`: Atomically increments `deviceTrustEpoch` from $N$ to $N+1$, invalidating all local device PIN envelopes globally.

---

## Client-Side Sync Contracts & Cryptographic Interfaces (`src/lib/sync`)

### 1. `RemoteUpdateEvent`
Dispatched when remote updates are pulled or broadcast:
```typescript
export interface RemoteUpdateEvent {
    fileId: string;
    content: string;
    etag: string;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}
```

### 2. `SyncConflict` Interface
Passed to `onConflict` handler when optimistic concurrency fails (HTTP 412 / 409):
```typescript
export interface SyncConflict {
    fileId: string;
    localVersion: {
        content: string;
        etag: string;
        version: number;
        title?: string;
    };
    serverVersion: {
        content: string; // Plaintext Markdown after inbound gateway decryption
        etag: string;
        version: number;
        title?: string;
        updatedAt?: string;
        isEncrypted?: boolean;
        encryptionMetadata?: EncryptedEnvelopeMetadata | null;
    };
    baseVersion?: {
        content: string;
        etag: string;
        version: number;
        title?: string;
    };
    isEncrypted?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}
```

### 3. `SyncCryptoGateway` Contracts
Inbound and outbound data transformations between ciphertext envelopes and Markdown plaintext:
```typescript
export interface InboundPayloadInput {
    fileId: string;
    content: string;
    isEncrypted?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | Partial<EncryptedEnvelopeMetadata> | null;
    userId?: string;
}

export interface InboundPayloadResult {
    fileId: string;
    content: string;
    isEncrypted: boolean;
    isVaultLocked: boolean;
    status: 'plaintext' | 'decrypted' | 'locked' | 'error';
    encryptionMetadata: EncryptedEnvelopeMetadata | null;
    error?: string;
}

export interface OutboundPayloadResult {
    ciphertextBase64: string;
    encryptionMetadata: EncryptedEnvelopeMetadata;
}
```

---

### 4. `LogSanitizer` Interface & Contracts (`src/lib/sync/log-sanitizer.ts`)
Zero-Knowledge log hygiene module preventing document plaintext, ciphertext envelopes, encryption keys, BIP-39 recovery seeds, passwords, PINs, and raw buffers from leaking into console output, telemetry, or in-memory error/metric stores:

```typescript
export const REDACTED = '[REDACTED]';

export function isSensitiveLogKey(key: string): boolean;
export function sanitizeLogMessage(message: string): string;
export function sanitizeLogValue(value: unknown, seen?: Set<object>): unknown;
export function sanitizeMetadata(metadata?: Record<string, unknown> | unknown): Record<string, unknown> | undefined;
```

#### Core Invariants:
1. **Token-Boundary Isolation**: Evaluates short cryptographic abbreviations (`iv`, `pin`, `aad`, `kek`, `pwd`) strictly on exact token boundaries (`(?:^|[^a-zA-Z0-9_])`) to eliminate false-positive redaction of benign properties (e.g. `activity`, `archive`, `privacy`).
2. **Multi-Word Secret Scrubbing**: Colon-separated regex scrubbers consume non-delimiter sequences (`[^,;\n}\]]+`), ensuring multi-word secrets (such as 12-word BIP-39 mnemonic seeds) are completely redacted instead of stopping at the first space.
3. **DAG Cycle Prevention**: Recursive traversal utilizes enter-and-exit depth-first tracking (`seen.delete(obj)` in `finally`) to eliminate infinite recursion on cyclic structures while correctly traversing shared diamond nodes in Directed Acyclic Graphs.
4. **Sanitized Stack Preservation**: When sanitizing `Error` instances, call stack lines are preserved for diagnostic observability while scrubbed of embedded sensitive credentials or tokens.

---

### 5. `SyncErrorHandler` Contracts (`src/lib/sync/error-handler.ts`)
Centralized error handling and recovery dispatch for the synchronization system:

```typescript
export enum SyncErrorType {
    NETWORK_ERROR = 'NETWORK_ERROR',
    AUTH_ERROR = 'AUTH_ERROR',
    CONFLICT_ERROR = 'CONFLICT_ERROR',
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    STORAGE_ERROR = 'STORAGE_ERROR',
    RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
    SERVER_ERROR = 'SERVER_ERROR',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    CIRCUIT_BREAKER_OPEN = 'CIRCUIT_BREAKER_OPEN',
    OPERATION_ABORTED = 'OPERATION_ABORTED',
    UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

export interface SyncError {
    type: SyncErrorType;
    message: string;
    recoverable: boolean;
    retryAfter?: number;
    statusCode?: number;
    metadata?: Record<string, unknown>;
    originalError?: Error;
    timestamp: number;
}
```

#### Invariants:
- All error creations (`createSyncError`) and event dispatches (`handle(error)`) pass message, metadata, and original errors through `logSanitizer` before logging to `console.error` or storing in memory.
- Registered `ErrorCallback` listeners receive sanitized errors, preventing consumer callbacks from accidentally leaking cryptographic secrets to external monitoring tools.

---

### 6. `SyncPerformanceMonitor` Contracts (`src/lib/sync/performance-monitor.ts`)
In-memory performance metric tracking and latency profiling:

```typescript
export type MetricType =
    | 'sync_duration'
    | 'push_duration'
    | 'pull_duration'
    | 'conflict_resolution'
    | 'indexeddb_read'
    | 'indexeddb_write'
    | 'network_request';

export interface PerformanceMetric {
    type: MetricType;
    duration: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
}
```

#### Invariants:
- **Ingestion Sanitization**: Both `recordMetric` and `stopTimer` sanitize incoming `metadata` through `sanitizeMetadata()` before recording to `this.metrics`.
- Generated metrics and summaries (`getMetricsByType`, `getAverageDuration`) are guaranteed free of plaintext Markdown and cryptographic keys.

---

### 7. `SessionKeyStore` Memory Contracts (`src/lib/sync/session-key-store.ts`)
Volatile in-memory Master Key management with strict inactivity enforcement:

```typescript
export class SessionKeyStore {
    public isUnlocked(): boolean;
    public getMasterKey(): CryptoKey | Uint8Array | null;
    public getMasterKeyRaw(): Uint8Array | null;
    public setMasterKey(key: CryptoKey | Uint8Array, keyVersion?: number): void;
    public storeMasterKeyRaw(key: Uint8Array, timeoutSeconds?: number): void;
    public lock(broadcast?: boolean): void;
    public purgeKeys(broadcast?: boolean): void;
    public touch(): void;
    public destroy(): void;
    public subscribe(listener: KeyStoreListener): () => void;
    public getLockEpoch(): number;
    public withMasterKey<T>(operation: (key: CryptoKey | Uint8Array, epoch: number) => Promise<T> | T): Promise<T>;
}
```

#### Invariants:
1. **Volatile RAM Only**: Raw Master Key bytes (`masterKeyRaw`) and derived WebCrypto keys are held strictly in memory and are never serialized to `localStorage`, `sessionStorage`, or `IndexedDB`.
2. **Deterministic Auto-Lock & Inactivity Decoupling (LUGX-042)**: Enforces a strict 1-hour inactivity window (3,600,000 ms). Programmatic key retrieval (`getMasterKey()`, `getMasterKeyRaw()`) does not postpone auto-lock; only explicit user interface interactions (`touch()`, `VaultManager.touchActivity()`) update the activity timestamp.
3. **Detached Caller Buffer Isolation (LUGX-016)**: `getMasterKeyRaw()` returns an isolated clone (`new Uint8Array(this.masterKeyRaw)`), preventing caller modifications or local wipes (`wipeBuffer`) from zeroing the active key held within `SessionKeyStore`.
4. **Monotonic Lock Epoch & Concurrency Protection (LUGX-016)**: `lockEpoch` increments monotonically on every lock/purge. `withMasterKey<T>()` verifies that the active epoch has not changed during asynchronous operations, safely aborting if the vault locked concurrently to prevent zero-key encryption.
5. **Cross-Tab Volatile RAM Purge Synchronization**: When `lock()` or `purgeKeys()` is invoked (or upon inactivity timeout expiration via `isUnlocked()`), a `vault_locked` broadcast event is dispatched across sibling tabs via `BroadcastChannel('textai_cross_tab_sync')`. All sibling tabs immediately sanitize volatile RAM via `wipeBuffer()` (`.fill(0)`) and transition to locked state without re-broadcasting, preventing echo loops.

---

### 8. `SyncStateReducer` Contracts (`src/lib/sync/sync-state-reducer.ts`)

Pure, deterministic state machine governing sync status transitions with zero I/O and zero clock side-effects (remediating LUGX-003, LUGX-010, LUGX-036, LUGX-040):

```typescript
export type SyncStatusState = 'idle' | 'syncing' | 'conflict' | 'error';

export interface SyncConflictPayload {
    readonly baseVersion: number;
    readonly remoteVersion: number;
    readonly remoteEtag: string;
    readonly detectedAt: number;
}

export type SyncState =
    | { readonly status: 'idle'; readonly lastSyncedAt?: number; readonly lastError?: string }
    | { readonly status: 'syncing'; readonly fileId?: string; readonly operationId?: string; readonly startedAt: number; readonly retryCount: number }
    | { readonly status: 'conflict'; readonly fileId: string; readonly conflict: SyncConflictPayload }
    | { readonly status: 'error'; readonly fileId?: string; readonly error: string; readonly retryAfterSeconds?: number; readonly retryCount: number; readonly failedAt: number };

export type SyncEvent =
    | { readonly type: 'START_SYNC'; readonly fileId?: string; readonly operationId?: string; readonly timestamp: number }
    | { readonly type: 'SYNC_SUCCESS'; readonly timestamp: number; readonly newEtag?: string; readonly newVersion?: number }
    | { readonly type: 'SYNC_ERROR'; readonly error: string; readonly retryAfterSeconds?: number; readonly timestamp: number }
    | { readonly type: 'CONFLICT_DETECTED'; readonly fileId: string; readonly conflict: SyncConflictPayload; readonly timestamp: number }
    | { readonly type: 'RESOLVE_CONFLICT'; readonly resolution: 'local' | 'remote' | 'merge'; readonly mergedContent?: string; readonly timestamp: number }
    | { readonly type: 'RETRY_SYNC'; readonly timestamp: number }
    | { readonly type: 'RESET_TO_IDLE' };

export function reduceSyncState(
    currentState: SyncState,
    event: SyncEvent,
    options?: ReducerOptions
): SyncState;

export function isValidSyncTransition(state: SyncState, event: SyncEvent): boolean;
```

#### Invariants:
1. **Rejection of Impossible Jumps:** Transitions from `idle` directly to `conflict` or `error` without an active `syncing` network attempt throw `InvalidSyncTransitionError` in strict mode.
2. **Push Mandate on Conflict Resolution (LUGX-003):** Resolving a conflict via `local` or `merge` transitions directly to `syncing` (forcing a push before local changes can be marked clean), rather than silently transitioning to `idle`.
3. **Purity Guarantee:** Reducer functions execute without side-effects, making zero calls to `Date.now()`, `fetch()`, or browser storage APIs.

---

### 9. Core Synchronization Domain Contracts (`src/lib/sync/sync-manager.types.ts`)

Centralized domain contracts, callbacks, and configuration types ensuring clean module boundaries and zero circular dependencies:

```typescript
export const MAX_QUARANTINED_CONFLICTS = 100;

export interface QuarantineDiagnostics {
    totalQuarantined: number;
    staleCount: number;             // Conflicts quarantined for > 24 hours
    oldestQuarantinedAt: number | null;  // Timestamp ms
    newestQuarantinedAt: number | null;  // Timestamp ms
    isAtCapacity: boolean;          // True if quarantine >= MAX_QUARANTINED_CONFLICTS
}

export type SyncStatus =
    | 'idle'
    | 'loading'
    | 'queued'
    | 'syncing'
    | 'conflict'
    | 'failed'
    | 'stopped'
    | 'offline';

export interface FileSyncResult {
    fileId: string;
    success: boolean;
    action: 'pushed' | 'pulled' | 'conflict' | 'skipped';
    error?: string;
    newEtag?: string;
}

export interface SyncResult {
    success: boolean;
    filesProcessed: number;
    filesPushed: number;
    filesPulled: number;
    conflicts: string[];
    errors: string[];
    timestamp: number;
}

export interface RemoteUpdateEvent {
    fileId: string;
    content: string;
    etag: string;
    version: number;
    title?: string;
    parentFolderId?: string | null;
    updatedAt: string;
    isEncrypted?: boolean;
    isVaultLocked?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}

export type RemoteUpdateCallback = (event: RemoteUpdateEvent) => void;
export type SyncStatusCallback = (status: SyncStatus, progress?: number) => void;

export type ConflictCallback = (conflict: {
    fileId: string;
    localContent: string;
    serverContent: string;
    localEtag: string;
    serverEtag: string;
    serverVersion?: number;
    serverUpdatedAt?: string;
    isEncrypted?: boolean;
    encryptionMetadata?: EncryptedEnvelopeMetadata | null;
}) => Promise<'local' | 'server' | 'merge'>;

export interface SyncManagerConfig {
    userId: string;
    fileId?: string;
    workspaceId?: string;
    apiBaseUrl?: string;
    autoSyncInterval?: number;
    maxRetries?: number;
    idb?: IndexedDBManager;
    enableJitter?: boolean;
}
```

---

### 10. `SyncQueueWorker` Class (`src/lib/sync/sync-queue-worker.ts`)

Dedicated worker managing operations queue execution, retry backoff with randomized jitter, and dirty file push batches:

```typescript
export interface SyncQueueWorkerOptions {
    userId: string;
    apiBaseUrl?: string;
    maxRetries?: number;
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    enableJitter?: boolean;
    idb: IndexedDBManager;
    rollback: SyncRollback;
    conflictStore: ConflictStore;
    encryptedConflictStore: SyncEncryptedConflictStore;
    getConflictCallback?: () => ConflictCallback | undefined;
    onConflictQuarantined?: (file: IDBFile, serverVersion: any) => Promise<void>;
}

export class SyncQueueWorker {
    public isQueueProcessing: boolean;
    constructor(options: SyncQueueWorkerOptions);
    updateConfig(options: Partial<SyncQueueWorkerOptions>): void;
    destroy(): void;
    calculateBackoffDelay(attempts: number): number;
    processOperationsQueue(signal?: AbortSignal): Promise<{
        processed: number;
        succeeded: number;
        failed: number;
        conflicts: string[];
    }>;
    processSingleOperation(op: IDBOperation, signal?: AbortSignal): Promise<FileSyncResult>;
    pushDirtyFiles(signal?: AbortSignal): Promise<{
        pushed: number;
        conflicts: string[];
        errors: string[];
    }>;
    pushFile(file: IDBFile, signal?: AbortSignal): Promise<FileSyncResult>;
}
```

#### Invariants:
- **Single-Flight Processing:** Guarded by `isQueueProcessing` flag to prevent overlapping executions.
- **Double-Push Elimination:** `pushDirtyFiles` filters out files with active `queued`/`syncing` operations and locked encrypted conflicts.
- **Non-Destructive Network Rollback (LUGX-013):** Checkpoints created via `rollback.createCheckpoint(file.id, 'pre_sync')` are discarded via `removeCheckpoint()` upon network failures, preserving offline dirty edits without reverting local changes.

---

### 11. `SyncEncryptedConflictStore` Class (`src/lib/sync/sync-encrypted-conflict-store.ts`)

Encapsulates in-memory `CONFLICT_LOCKED` quarantine for encrypted files when the vault is locked:

```typescript
export interface SyncEncryptedConflictStoreOptions {
    userId?: string;
    idb: IndexedDBManager;
    conflictStore: ConflictStore;
    rollback?: SyncRollback;
    conflictCallback?: ConflictCallback;
    pushResolved?: (file: IDBFile) => Promise<FileSyncResult>;
}

export class SyncEncryptedConflictStore {
    get rawMap(): Map<string, PendingEncryptedConflict>;
    constructor(options: SyncEncryptedConflictStoreOptions);
    updateContext(options: Partial<SyncEncryptedConflictStoreOptions>): void;
    setConflictCallback(callback?: ConflictCallback): void;
    clear(): void;
    getPendingEncryptedConflicts(): PendingEncryptedConflict[];
    getPendingEncryptedConflict(fileId: string): PendingEncryptedConflict | undefined;
    isEncryptedConflictLocked(fileId: string): boolean;
    onEncryptedConflictLocked(callback: (conflict: PendingEncryptedConflict) => void): () => void;
    notifyEncryptedConflictLocked(conflict: PendingEncryptedConflict): void;
    quarantineEncryptedConflict(conflict: PendingEncryptedConflict): void;
    getQuarantineDiagnostics(): QuarantineDiagnostics;
    discardPendingEncryptedConflict(fileId: string): Promise<void>;
    resolvePendingEncryptedConflict(fileId: string): Promise<FileSyncResult>;
    resolveAllPendingEncryptedConflicts(): Promise<Record<string, FileSyncResult>>;
}
```

#### Invariants:
- **FIFO Capacity Bound:** Caps quarantined documents at `MAX_QUARANTINED_CONFLICTS = 100`, evicting the oldest entry on capacity overflow while ensuring existing document updates never trigger eviction.
- **Reactive Unlock Resolution:** Upon vault unlock, `resolvePendingEncryptedConflict` decrypts local/server/base envelopes in RAM, runs 3-way Diff3 merge, validates Markdown syntax integrity, re-encrypts with a fresh IV, and pushes to the server.

---

### 12. `SyncPullEngine` Class (`src/lib/sync/sync-pull-engine.ts`)

Encapsulates incremental remote updates, pagination cursor traversal, and inbound conflict detection:

```typescript
export interface SyncPullEngineOptions {
    userId: string;
    apiBaseUrl?: string;
    idb: IndexedDBManager;
    rollback: SyncRollback;
    conflictStore: ConflictStore;
    encryptedConflictStore: SyncEncryptedConflictStore;
    getConflictCallback?: () => ConflictCallback | undefined;
    onRemoteUpdate?: (event: RemoteUpdateEvent) => void;
    signal?: AbortSignal;
}

export class SyncPullEngine {
    constructor(options: SyncPullEngineOptions);
    updateConfig(options: Partial<SyncPullEngineOptions>): void;
    destroy(): void;
    pullUpdates(signal?: AbortSignal): Promise<{
        pulled: number;
        conflicts: string[];
        errors: string[];
    }>;
    pullFile(serverFile: any, signal?: AbortSignal): Promise<FileSyncResult>;
}
```

#### Invariants:
- **Tombstone Reconciliation:** Server tombstones (`deletedAt !== null`) cleanly delete local copies and fail pending operations with descriptive errors.
- **Pull Overwrite Protection:** Refuses to overwrite files actively marked with `syncStatus === 'conflict'` in IndexedDB or held in `ConflictStore`.
- **Inbound Decryption:** Leverages `SyncCryptoGateway` to decrypt inbound payloads before emitting `RemoteUpdateEvent` to listeners.

---

### 13. `SyncManager` Thin Coordinator Class (`src/lib/sync/sync-manager.ts`)

Central coordinator decomposed from the original monolithic sync engine into a lean orchestrator (<350 lines). Retains the authoritative public contract and external API surface while delegating operations queue execution to `SyncQueueWorker`, locked conflict quarantine to `SyncEncryptedConflictStore`, and incremental remote updates to `SyncPullEngine`, while injecting `SyncRollback`:

```typescript
export class SyncManager {
    get isQueueProcessing(): boolean;
    set isQueueProcessing(value: boolean);
    constructor(initialConfig?: SyncManagerConfig);
    getUserId(): string | null;
    getConflictStore(): ConflictStore;
    init(config: SyncManagerConfig): Promise<void>;
    destroy(): void;
    setConflictCallback(cb: ConflictCallback): void;
    onRemoteUpdate(cb: RemoteUpdateCallback): () => void;
    getStatus(): SyncStatus;
    onStatusChange(cb: SyncStatusCallback): () => void;
    sync(): Promise<SyncResult>;
    queueSync(fileId: string, priority?: 1 | 2 | 3, operationId?: string): Promise<void>;
    syncFile(fileId: string): Promise<FileSyncResult>;
    processOperationsQueue(s?: AbortSignal): Promise<{
        processed: number;
        succeeded: number;
        failed: number;
        conflicts: string[];
    }>;
    processSingleOperation(op: IDBOperation, s?: AbortSignal): Promise<FileSyncResult>;
    pushDirtyFiles(s?: AbortSignal): Promise<{
        pushed: number;
        conflicts: string[];
        errors: string[];
    }>;
    pushFile(file: IDBFile, s?: AbortSignal): Promise<FileSyncResult>;
    getPendingEncryptedConflicts(): PendingEncryptedConflict[];
    getPendingEncryptedConflict(id: string): PendingEncryptedConflict | undefined;
    isEncryptedConflictLocked(id: string): boolean;
    onEncryptedConflictLocked(cb: (c: PendingEncryptedConflict) => void): () => void;
    quarantineEncryptedConflict(c: PendingEncryptedConflict): void;
    getQuarantineDiagnostics(): QuarantineDiagnostics;
    discardPendingEncryptedConflict(id: string): Promise<void>;
    resolvePendingEncryptedConflict(id: string): Promise<FileSyncResult>;
}

export function createSyncManager(config?: SyncManagerConfig): SyncManager;
export const syncManager: SyncManager;
```

#### Configuration Interface (`SyncManagerConfig`):
```typescript
export interface SyncManagerConfig {
    userId: string;
    apiBaseUrl?: string;
    autoSyncInterval?: number;
    maxRetries?: number;
    enableJitter?: boolean;
    idb?: IndexedDBManager;
}
```

#### Delegation Architecture & Sub-Engines:
- **`SyncQueueWorker` Delegation:** Outbound queue processing (`processOperationsQueue`, `processSingleOperation`) and dirty file batch uploads (`pushDirtyFiles`, `pushFile`) are fully dispatched to the queue worker.
- **`SyncEncryptedConflictStore` Delegation:** Managing encrypted conflicts occurring while the vault is locked (`CONFLICT_LOCKED`), diagnostic reporting (`getQuarantineDiagnostics`), discard operations, and vault-unlock auto-resolution delegate directly to the in-memory conflict store.
- **`SyncPullEngine` Delegation:** Remote cursor polling, incremental change ingestion (`pullUpdates`), and incoming server document processing (`pullFile`) delegate to the pull engine.
- **`SyncRollback` Dependency Injection:** Preserves `src/lib/sync/rollback.ts` (304 lines) without rewriting. `SyncManager` instantiates/connects `this.rollback` and injects it into all three sub-engines for atomic checkpoint capture and non-destructive failure handling.
- **Lifecycle Invariants:**
  - `init()` validates non-empty `userId`, initializes tenant-scoped IndexedDB, links sub-engines, cleans up interrupted `syncing` operations, binds connectivity listeners, and subscribes to `sessionKeyStore` for automatic conflict resolution upon vault unlock.
  - `destroy()` triggers cancellation on the active `AbortController`, tears down timers and listeners, and invokes `destroy()` on both `queueWorker` and `pullEngine`.
  - `sync()` executes a deterministic 3-stage pipeline: (1) operations queue flush, (2) dirty files push, and (3) remote updates pull.



