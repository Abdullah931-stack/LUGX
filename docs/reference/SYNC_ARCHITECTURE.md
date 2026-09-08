# Sync System Architecture

> Detailed architecture documentation for the synchronization system

## System Flow Diagram

```mermaid
graph TD
    subgraph ClientLayer["LUGX Client Workspace"]
        Page["Editor Page (CodeMirror 6 / EditorAdapter)"] --> Orch["useEditorOrchestrator"]
        Orch --> Hook["useSync Hook"]
        Hook --> SyncMgr["SyncManager"]
        SyncMgr --> Push["Push Engine"]
        SyncMgr --> Pull["Pull Engine"]
        Push & Pull --> IDBMgr["IndexedDB Manager (textai_db_{userId})"]
        IDBMgr --> IDBFiles["Files Store (Markdown / Encrypted Envelopes)"]
        IDBMgr --> IDBOps["Operations Store (Delta Logs)"]
        IDBMgr --> IDBMeta["Sync Metadata Store (Cached Profiles & Device Trust)"]
        SyncMgr -.->|"Quarantine locked conflicts"| Quarantine["pendingEncryptedConflicts (CONFLICT_LOCKED)"]
    end

    SyncMgr <-->|"HTTP REST (If-Match / If-None-Match / Strong ETags / Rate Limits)"| APILayer["API Gateway Layer (/api/files & /api/ai)"]
    APILayer <-->|"Drizzle ORM / Adaptive Pool (Neon / pg.Pool)"| DBLayer[("PostgreSQL Database (files, users, user_vault_profiles)")]
```

---

## Layers & Components

### 1. Presentation & Orchestration Layer

| Component | Responsibility |
|-----------|----------------|
| `useEditorOrchestrator` | Centralized state controller, `vault_locked` hydration gate, pre-flight AI gating, and authoritative write gateway |
| `Editor Page` | Main user interface and Standalone Markdown Editor surface (CodeMirror 6 / EditorAdapter) |
| `AIToolbar` | Formatting tools, direction controls, and Zero-Knowledge AI shield privacy badge (`ai-encrypted-badge`) |
| `CreateVaultModal` | Zero-Knowledge vault initialization, BIP-39 mnemonic generation & 3-word challenge |
| `VaultUnlockModal` | Multi-modal unlock interface (Password, BIP-39 Seed, Hardware Biometrics PRF, 6-digit PIN) |
| `TrustDeviceModal` | Dual-mode trusted device setup (Hardware Biometrics WebAuthn PRF or 6-digit PIN) |
| `VaultSecurityCard` | Account security settings panel, AI opt-in toggle (`allowAIOnEncryptedFiles`), and device trust revocation |
| `FileContextMenu` | Dynamic encryption/decryption toggling and client-side re-encrypted copy execution |
| `useSync Hook` | Scoped React synchronization integration |
| `ConflictDialog` | Conflict resolution interactive UI with double-encryption guard (AUD-03) |
| `SyncIndicator` | Visual synchronization status indicator |

### 2. Business Layer

| Component | Responsibility |
|-----------|----------------|
| `SyncManager` | Push/Pull coordination, non-blocking sync with `CONFLICT_LOCKED` quarantine, and reactive unlock auto-resolution |
| `ConflictResolver` | Conflict detection, 3-way merge orchestration (LCS delta engine), and false conflict elimination |
| `SyntaxValidator` (`syntax-validator.ts`) | Post-merge Markdown syntax integrity verification (code fence pairing, GFM table alignment, null-byte prevention) |
| `ConcurrencyManager` | In-memory mutex promise locking per file ID |
| `ConnectionDetector` | Network monitoring with exponential backoff and jitter |
| `Vault Server Actions` (`vault-actions.ts`) | Atomic vault profile CRUD, AI setting persistence (`updateVaultAISetting`), and remote device revocation |
| `File Operations` (`file-ops.ts`) | Optimistic `toggleFileEncryption` & client-re-encrypted `copyFile` guard (AUD-02) |
| `AI Commit Action` (`ai-commit.ts`) | Transactional AI commit with Zero-Knowledge plaintext rejection and automatic reservation refunding |

### 3. Data & Cryptography Layer

| Component | Responsibility |
|-----------|----------------|
| `IndexedDBManager` | Local document & operations storage, offline vault profile caching, and device trust storage |
| `ETagGenerator` | Deterministic SHA-256 ETag generation with canonical JSON key serialization (`CANONICAL_ENVELOPE_KEYS`) |
| `SyncRollback` | State checkpoints & isolated failure recovery |
| `Encryption` (`encryption.ts`) | Dual-tier hybrid encryption orchestration (`AES-GCM-256` + AAD `vault:file:${userId}:${fileId}`) |
| `WebAuthn PRF Engine` (`webauthn-prf.ts`) | Hardware-bound biometrics key derivation via W3C Level 3 PRF extension & HKDF-SHA-256 |
| `PIN KEK Engine` (`encryption.ts`) | 6-digit PIN KEK derivation (PBKDF2 600K iterations, $1,000,000$ combinations) |
| `Device Trust Wrapping` (`encryption.ts`) | AES-GCM-256 wrapping, 30-day expiry, 5-attempt anti-brute-force lockout |
| `CryptoWorkerBridge` | Typed isomorphic RPC bridge with self-healing circuit breaker & automatic queue drain |
| `SyncCryptoGateway` (`sync-crypto-gateway.ts`) | Transparent inbound decryption (server IV + MasterKey) & fresh outbound CSPRNG IV re-encryption |
| `crypto-utils.ts` | Decoupled cryptographic primitives, W3C chunked CSPRNG & RAM sanitization (`wipeBuffer`) |
| `crypto.worker.ts` | Isolated Web Worker for PBKDF2 (600,000 iter) & heavy symmetric offloading |
| `SessionKeyStore` | Volatile RAM-only key manager with 1-hour auto-lock, unlock event subscription, and CodeMirror keystroke touch |
| `BIP39 Mnemonic` (`mnemonic.ts`) | Standard 12-word seed generation & 4-bit SHA-256 checksum verification |

