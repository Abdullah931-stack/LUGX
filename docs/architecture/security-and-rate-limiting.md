# Security Architecture & Rate Limiting

This document covers the cross-cutting security layers of the LUGX platform:
request authentication, rate limiting, content sanitization, local data
encryption, and the protected maintenance cron. Everything here is derived from
the current source files referenced inline.

---

## 1. Request Authentication (`src/proxy.ts`)

The Next.js 16 Edge proxy runs on every route except static assets (see its
`config.matcher`). Behavior:

| Concern | Implementation |
| :--- | :--- |
| Protected pages | `/workspace`, `/account`, `/dashboard` require a Supabase session (`supabase.auth.getUser()`); unauthenticated page navigations redirect to `/login?redirectTo=…` (preserving search params / deep links) |
| Server Actions & API routes | Under the same protected paths, an unauthenticated request receives a **JSON `401 Unauthorized`** instead of an HTML redirect (an HTML redirect breaks the Server Action client runtime) |
| Logged-in access control | Authenticated users hitting `/login` are redirected to `/dashboard` |
| OAuth code interception | Any request carrying an OAuth `code` query param is redirected to `/auth/callback`, unless it already targets that path |
| Session refresh | The proxy refreshes the Supabase session cookie on every matched request |

### 1.1. Open Redirect & Host Header Injection Hardening (`src/lib/auth/safe-redirect.ts`)

All redirect parameters entering the authentication pipeline are strictly validated by `resolveSafeRedirectPath(target, defaultPath)`:
- **MAX_URL_LENGTH = 2048**: Enforces upfront bounds to prevent ReDoS/CPU exhaustion.
- **Universal Backslash Rejection**: Rejects any occurrence of `\` in the target or decoded representation.
- **Unicode Normalization (`NFKC`)**: Rejects homographs (full-width solidus `／`, reverse solidus `＼`, small solidus `﹨`) and zero-width characters (`\u200B-\u200D`, `\uFEFF`).
- **Control Character & Null-Byte Stripping**: Strips ASCII `0x00-0x1F`, `0x7F`, and blocks null-byte/CRLF injection.
- **Iterative 3-Pass Decoding**: Prevents multi-encoded bypasses (`/%2F%2Fevil.com`).
- **Scheme & Protocol Rejection**: Rejects `javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, `about:`, `mailto:`, `tel:`, `sms:`, `urn:`, and external protocols `http:`, `https:`.
- **OAuth Callback (`/auth/callback`)**: Redirection targets are anchored exclusively to trusted origins (`process.env.NEXT_PUBLIC_APP_URL || origin`), completely ignoring spoofable `x-forwarded-host` headers.

### 1.2. Cross-User Resource Isolation & Anti-Enumeration (404 vs 403)

To prevent resource enumeration (probing for valid UUIDs via 403 vs 404 responses), all lookups across `file-ops.ts`, `import-file.ts`, and `stream/route.ts` return unified `404 Not Found` responses when foreign/unauthorized resources are accessed.

Defense-in-depth note: proxy gating complements — never replaces — the
per-route `getUser()` checks performed inside every API route and server action
(see [`file-ownership-and-versioning.md`](./file-ownership-and-versioning.md) and [`../reference/phase-12-auth-ownership-closure.md`](../reference/phase-12-auth-ownership-closure.md)).

---

## 2. Rate Limiting (`src/lib/rate-limit.ts`)

A per-user **sliding-window counter** backed by Upstash Redis. Configuration:

```ts
export const RATE_LIMITS = {
    SYNC_API: { limit: 100, windowSeconds: 15 * 60 }, // sync endpoint
    FILE_API: { limit: 200, windowSeconds: 15 * 60 }, // single-file GET/PUT
    GENERAL:  { limit: 300, windowSeconds: 15 * 60 },
    AUTH:     { limit: 20,  windowSeconds: 15 * 60 }, // sign-in/sign-up brute-force guard
} as const;
```

Exported limiter instances and their consumers:

| Instance | Key prefix | Used by |
| :--- | :--- | :--- |
| `syncApiRateLimiter` | `sync` | `GET /api/files/sync` |
| `fileApiRateLimiter` | `file` | `GET` / `PUT /api/files/[id]` |
| `authRateLimiter` | `auth` | authentication endpoints |

