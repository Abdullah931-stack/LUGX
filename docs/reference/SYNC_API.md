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
GET /api/files/sync?since=1706745600000&cursor=abc&limit=50
Authorization: Bearer <token>
```

#### Parameters
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `since` | number | ✓ | Unix timestamp (ms) |
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

#### Request
```http
PUT /api/files/abc123
Authorization: Bearer <token>
Content-Type: application/json
If-Match: "current-etag"

{
  "content": "updated content...",
  "title": "Updated Title",
  "expectedVersion": 5
}
```

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
    "updatedAt": "2026-02-01T12:25:00.000Z"
  }
}
```

---

## Error Responses

Error bodies are free-form JSON produced by the handlers; they do **not** use a
machine-readable `code` envelope. Shapes below are taken directly from the route
sources (`src/app/api/files/[id]/route.ts`, `src/app/api/files/sync/route.ts`,
`src/lib/rate-limit.ts`):

| Status | Actual response body | Trigger |
|--------|----------------------|---------|
| 400 | `{ "error": "<validation message>" }` | Invalid request parameters |
| 401 | `{ "error": "Authentication required" }` | Missing/expired server session |
| 403 | `{ "error": "<forbidden message>" }` | Not authorized |
| 404 | `{ "error": "File not found" }` | File missing or soft-deleted |
| 409 | `{ "error": "<conflict message>" }` | Semantic conflict |
| 412 | `{ "error": "Precondition Failed: version mismatch", "serverVersion": { etag, version, content, updatedAt } }` | Stale ETag/version on PUT |
| 428 | `{ "error": "Precondition Required: If-Match header or expectedVersion is required for file updates" }` | Missing precondition on PUT |
| 429 | `{ "error": "Too Many Requests", "message": "Rate limit exceeded. Please try again later.", "retryAfter": <epoch-seconds> }` | Rate limiter exhausted (`rateLimitExceededResponse`) |
| 500 | `{ "error": "Internal server error" }` | Unhandled server exception |

---

## Headers

### Request Headers
| Header | Description |
|--------|-------------|
| `Authorization` | Session cookie (Supabase auth); raw bearer tokens are not used by the app client |
| `Content-Type` | `application/json` |
| `If-Match` | ETag for update verification (PUT) |
| `If-None-Match` | ETag for caching (GET) |

### Response Headers
Set by `addRateLimitHeaders()` / route handlers:
| Header | Description |
|--------|-------------|
| `ETag` | Current file ETag |
| `Cache-Control` | Caching instructions |
| `X-RateLimit-Limit` | Configured limit for the endpoint's limiter tier |
| `X-RateLimit-Remaining` | Remaining requests in the current window |
| `X-RateLimit-Reset` | Window reset time (epoch seconds) |
| `Retry-After` | Wait time in seconds (on 429 only) |

---

## Rate Limiting

Configuration lives in `RATE_LIMITS` (`src/lib/rate-limit.ts`) — a sliding-window
counter backed by Upstash Redis, keyed per user:

| Limiter | Applied to | Limit | Window |
|---------|-----------|-------|--------|
| `syncApiRateLimiter` | `GET /api/files/sync` | **100 requests** | **15 minutes** |
| `fileApiRateLimiter` | `GET` / `PUT /api/files/:id` | **200 requests** | **15 minutes** |

### Response (429 Too Many Requests)
```http
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>
X-RateLimit-Limit: 200
X-RateLimit-Remaining: 0
X-RateLimit-Reset: <epoch-seconds>

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Please try again later.",
  "retryAfter": <epoch-seconds>
}
```

---

## Usage Examples

### Fetch updates since last sync
```typescript
const response = await fetch('/api/files/sync?since=' + lastSyncedAt, {
  credentials: 'include', // Supabase session cookie
});

const { files, has_more, next_cursor, sync_timestamp } = await response.json();
if (has_more && next_cursor) {
  // Fetch the next page
  const next = await fetch(`/api/files/sync?since=${lastSyncedAt}&cursor=${encodeURIComponent(next_cursor)}`, {
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
2. **Deterministic Merge Engine:**
   - Non-overlapping line/block changes are cleanly merged.
   - Overlapping regions insert explicit Git-style conflict markers (`<<<<<<< LOCAL ... ======= ... >>>>>>> REMOTE`).
   - Title (`title`) and Move (`parentFolderId`) metadata are merged independently.
   - Delete conflicts (remote delete vs local edit) produce `delete_conflict` requiring explicit "Restore" or "Delete" selection.
3. **Single Authoritative Write:** After user resolution (Local, Server, 3-Way Merge, or Restore), exactly one write request is dispatched to the server containing `expectedVersion: serverVersion.version`.
4. **Verified State Transition:** Editor state (MarkdownEditor / EditorAdapter) and IndexedDB cache are only transitioned to clean (`isDirty: false`) after receiving 200 OK confirmation from the server.
5. **Autosave Lockout:** Autosave is strictly inhibited whenever an unresolved conflict is active.

