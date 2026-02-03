# Advanced Synchronization System - Complete Documentation

> **Version:** 1.0.0  
> **Last Updated:** 2026-02-01  
> **Unit Tests:** 197/197 passed (100%)

## Overview

An advanced synchronization system providing **Offline-First** experience with full support for:
- Local storage via IndexedDB
- Change detection using ETags (SHA-256)
- Conflict resolution with Three-Way Merge
- End-to-end encryption (AES-GCM)
- Performance monitoring and auto-optimization

---

## Project Structure

```
src/
├── lib/
│   ├── sync/                          # Core sync system
│   │   ├── idb-types.ts               # TypeScript types
│   │   ├── indexeddb.ts               # IndexedDB Manager
│   │   ├── etag-generator.ts          # ETag generation/comparison
│   │   ├── error-handler.ts           # Error handling
│   │   ├── rollback.ts                # Checkpoint/Rollback
│   │   ├── connection-detector.ts     # Connection monitoring
│   │   ├── concurrency-manager.ts     # File-level locking
│   │   ├── sync-manager.ts            # Main coordinator
│   │   ├── conflict-resolver.ts       # Three-Way Merge
│   │   ├── performance-monitor.ts     # Performance tracking
│   │   ├── operations-gc.ts           # Garbage Collection
│   │   ├── encryption.ts              # AES-GCM + PBKDF2
│   │   └── index.ts                   # Barrel exports
│   ├── db/
│   │   ├── schema.ts                  # [Modified] + etag, version, deletedAt
│   │   └── migrations/
│   │       ├── 0001_add_sync_fields.sql
│   │       └── 0002_populate_etags.sql
│   └── rate-limit.ts                  # Rate limiting with Redis
│
├── app/api/files/
│   ├── sync/route.ts                  # GET /api/files/sync
│   └── [id]/route.ts                  # GET/PUT /api/files/:id
│
├── components/sync/
│   ├── conflict-dialog.tsx            # Conflict resolution UI
│   └── sync-indicator.tsx             # Status indicator
│
├── hooks/
│   └── use-sync.ts                    # React integration hook
│
└── server/actions/
    └── file-ops.ts                    # [Modified] + ETag generation
```

---

## Core Modules

### 1. IndexedDB Manager
**File:** `src/lib/sync/indexeddb.ts`

```typescript
// Main functions
indexedDBManager.init()           // Initialize database
indexedDBManager.saveFile(file)   // Save file
indexedDBManager.getFile(id)      // Get file
indexedDBManager.getDirtyFiles()  // Get pending files
indexedDBManager.markFileDirty()  // Mark for sync
indexedDBManager.markFileClean()  // Clear after sync
```

### 2. Sync Manager
**File:** `src/lib/sync/sync-manager.ts`

```typescript
// Main functions
syncManager.init({ userId })      // Initialize manager
syncManager.sync()                // Full sync (Push + Pull)
syncManager.syncFile(fileId)      // Sync specific file
syncManager.queueSync(fileId)     // Add to queue
syncManager.getStatus()           // idle | syncing | error | offline
```

### 3. Conflict Resolver
**File:** `src/lib/sync/conflict-resolver.ts`

```typescript
// Resolution strategies
type ResolutionStrategy = 'local' | 'server' | 'merge';

conflictResolver.detectConflict(localFile, serverEtag)
conflictResolver.attemptAutoMerge(base, local, server)
conflictResolver.resolveConflict(conflict, strategy, mergedContent?)
```

### 4. ETag Generator
**File:** `src/lib/sync/etag-generator.ts`

```typescript
// SHA-256 based ETags
await generateETag({ id, content, updatedAt })
generateETagSync({ id, content, updatedAt })
compareETags(localEtag, serverEtag)  // Supports W/ and quotes
isValidETag(etag)
parseETagHeader(header)
formatETagHeader(etag)
```

---

## Related Documentation

| File | Description |
|------|-------------|
| [SYNC_ARCHITECTURE.md](./SYNC_ARCHITECTURE.md) | Detailed architecture |
| [SYNC_API.md](./SYNC_API.md) | API documentation |
| [SYNC_UNIT_TESTS_FIXES.md](./SYNC_UNIT_TESTS_FIXES.md) | Test fixes |

---

## Getting Started

### Run Migrations
```bash
npx drizzle-kit push
```

### Run Tests
```bash
# All tests
npm test -- --run

# Sync tests only
npm test -- --run src/lib/sync
```

### Editor Integration
```tsx
import { useSync } from '@/hooks/use-sync';

function Editor({ fileId }) {
  const {
    status,
    sync,
    saveLocally,
    loadFromLocal,
    pendingChanges
  } = useSync({ userId, fileId });
  
  // ...
}
```

---

## Statistics

| Metric | Value |
|--------|-------|
| **New Files** | 19 |
| **Modified Files** | 2 |
| **Lines of Code** | ~2,500 |
| **Unit Tests** | 197 (100% pass) |
| **Test Files** | 11 |
