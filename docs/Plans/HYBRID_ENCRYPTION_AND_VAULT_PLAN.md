# Zero-Knowledge Cloud Vault & Dual-Tier Hybrid Encryption Plan

Status: ✅ CLOSED (100% Implemented & Verified) · Roadmap: Phase 16 · Reference: [`docs/reference/phase-16/`](../reference/phase-16/)

---

## 1. Architectural Summary

The Dual-Tier Hybrid Encryption architecture in LUGX provides client-side Zero-Knowledge encryption for sensitive documents while maintaining an offline-first experience on TypeScript and React 19 / Next.js:

1. **Always-On Local At-Rest Encryption**: Transparent client-side encryption of all `IndexedDB` tables using an ephemeral device key (`LocalDeviceKey`) without user intervention.
2. **Zero-Knowledge Cloud Vault**: End-to-end client-side encryption for documents flagged with `isEncrypted: true` using `AES-GCM-256` bound to authenticated additional data: `AAD = "vault:file:${userId}:${fileId}"`.
3. **Dual Wrapping & 12-Word BIP-39 Recovery Seed**: The independent Master Key ($K_{\text{master}}$) is wrapped twice: once with the user's vault password, and once with a 12-word BIP-39 recovery seed. This enables password resets and key recovery without re-encrypting existing files.
4. **Zero-Prompt on Login**: Standard application login completes seamlessly without prompting for a vault password. The unlock modal appears strictly upon accessing an encrypted document or encrypting an existing file.
5. **Dynamic Atomic File Conversion**: Instant conversion between plaintext and encrypted states, verifying vault unlock or initiating vault setup on the user's first encrypted file.
6. **Crypto Web Worker & Defensive RAM Sanitization**: Key derivation (`PBKDF2-SHA256` with 600,000 iterations) and symmetric operations are isolated to a background Web Worker (`src/lib/workers/crypto.worker.ts`). CryptoKey handles are non-extractable (`extractable: false`), and intermediate Uint8Array buffers are immediately zeroed via `.fill(0)`.
7. **Non-Blocking Sync & Conflict Isolation**: When a cloud conflict occurs on an encrypted file while the vault is locked, the document transitions to `CONFLICT_LOCKED` without impeding sync for plaintext files. Once unlocked, a 3-way Diff3 merge executes with structural syntax integrity checks before re-encrypting with a fresh IV.
8. **AI Safety Gatekeeper**: Complete dual-layer suppression of AI streaming, prompt inspection, and server routes for encrypted documents (HTTP `403 Forbidden`).

---

## 2. System Architecture Diagrams

### 2.1 Hybrid Data Flow

```mermaid
flowchart TD
    Editor["Editor Engine<br/><b>CodeMirror 6</b><br/>(Plaintext Markdown in RAM)"]

    Standard["📄 <b>Standard Document</b><br/>(isEncrypted: false)"]
    Vault["🔒 <b>Encrypted Document</b><br/>(isEncrypted: true)"]

    Editor --> Standard
    Editor --> Vault

    AI_Active["🤖 <b>AI Operations Active</b><br/>(Stream & Atomic Commit Enabled)"]
    IDB_Local["💾 <b>Local IndexedDB</b><br/>(Encrypted via LocalDeviceKey)"]

    Standard --> AI_Active
    Standard --> IDB_Local

    AI_Blocked["🚫 <b>AI Features Blocked</b><br/>(Disabled in UI & 403 Forbidden on API)"]
    Vault_Storage["💾 <b>Local IndexedDB</b><br/>(LocalDeviceKey + Vault Envelope)"]

    Vault --> AI_Blocked
    Vault --> Vault_Storage

    CloudDB[("🗄️ <b>PostgreSQL Database</b><br/>• Plaintext for Standard Files<br/>• Ciphertext Envelope for Vault Files")]

    AI_Active -- "Plaintext over TLS" --> CloudDB
    IDB_Local -- "Plaintext sync over TLS" --> CloudDB
    Vault_Storage -- "Ciphertext Envelope only" --> CloudDB

    Worker["⚡ <b>Crypto Web Worker</b><br/>(PBKDF2 600K / AES-GCM-256)<br/>• Non-Extractable CryptoKeys<br/>• Immediate .fill(0) RAM Sanitization"]
    Worker <--> IDB_Local
    Worker <--> Vault_Storage

    style Editor fill:#E3F2FD,stroke:#1565C0,stroke-width:2px,color:#0D47A1
    style Standard fill:#F1F8E9,stroke:#558B2F,stroke-width:2px,color:#33691E
    style Vault fill:#FFF3E0,stroke:#E65100,stroke-width:2px,color:#BF360C
    style AI_Active fill:#E8F5E9,stroke:#2E7D32,stroke-width:1.5px,color:#1B5E20
    style IDB_Local fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px,color:#311B92
    style Vault_Storage fill:#EDE7F6,stroke:#512DA8,stroke-width:1.5px,color:#311B92
    style AI_Blocked fill:#FFEBEE,stroke:#C62828,stroke-width:1.5px,color:#B71C1C
    style CloudDB fill:#ECEFF1,stroke:#37474F,stroke-width:2px,color:#263238
    style Worker fill:#FFF9C4,stroke:#FBC02D,stroke-width:1.5px,color:#F57F17
```