Response contract:

- Success responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` (set by `addRateLimitHeaders()`).
- Exhaustion returns **429** from `rateLimitExceededResponse()` with a
  `Retry-After` header and body `{ error, message, retryAfter }`.

Endpoint-level details: [`../reference/SYNC_API.md`](../reference/SYNC_API.md).

---

## 3. Content Safety & Markdown Normalization

Documents in LUGX are stored and processed exclusively as pure UTF-8 Markdown text (`MarkdownSource`). Content integrity and safety are enforced through strict Unicode normalization and client-safe rendering avoiding HTML injection vectors.

### 3.1 Markdown Source Normalization (`src/lib/sync/etag-generator.ts`)
- **Universal Normalization (`normalizeMarkdownSource`)**: Canonical normalization converting `\r\n` and `\r` to LF (`\n`), applying Unicode NFC normalization, and stripping null bytes (`\0`) to guarantee PostgreSQL text encoding safety and deterministic cross-platform ETag generation.

### 3.2 Pure Markdown Content Security & Elimination of HTML Injection Vectors
- **Zero HTML Storage Invariant**: The storage layer (PostgreSQL and IndexedDB) persists pure Markdown text without HTML wrapping or translation.
- **Client-Safe Native Rendering**: The CodeMirror 6 editor and streaming preview surfaces operate directly on Markdown strings and AST token decorations, completely eliminating `dangerouslySetInnerHTML` and legacy HTML sanitizers (`sanitize.server.ts`, `sanitize-client.ts`, `dompurify`).

---

## 4. Dual-Tier Hybrid Encryption & Isolated Crypto Worker (`src/lib/sync/encryption.ts`, `src/lib/workers/crypto.worker.ts`)

LUGX implements a zero-knowledge dual-tier hybrid encryption architecture offloaded to a dedicated Web Worker to ensure zero main-thread UI lag and complete defense-in-depth:

### 4.1 Isolated Cryptographic Execution & Non-Extractable Keys
- **Background Worker Offloading (`src/lib/workers/crypto.worker.ts`)**: All computationally intensive key derivations (PBKDF2 with 600,000 iterations) and symmetric transformations run in an isolated Web Worker via a typed RPC bridge (`src/lib/sync/crypto-worker-bridge.ts`), sustaining 60fps UI performance.
- **Zero-Latency Direct CSPRNG & W3C Chunking (`src/lib/sync/crypto-utils.ts`)**: Cryptographically secure random byte generation (IVs, salts, entropy) executes synchronously via `globalThis.crypto.getRandomValues` (<0.001ms), eliminating Web Worker IPC overhead and preventing background tab throttling deadlocks. Requests exceeding 64KB are automatically chunked to strictly comply with W3C quota limits (`MAX_RANDOM_BYTES_CHUNK = 65536`).
- **Resilient Fallback & Circuit Breaker Queue Drain (`src/lib/sync/crypto-worker-bridge.ts`)**: In the event of Web Worker suspension or unexpected failure (e.g. background tab hibernation or Turbopack worker compilation stall), tasks time out at 5 seconds, trip the circuit breaker (`isTerminated = true`), and immediately drain all queued requests directly into the in-process `SubtleCrypto` engine without hanging the user interface or losing offline persistence.
- **Direct Engine Dual Mode**: In Node.js/SSR and automated test environments, the bridge transparently executes against the direct WebCrypto SubtleCrypto engine with identical security invariants and zero artificial mocking.
- **Non-Extractable CryptoKey Enforcement**: All derived and imported keys are marked `extractable: false` within Web Crypto API memory spaces.

### 4.2 Multi-Layer Defensive RAM Sanitization
- **Instant `.fill(0)` Memory Clearing**: Intermediate byte arrays (`Uint8Array`) containing passwords, salts, CSPRNG initialization vectors (IVs), 128-bit entropy buffers, and decrypted plaintexts are zeroed out via `.fill(0)` inside `finally` blocks immediately upon operation completion.

### 4.3 Zero-Knowledge Envelope & AAD Integrity Binding
- **Algorithm & Envelope (`EncryptedEnvelope`)**:
  - Algorithm: **AES-GCM 256-bit** with CSPRNG 12-byte IV and 16-byte salt.
  - Key Derivation: **PBKDF2-HMAC-SHA256** with **600,000 iterations**.
  - Envelope Schema: `{ version: 1, algorithm: 'AES-GCM-256', keyId, iv, salt, ciphertext, kdfIterations }`.
- **Mandatory AAD Binding**: Additional Authenticated Data (`vault:file:${userId}:${fileId}`) is bound into the AES-GCM 128-bit authentication tag for all document encryptions/decryptions. Any document substitution or payload tampering throws explicit `AADIntegrityError` or `InvalidCiphertextOrKeyError`.

### 4.4 Dual Key Wrapping & BIP-39 Recovery Seed
- **Master Key Dual-Wrapping**: The random 256-bit Vault Master Key is encrypted twice in PostgreSQL:
  1. Password-derived Key Encryption Key (`wrapMasterKeyWithPassword`).
  2. 12-word BIP-39 mnemonic seed Key Encryption Key (`wrapMasterKeyWithRecoverySeed`).
- **Standard BIP-39 Seed (`src/lib/sync/mnemonic.ts`)**: Converts 128-bit CSPRNG entropy to 12 English words with 4-bit SHA-256 checksum verification.

### 4.5 In-Memory Session Key Store & Auto-Lock (`src/lib/sync/session-key-store.ts`)

- **Strict Zero-Trace General Default**: The Master Key is stored strictly in volatile RAM Heap memory (`Uint8Array`) and is never written in plaintext to `sessionStorage` or local disk.
- **Inactivity Auto-Lock**: 1-hour timeout (3,600,000 ms) automatically zeroes and purges keys (`purgeKeys()`) via `wipeBuffer` upon timeout or on logout / session termination.
- **Activity Touch Integration**: Active typing in CodeMirror dispatches `sessionKeyStore.touch()`, extending the inactivity window seamlessly during active composition.
- **Caller Memory Sanitization & Buffer Independence**: UI modals (`CreateVaultModal`, `VaultUnlockModal`, `TrustDeviceModal`) proactively wipe temporary unwrapped/generated key buffers in `finally` blocks via `wipeBuffer()`, while `SessionKeyStore` maintains an isolated copy immune to caller zeroing.

### 4.6 Transparent At-Rest Encrypted IndexedDB (`src/lib/sync/indexeddb.ts`)

- **Always-On Local Encryption**: Transparently encrypts all sensitive client-side records (`IDBFile.content`, `baseSnapshot.content`, `IDBOperation.content`, `previousContent`, and operational snapshots) using AES-GCM-256 via user-scoped `LocalDeviceKey`.
- **Instance-Scoped Key Lifecycle & Volatile RAM Sanitization**: `LocalDeviceKey` is scoped to each `IndexedDBManager` instance to prevent cross-user key contamination in multi-account scenarios. Keys are securely zeroed via `wipeBuffer` on `close()` and `clearAll()`, and purged from RAM via `sessionKeyStore.purgeKeys()` on user logout or session termination in `useSync`.
- **Resilient Lazy Key Persistence**: Keys are retrieved or lazily created through `await this.getDB()` to guarantee that the underlying `sync_metadata` store is open before key persistence, preventing silent key-loss across reloads.
- **Cold-Start Concurrency Guard**: Uses an in-flight singleton promise (`keyInitPromise`) to deduplicate simultaneous cold-start operations on fresh databases, ensuring identical cryptographic key derivation without heavy lock mechanisms.
- **Zero Plaintext At-Rest Invariant**: Confirmed by raw low-level database inspection; no readable document content or operation diffs are ever written to the client disk in plaintext.
- **Cryptographic AAD Binding**: Binds unique domain contexts to each cipher record (`idb:file:${id}`, `idb:snapshot:${id}`, `idb:op:${opId}`) preventing payload tampering or cross-file substitution attacks.
- **Fault Resilience & Isolation (`CorruptedLocalRecordError`)**: Automatically isolates damaged or authentication-mismatched records without crashing bulk queries (`getAllFiles`, `getDirtyFiles`).
- **Seamless Legacy Migration**: In-place fallback that transparently reads legacy unencrypted records and upgrades them to ciphertext on subsequent writes.
- **Offline Profile & Device Trust Storage**: Manages cached cloud vault profiles (`saveCachedVaultProfile`) and PIN-wrapped envelopes (`saveDeviceTrustEnvelope`, `getDeviceTrustEnvelope`, `clearDeviceTrustEnvelope`) in `sync_metadata`.

### 4.7 Cloud Vault Schema & Migrations (`src/lib/db/schema.ts`, `0008_hybrid_vault_schema.sql`, `0009_add_device_trust_epoch.sql`)

- **`user_vault_profiles` Table**: Persists dual-wrapped master keys (`encrypted_master_key` via password KEK, `recovery_encrypted_master_key` via BIP-39 seed KEK), independent salts (`key_salt`, `recovery_salt`), PBKDF2 iteration configurations (600,000), and `device_trust_epoch` (integer default 1).
- **Migration 0009 (`0009_add_device_trust_epoch.sql`)**: Synchronizes the PostgreSQL cloud database with the `device_trust_epoch` counter, ensuring persistent state for remote device trust invalidation across all user devices.
- **`files` Table Encryption Metadata**: Adds `is_encrypted` boolean flag and structured `encryption_metadata` JSONB column (`version`, `algorithm`, `keyId`, `salt`, `iv`, `kdfIterations`) enabling the backend to identify encrypted assets and enforce Zero-Knowledge AI gatekeepers.

### 4.8 Trusted Device Dual Architecture: Hardware Biometrics (WebAuthn PRF) & 6-Digit PIN (`src/lib/sync/webauthn-prf.ts`, `src/lib/sync/encryption.ts`)

- **Dual-Tier Trust Options**: Users enabling "Trust This Device" can select between:
  1. **Hardware Biometrics (WebAuthn PRF — Recommended):** Binds the Master Key to the physical platform authenticator (Windows Hello via TPM 2.0, Apple Touch ID / Face ID via Secure Enclave, Android via Titan M2 / StrongBox) using W3C WebAuthentication Level 3 PRF extension (`extension:prf`). Derives an AES-GCM-256 KEK via HKDF-SHA-256 within the secure enclave, delivering complete physical immunity against offline `IndexedDB` disk extraction.
  2. **6-Digit PIN (Software Fallback):** Derives a KEK via PBKDF2-HMAC-SHA256 (600,000 iterations, 16-byte random salt) strictly validating 6 decimal digits (`/^\d{6}$/`, $10^6$ combinations). Subject to TD-10 offline extraction boundary.
- **In-Place Dual Selector**: Available in both `TrustDeviceModal` and directly within `VaultUnlockModal` (Password tab), permitting users to enroll, reconfigure, or switch between Biometrics and PIN during standard password unlock.
- **Real-Time Capability & Diagnostic Feedback (`checkWebAuthnSupportStatus`)**: Dynamically queries `isUserVerifyingPlatformAuthenticatorAvailable()` and `getClientCapabilities()` (supporting both `"extension:prf"` and `"prf"` keys). If unavailable, provides actionable feedback (e.g., reminding users to configure a Windows Hello PIN in OS settings or access via secure localhost/HTTPS).
- **Device Trust Envelope Schema (`DeviceTrustEnvelope`)**: Persists wrapped key, salt, IV, epoch, and metadata with explicit discriminator `trustType: 'pin' | 'webauthn_prf'` and `credentialId`.
- **Anti-Brute-Force & Expiration Defense**: Enforces a strict 5-attempt failed-unlock lockout limit (`failedAttempts >= 5`) for PIN envelopes and a 30-day expiration window (`expiresAt = trustedAt + 30 days`).
- **Global Central Revocation (`revokeAllTrustedDevices`)**: Incrementing `deviceTrustEpoch` on the server atomically invalidates all local device trust envelopes (both PRF and PIN) across all devices simultaneously due to cryptographic AAD mismatch (`trusted_device:${userId}:${deviceTrustEpoch}`) upon unwrap.

### 4.9 Zero-Knowledge Operation & AI Streaming Guards

- **Client-Side Re-Encrypted Copy Engine (`copyFile` / AUD-02)**: Copying an encrypted file decrypts in volatile RAM, generates a new UUID and fresh random IV, and re-encrypts with the target AAD (`vault:file:${userId}:${newFileId}`). Server-side `copyFile` strictly rejects copying encrypted files without valid client-side re-encryption.
- **Zero-Knowledge AI Streaming Commit Guard (`commitAIFileOperation`)**: When committing AI generation to an encrypted file, the client encrypts the text locally before sending. The server action strictly rejects commits to encrypted files if unencrypted content is supplied without encryption metadata.
- **Conflict 412 Double-Encryption Prevention (AUD-03)**: Detects pre-authenticated ciphertext (`gcm:v1:...`) during server-version conflict resolution to eliminate double-encryption corruption loops.

### 4.10 Zero-Knowledge Log Hygiene & Diagnostic Trace Preservation (`src/lib/sync/log-sanitizer.ts`)

- **Denylist-Based Key Redaction**: Recursively redacts sensitive payload fragments (`content`, `plaintext`, `ciphertext`, `masterkey`, `password`, `pin`, `seed`, `mnemonic`) across error logs and metadata.
- **Word-Boundary Isolation**: Employs exact token boundary isolation for short cryptographic abbreviations (`iv`, `pin`, `aad`, `kek`, `pwd`) to eliminate false-positive redaction of benign operational properties (e.g. `activity`, `archive`, `privacy`).
- **Multi-Word Secret Scrubbing**: Scrubs assignment-style secrets spanning whitespace (e.g. 12-word BIP-39 mnemonics) up to field/newline delimiters, preventing word leakage to console or telemetry.
- **DAG Cycle Detection**: Uses depth-first enter/exit tracking (`seen.delete(obj)`) to detect recursive object cycles without falsely redacting shared diamond-node references across directed acyclic graphs.
- **Sanitized Stack Preservation**: Retains diagnostic call stacks within error payloads while stripping embedded credentials and key material.
- **Subsystem Integration**: Automatically integrated into `SyncErrorHandler` (sanitizing errors before console logging and callback notification) and `SyncPerformanceMonitor` (sanitizing metric metadata upon ingestion so memory stores never hold unencrypted payloads).

---

## 5. Protected Maintenance Cron (`src/app/api/cron/purge-deleted/route.ts`)

Permanent purge of soft-delete tombstones past retention:

| Property | Value |
| :--- | :--- |
| Retention window | 30 days (`RETENTION_DAYS`) after `deleted_at` |
| Authorization | Shared secret: `Authorization: Bearer $CRON_SECRET`; fails closed with 401 when `CRON_SECRET` is unset or mismatched |
| Bounded batches | Deletes at most **500 rows per run** via a `WITH doomed AS (… LIMIT 500) DELETE … USING` CTE (Drizzle's builder has no `.limit()`) |
| Idempotency | Re-running only deletes rows already past the cutoff |
| Scheduling | Invoked externally (GitHub Actions daily workflow `.github/workflows/cron.yml`); failures never break the CI pipeline |

The application itself never hard-deletes user content outside this route — all
user-facing deletions are tombstones
([`records/test-database-safety.md`](../records/test-database-safety.md)).

---

## 6. Verification

```bash
npx vitest run src/test/log-sanitizer.test.ts                                                        # Log hygiene, word-boundary isolation & RAM zeroing
npx vitest run src/test/vault-crypto.test.ts                                                        # Phase 1 crypto worker, AAD, RAM wiping & BIP-39
npx vitest run src/test/vault-storage.test.ts                                                       # Phase 2 database schema, migrations & transparent encrypted IDB
npx vitest run src/test/auth-redirect.test.ts                                                      # open redirect & OAuth security
npx vitest run --config vitest.live.config.ts src/test/cross-user-ownership.test.ts               # cross-user isolation & atomic sync (live DB)
npx vitest run --config vitest.live.config.ts src/app/api/files/[id]/route.putguard.test.ts       # auth + rate-limit + version guards (live DB)
npx vitest run --config vitest.live.config.ts src/server/actions/file-ops.ownership.test.ts       # ownership isolation (live DB)
npx tsc --noEmit                                                                                   # type safety gate
```
