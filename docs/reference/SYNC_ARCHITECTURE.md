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

### 1. Presentation & Orchestration Layer

| Component | Responsibility |
|-----------|----------------|
| `useEditorOrchestrator` | Centralized state controller & single authoritative write gateway (Phase 9) |
| `Editor Page` | Main user interface and Standalone Markdown Editor surface (CodeMirror 6 / EditorAdapter) |
| `useSync Hook` | Scoped React synchronization integration |
| `ConflictDialog` | Conflict resolution interactive UI |
| `SyncIndicator` | Visual synchronization status indicator |

### 2. Business Layer

| Component | Responsibility |
|-----------|----------------|
| `SyncManager` | Push/Pull coordination |
| `ConflictResolver` | Conflict detection & resolution |
| `ConcurrencyManager` | File-level locking |
| `ConnectionDetector` | Network monitoring |

### 3. Data & Cryptography Layer

| Component | Responsibility |
|-----------|----------------|
| `IndexedDBManager` | Local document & operations storage |
| `ETagGenerator` | SHA-256 change detection & optimistic concurrency |
| `SyncRollback` | State checkpoints & isolated failure recovery |
| `Encryption` (`EncryptionManager`) | Dual-tier hybrid encryption orchestration (`AES-GCM-256` + AAD) |
| `CryptoWorkerBridge` | Typed isomorphic RPC bridge (Web Worker / Direct SubtleCrypto) |
| `crypto.worker.ts` | Isolated Web Worker for PBKDF2 (600,000 iter) & AES-GCM offloading |
| `SessionKeyStore` | Volatile in-memory key manager with deterministic auto-lock |
| `BIP39 Mnemonic` (`mnemonic.ts`) | Standard 12-word seed generation & 4-bit SHA-256 checksum verification |

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

v1.5.0 Amendment (Editor Surface): the initial-load pipeline in
useEditorOrchestrator classifies every remote update via the deterministic
classifyRemoteUpdate policy (apply = fast-forward when local is clean and the
remote is verified-newer; adopt_metadata on identical payloads; keep_local on
dirty divergence or non-newer remote). See editor-sync-orchestration.md §6a.
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

Actual hook contract from [`src/hooks/use-sync.ts`](../../src/hooks/use-sync.ts):

```tsx
import { useSync } from '@/hooks/use-sync';

function EditorPage({ fileId }: { fileId: string }) {
  const {
    status,           // SyncStatus: 'idle' | 'loading' | 'queued' | 'syncing' |
                      //   'conflict' | 'failed' | 'stopped' | 'offline'
    connectionState,  // ConnectionState from ConnectionDetector
    isInitialized,    // boolean
    lastSyncResult,   // SyncResult | null
    pendingCount,     // number of dirty files awaiting sync
    sync,             // () => Promise<SyncResult>
    syncFile,         // (fileId: string) => Promise<void>
    saveLocal,        // (file: Partial<IDBFile> & { id, content }) => Promise<void>
    loadLocal,        // (fileId: string) => Promise<IDBFile | null>
    markDirty,        // (fileId: string) => Promise<void>
  } = useSync({
    userId,
    autoSyncInterval: 30000,
    // Conflicts are NOT returned by the hook; they surface either through the
    // optional `onConflict` callback option or through the editor orchestrator
    // (see docs/architecture/editor-sync-orchestration.md).
    onConflict: async (conflict) => 'merge',
  });

  return (
    <>
      <SyncIndicator status={status} pending={pendingCount} />
      <Editor onSave={saveLocal} initialContent={loadLocal} />
    </>
  );
}
```

---

## Performance & Optimization

### Rate Limiting
- **Sync API:** 100 requests per user per 15-minute sliding window
- **File API:** 200 requests per user per 15-minute sliding window
- Sliding-window counters backed by Upstash Redis

### Garbage Collection
- Merge consecutive operations (compaction threshold: 1,000 operations per file — `IDB_CONFIG.MAX_OPERATIONS_PER_FILE`)
- Delete operations older than 7 days (`IDB_CONFIG.MAX_OPERATION_AGE_MS`), never touching `queued`, `syncing`, `conflict`, or `rollback_failed` entries
- Scheduled via `gc.schedule()` with a default interval of **10 minutes** (minimum spacing between runs: 5 minutes)

### Performance Monitoring
```typescript
performanceMonitor.startTiming('syncFile');
await syncFile(fileId);
performanceMonitor.endTiming('syncFile');
// Logs: [Performance] syncFile: 234ms
```