---

## Sync Flows

### Push Flow (Local → Server)

```mermaid
sequenceDiagram
    autonumber
    participant UI as User / Editor
    participant IDB as IndexedDB
    participant Sync as SyncManager
    participant Lock as ConcurrencyManager
    participant Safe as SyntaxValidator
    participant API as /api/files/:id

    UI->>IDB: markFileDirty(fileId)
    Sync->>Lock: withLock(fileId)
    alt File is Encrypted and Vault Locked with Conflict
        Sync->>Sync: Isolate into pendingEncryptedConflicts (CONFLICT_LOCKED)
        Note over Sync: pushDirtyFiles skips locked file without blocking others
    else Standard Push or Unlocked Vault
        Sync->>API: PUT /api/files/:id (If-Match: etag)
        alt 200 OK
            API-->>Sync: Success { etag, version }
            Sync->>IDB: markFileClean(fileId)
        else 412 Conflict
            API-->>Sync: serverVersion
            alt File is Encrypted and Vault is Locked
                Sync->>Sync: Quarantine as CONFLICT_LOCKED
            else Vault Unlocked
                Sync->>Safe: 3-Way Merge + Syntax Integrity Validation
                alt Syntax Valid
                    Sync->>API: Re-encrypt with fresh CSPRNG IV & push
                else Syntax Corrupted
                    Sync->>UI: Show ConflictDialog for manual resolution
                end
            end
        end
    end
    Sync->>Lock: Release lock
```

### Pull Flow (Server → Local)

```mermaid
sequenceDiagram
    autonumber
    participant Sync as SyncManager
    participant API as /api/files/sync
    participant GW as SyncCryptoGateway
    participant IDB as IndexedDB
    participant Orch as useEditorOrchestrator
    participant CM as CodeMirror Surface

    Sync->>API: GET /api/files/sync?since=lastSync
    API-->>Sync: Updated files list
    loop For each updated file
        alt Local file is clean & remote is newer
            Sync->>IDB: saveFile(remoteData)
            alt File is Encrypted & Vault Unlocked
                Sync->>GW: decryptInbound(remoteData.content, remoteData.encryptionMetadata)
                GW-->>Sync: decryptedPlaintext
                Sync->>Orch: onRemoteUpdate({ content: decryptedPlaintext })
                Orch->>CM: adapter.setValue(decryptedPlaintext)
            else Unencrypted File
                Sync->>Orch: onRemoteUpdate({ content: remoteData.content })
                Orch->>CM: adapter.setValue(remoteData.content)
            end
        else Local file is dirty (Conflict)
            alt Encrypted & Vault Locked
                Sync->>Sync: Quarantine as CONFLICT_LOCKED
            else Vault Unlocked
                Sync->>Orch: Trigger Three-Way Merge / Conflict UI
            end
        end
    end
    Sync->>IDB: Update lastSyncedAt
```

### Conflict Resolution Flow (HTTP 412)

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Orch as useEditorOrchestrator
    participant GW as SyncCryptoGateway
    participant Dialog as ConflictDialog (Diff3)
    participant CM as CodeMirror Surface
    participant Server as /api/files/:id
    participant IDB as IndexedDB

    Orch->>Server: PUT /api/files/:id (Stale ETag)
    Server-->>Orch: HTTP 412 Precondition Failed<br/>{ serverVersion: { content, encryptionMetadata: { iv: "serverIv" } } }
    Orch->>GW: decryptInbound(serverVersion.content, serverVersion.encryptionMetadata)
    GW-->>Orch: serverVersionPlaintext
    alt False Conflict (localPlaintext === serverVersionPlaintext)
        Orch->>Orch: Adopt remote version & ETag silently
    else True Conflict
        Orch->>Dialog: Mount ConflictDialog(localPlaintext, serverVersionPlaintext)
        User->>Dialog: Select Resolution ("mine" | "server" | "merge")
        Dialog->>Orch: handleResolveConflict(resolvedPlaintext)
        Orch->>CM: adapter.setValue(resolvedPlaintext)
        alt Encrypted File
            Orch->>GW: encryptOutbound(fileId, resolvedPlaintext, userId)
            GW-->>Orch: { ciphertextBase64, freshMetadata (12-byte CSPRNG IV) }
            Orch->>Server: toggleFileEncryption(fileId, true, ciphertextBase64, freshMetadata)
        else Unencrypted File
            Orch->>Server: PUT /api/files/:id (resolvedPlaintext)
        end
        Server-->>Orch: 200 OK { version, etag }
        Orch->>IDB: saveFile(clean) & isDirty: false
    end
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

### 4. Tab Wakeup Auto-Healing & Local Durability (`useEditorOrchestrator`)
```typescript
// Replays pending IndexedDB persistence upon visibilitychange/focus
if (document.visibilityState === "visible" && pendingLocalSyncRef.current) {
  pendingLocalSyncRef.current = false; // Synchronous consumption prevents dual-event race
  await syncHookRef.current.saveLocal({ ... });
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
