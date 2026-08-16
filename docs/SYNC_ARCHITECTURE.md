# Sync System Architecture

> Detailed architecture documentation for the synchronization system

## System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         LUGX Editor                              │
│  ┌─────────┐    ┌──────────┐    ┌───────────────────────────┐   │
│  │ Editor  │───▶│ useSync  │───▶│     SyncManager           │   │
│  │  Page   │    │   Hook   │    │  ┌─────────┐ ┌─────────┐  │   │
│  └─────────┘    └──────────┘    │  │  Push   │ │  Pull   │  │   │
│                                  │  │ Engine  │ │ Engine  │  │   │
│                                  │  └────┬────┘ └────┬────┘  │   │
│                                  └───────┼──────────┼────────┘   │
│                                          │          │            │
│  ┌─────────────────────────────┐         │          │            │
│  │      IndexedDB Manager      │◀────────┴──────────┘            │
│  │  ┌───────┐ ┌───────────┐    │                                 │
│  │  │ Files │ │Operations │    │                                 │
│  │  └───────┘ └───────────┘    │                                 │
│  └─────────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
                                   │          ▲
                                   ▼          │
                    ┌──────────────────────────────────┐
                    │           API Layer              │
                    │  ┌────────────┐ ┌────────────┐   │
                    │  │ /sync      │ │ /files/:id │   │
                    │  └────────────┘ └────────────┘   │
                    │     + Rate Limiting              │
                    │     + ETag Headers               │
                    └──────────────────────────────────┘
                                   │          ▲
                                   ▼          │
                    ┌──────────────────────────────────┐
                    │        PostgreSQL + Drizzle      │
                    │  ┌───────┐ ┌───────┐ ┌───────┐   │
                    │  │ Files │ │Folders│ │ Users │   │
                    │  └───────┘ └───────┘ └───────┘   │
                    └──────────────────────────────────┘
```

---

## Layers & Components

### 1. Presentation Layer

| Component | Responsibility |
|-----------|----------------|
| `Editor Page` | Main user interface |
| `useSync Hook` | React integration |
| `ConflictDialog` | Conflict resolution UI |
| `SyncIndicator` | Visual status indicator |

### 2. Business Layer

| Component | Responsibility |
|-----------|----------------|
| `SyncManager` | Push/Pull coordination |
| `ConflictResolver` | Conflict detection & resolution |
| `ConcurrencyManager` | File-level locking |
| `ConnectionDetector` | Network monitoring |

### 3. Data Layer

| Component | Responsibility |
|-----------|----------------|
| `IndexedDBManager` | Local storage |
| `ETagGenerator` | Change detection |
| `SyncRollback` | State recovery |
| `Encryption` | Data encryption |

---

## Sync Flows

### Push Flow (Local → Server)
```
1. User saves file
2. IndexedDB.markFileDirty(fileId)
3. SyncManager.queueSync(fileId)
4. SyncManager.syncFile(fileId)
   ├─ ConcurrencyManager.withLock(fileId)
   ├─ SyncRollback.createCheckpoint()
   ├─ ETagGenerator.generateETag()
   └─ API.PUT /files/:id (If-Match: etag)
       ├─ 200 OK → IndexedDB.markFileClean()
       ├─ 412 Conflict → ConflictResolver.resolve()
       └─ Error → SyncRollback.rollback()
```

### Pull Flow (Server → Local)
```
1. SyncManager.sync() triggered
2. API.GET /files/sync?since=lastSync
3. For each updated file:
   ├─ Check local version
   ├─ If conflict → ConflictResolver
   └─ IndexedDB.saveFile()
4. Update lastSyncedAt
```

---

## Protection Mechanisms

### 1. Optimistic Locking (ETags)
```http
PUT /api/files/:id
If-Match: "current-etag"

→ 200 OK (etag matched)
→ 412 Precondition Failed (conflict)
```

### 2. File-Level Locking
```typescript
await concurrencyManager.withLock(fileId, async () => {
  // Safe: only one operation at a time per file
});
```

### 3. Checkpoint/Rollback
```typescript
const checkpoint = await rollback.createCheckpoint(fileId, 'pre_sync');
try {
  await riskyOperation();
} catch {
  await rollback.rollback(checkpoint);
}
```

---

## Error Handling

| Error Type | Response |
|------------|----------|
| `NETWORK_ERROR` | Retry with exponential backoff |
| `CONFLICT_ERROR` | Show ConflictDialog |
| `RATE_LIMIT_ERROR` | Wait + Retry |
| `AUTH_ERROR` | Redirect to login |
| `QUOTA_EXCEEDED` | Alert user + cleanup |
| `STORAGE_ERROR` | Log + graceful degradation |

---

## React Integration

```tsx
import { useSync } from '@/hooks/use-sync';

function EditorPage({ fileId }) {
  const {
    status,           // 'idle' | 'syncing' | 'error' | 'offline'
    lastSyncedAt,     // timestamp
    pendingChanges,   // number
    sync,             // () => Promise<void>
    saveLocally,      // (content) => Promise<void>
    loadFromLocal,    // () => Promise<File>
    conflict,         // SyncConflict | null
    resolveConflict,  // (strategy) => Promise<void>
  } = useSync({ userId, fileId });

  // Auto-sync on changes
  useEffect(() => {
    const timer = setInterval(sync, 30000);
    return () => clearInterval(timer);
  }, [sync]);

  return (
    <>
      <SyncIndicator status={status} pending={pendingChanges} />
      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onResolve={resolveConflict}
        />
      )}
      <Editor
        onSave={saveLocally}
        initialContent={loadFromLocal}
      />
    </>
  );
}
```

---

## Performance & Optimization

### Rate Limiting
- 100 requests/minute per user
- Sliding window algorithm
- Redis-backed

### Garbage Collection
- Merge consecutive operations
- Delete operations > 7 days old
- Auto-run every 24 hours

### Performance Monitoring
```typescript
performanceMonitor.startTiming('syncFile');
await syncFile(fileId);
performanceMonitor.endTiming('syncFile');
// Logs: [Performance] syncFile: 234ms
```
