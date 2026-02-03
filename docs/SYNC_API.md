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
```json
{
  "files": [
    {
      "id": "file-uuid",
      "content": "file content...",
      "title": "Document Title",
      "etag": "abc123def456",
      "version": 5,
      "updatedAt": "2026-02-01T12:00:00Z",
      "parentFolderId": "folder-uuid",
      "isFolder": false
    }
  ],
  "deletedIds": ["deleted-file-id-1", "deleted-file-id-2"],
  "cursor": "next-page-cursor",
  "has_more": true,
  "server_time": 1706832000000
}
```

#### Rate Limiting
- **Limit:** 100 requests/minute per user
- **Header:** `X-RateLimit-Remaining: 95`

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
  "title": "Updated Title"
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

{
  "error": "CONFLICT_DETECTED",
  "message": "File was modified on server",
  "serverVersion": {
    "etag": "server-etag",
    "version": 6,
    "updatedAt": "2026-02-01T12:25:00Z"
  }
}
```

---

## Error Responses

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_REQUEST` | Invalid request |
| 401 | `UNAUTHORIZED` | Not authenticated |
| 403 | `FORBIDDEN` | Not authorized |
| 404 | `NOT_FOUND` | File not found |
| 409 | `CONFLICT` | Data conflict |
| 412 | `PRECONDITION_FAILED` | ETag mismatch |
| 429 | `RATE_LIMITED` | Rate limit exceeded |
| 500 | `SERVER_ERROR` | Server error |

### Error Response Format
```json
{
  "error": "ERROR_CODE",
  "message": "Human readable message",
  "details": { ... }
}
```

---

## Headers

### Request Headers
| Header | Description |
|--------|-------------|
| `Authorization` | `Bearer <token>` |
| `Content-Type` | `application/json` |
| `If-Match` | ETag for update verification |
| `If-None-Match` | ETag for caching |

### Response Headers
| Header | Description |
|--------|-------------|
| `ETag` | Current file ETag |
| `Cache-Control` | Caching instructions |
| `X-RateLimit-Remaining` | Remaining requests |
| `Retry-After` | Wait time (on 429) |

---

## Rate Limiting

### Configuration
- **Window:** 1 minute (sliding)
- **Limit:** 100 requests per user
- **Backend:** Redis

### Response (429 Too Many Requests)
```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Remaining: 0

{
  "error": "RATE_LIMITED",
  "message": "Too many requests",
  "retryAfter": 30
}
```

---

## Usage Examples

### Fetch updates since last sync
```typescript
const response = await fetch('/api/files/sync?since=' + lastSyncedAt, {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});

const { files, deletedIds, cursor, has_more } = await response.json();
```

### Update with conflict detection
```typescript
const response = await fetch(`/api/files/${fileId}`, {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'If-Match': currentEtag,
  },
  body: JSON.stringify({ content, title }),
});

if (response.status === 412) {
  // Handle conflict
  const { serverVersion } = await response.json();
  // Show conflict resolution UI
}
```