---

### 2.2 Vault Unlock & Recovery Sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Application UI
    participant Orch as useEditorOrchestrator
    participant Modal as VaultUnlockModal
    participant Worker as Crypto Web Worker
    participant KeyStore as SessionKeyStore (RAM)
    participant DB as Cloud Database

    User->>UI: Select Encrypted File 🔒
    UI->>Orch: Check Document Metadata (isEncrypted == true)
    Orch->>KeyStore: Query Master Key in Session RAM

    alt Master Key Present (Vault Unlocked)
        KeyStore-->>Orch: CryptoKey handle
        Orch->>Worker: Decrypt Envelope (Ciphertext, IV, AAD)
        Worker-->>Orch: Plaintext Markdown
        Orch->>UI: Render in CodeMirror 6 Editor
    else Master Key Missing (Vault Locked)
        KeyStore-->>Orch: Key Not Available
        Orch->>Modal: Open VaultUnlockModal
        User->>Modal: Input Password or Recovery Seed
        Modal->>Worker: Derive K_derive (PBKDF2 600K) & Unwrap K_master
        Worker-->>Modal: Verified K_master
        Modal->>KeyStore: Cache K_master in RAM
        Modal->>Orch: Vault Unlocked Signal
        Orch->>Worker: Decrypt File Content
        Worker-->>Orch: Plaintext Markdown
        Orch->>UI: Render in CodeMirror 6 Editor
    end
```

---

## 3. Milestones Breakdown & Verification Status

### Milestone 1: Cryptographic Core & Worker Offloading — Status: ✅ CLOSED
- Offloaded PBKDF2 600,000 iterations to Web Worker (`src/lib/workers/crypto.worker.ts`).
- Non-extractable Web Crypto keys with strict in-memory buffer sanitization (`.fill(0)`).
- Documented in [`docs/reference/phase-16/vault-phase-1-crypto-core-closure.md`](../reference/phase-16/vault-phase-1-crypto-core-closure.md).

### Milestone 2: IndexedDB Local Storage & Sync Protocol — Status: ✅ CLOSED
- Local transparent encryption via `LocalDeviceKey`.
- Handled `CONFLICT_LOCKED` sync state without blocking plaintext file synchronization.
- Documented in [`docs/reference/phase-16/vault-phase-2-idb-and-sync-closure.md`](../reference/phase-16/vault-phase-2-idb-and-sync-closure.md).

### Milestone 3: UI Surfaces & Lifecycle Conversion — Status: ✅ CLOSED
- Modal interfaces for creation, unlock, PIN setup, and BIP-39 recovery seed verification (`src/components/vault/`).
- Seamless bidirectional plaintext/ciphertext conversion engine.
- Documented in [`docs/reference/phase-16/vault-phase-3-ui-and-conversion-closure.md`](../reference/phase-16/vault-phase-3-ui-and-conversion-closure.md).

### Milestone 4: AI Safety Gatekeeper & End-to-End Hardening — Status: ✅ CLOSED
- Enforced HTTP 403 on `/api/ai/stream` for encrypted documents.
- Suppressed all AI UI controls when active file is encrypted.
- Documented in [`docs/reference/phase-16/vault-phase-4-ai-safety-and-e2e-closure.md`](../reference/phase-16/vault-phase-4-ai-safety-and-e2e-closure.md).

### Milestone 5: Verification & Production Audit — Status: ✅ CLOSED
- Complete cryptographic suite verification, memory leak testing, and recovery drill validation.
- Documented in [`docs/reference/phase-16/vault-phase-5-verification-and-production-audit-closure.md`](../reference/phase-16/vault-phase-5-verification-and-production-audit-closure.md).
