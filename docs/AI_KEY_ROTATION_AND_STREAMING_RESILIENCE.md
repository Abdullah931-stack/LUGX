# AI Key Rotation, Model Fallback & Resilient Streaming Architecture in LUGX

## 1. Executive Summary

This document describes the architectural design, failover mechanics, 24-hour fixed quota lifecycle, Redis-backed key state management (`healthy`, `exhausted`, `cooldown`, `disabled`), 3-state Distributed Circuit Breaker (`CLOSED`, `OPEN`, `HALF-OPEN`) with 5-minute atomic probing, and real-time streaming resilience for Google Gemini AI in LUGX.

---

## 2. Distributed Circuit Breaker & Multi-Tier Model Failover

### 2.1 Model Declaration Hierarchy (`src/config/models.config.json`)
All AI models (primary and fallback) are strictly declared within `src/config/models.config.json` per operation and subscription tier:

```json
{
  "correct": {
    "free": "gemini-3.7-flash",
    "pro": "gemini-3.7-flash",
    "ultra": "gemini-3.7-flash",
    "fallback": {
      "free": "gemini-3.6-flash",
      "pro": "gemini-3.6-flash",
      "ultra": "gemini-3.6-flash"
    },
    "temperature": 0.3,
    "topP": 0.8
  },
  "improve": { ... },
  "summarize": { ... },
  "toPrompt": { ... },
  "translate": { ... }
}
```

---

## 3. Dual-Layer Failover & Key State Mechanics

```mermaid
sequenceDiagram
    autonumber
    actor User as LUGX Editor
    participant Route as /api/ai/stream (Route Handler)
    participant Client as streamWithAI (AI Client)
    participant Redis as Upstash Redis
    participant Gemini as Google Gemini API

    User->>Route: POST /api/ai/stream
    Route->>Client: streamWithAI(operation, text, tier)
    Client->>Redis: getModelCircuitState("gemini-3.7-flash")
    
    alt Circuit Breaker is OPEN (Model Overloaded / 10m TTL)
        Redis-->>Client: Open
        Note over Client: Fast-Path: Immediately route to fallback "gemini-3.6-flash"
    else Circuit Breaker is HALF-OPEN (Probe Lock 5m)
        Client->>Redis: tryAcquireHalfOpenProbe (SET NX EX 300)
        alt Won Probe Lock
            Note over Client: Single Probe: Test primary model
        else Lost Probe Lock
            Note over Client: Probe in Flight: Route concurrent request to fallback
        end
    else Circuit Breaker is CLOSED (Normal)
        Redis-->>Client: Closed
        Client->>Gemini: generateContentStream("gemini-3.7-flash")
        alt HTTP 503 / Model High Demand
            Gemini--xClient: 503 Service Unavailable
            Client->>Redis: recordModelFailure / tripModelCircuit (10m TTL)
            Note over Client: In-Flight Failover: Immediately retry with fallback model
            Client->>Gemini: generateContentStream("gemini-3.6-flash")
        else HTTP 429 / Quota Limit Exceeded
            Gemini--xClient: 429 Too Many Requests
            Client->>Redis: markKeyCooldown(300s) & forceKeyRotationAndGetKey()
            Note over Client: Key Rotation: Retries with next healthy key
        else HTTP 401 / Invalid Key
            Gemini--xClient: 401 Unauthorized
            Client->>Redis: markKeyDisabled() & forceKeyRotationAndGetKey()
            Note over Client: Key Disabled: Permanently skipped from rotation
        else HTTP 400 / Bad Request or Safety Block
            Gemini--xClient: 400 Bad Request
            Note over Client: Fail-Fast: Immediately throws error (NO key rotation)
        end
    end

    Gemini-->>Client: Successful Stream
    Client->>Redis: confirmApiKeyUsage(keyIndex)
    Note over Redis: Increments counter; establishes 24h TTL on 1st request
    Client->>Redis: recordModelSuccess("gemini-3.7-flash")
    Route->>User: Structured NDJSON Stream (meta, delta, done)
```

---

## 4. Key Components & Responsibilities

### 4.1 Key Rotation Engine (`src/lib/ai/key-rotation.ts`)
* **Key State Lifecycle**:
  - `healthy`: Under limit (<20 requests/day), ready for requests.
  - `exhausted`: Reached daily limit (20/20). 24h TTL starts on request #1 and is never extended.
  - `cooldown`: HTTP 429 rate limit. Temporary 5-minute cooldown (`gemini:key_cooldown:{index}`).
  - `disabled`: HTTP 401 invalid key. Explicitly disabled in Redis (`gemini:key_disabled:{index}`).
* **High-Performance Selection**:
  - **Fast-Path**: Checks active key index first (<10ms).
  - **Parallel Batching**: Concurrently inspects all key states via `Promise.all` during rotation (<35ms).
* **Fail-Closed Policy**: Throws `RedisUnavailableError` when Redis is unreachable, preventing unmanaged quota bypasses.
* **Sensitive Data Redaction**:
  - `maskApiKey(key)` masks keys as `AIza...cdef`.
  - `sanitizeErrorMessage(msg)` scrubs Google API keys and URL query parameters (`?key=...`) from error messages.

### 4.2 Distributed 3-State Circuit Breaker (`src/lib/ai/key-rotation.ts`, `src/lib/ai/client.ts`)
* **States**:
  - `CLOSED`: Normal operation, calls primary model.
  - `OPEN`: 2 consecutive 503 failures within 5m trip circuit for 10 minutes (600s). Fast-paths to fallback model (`gemini-3.6-flash`).
  - `HALF-OPEN`: Cooldown expired. Allows a single probe request via atomic `SET key probing NX EX 300` (5-minute lock). Concurrent requests safely bypass to fallback.
* **Probe Cleanup**: `releaseProbeLock` cleans up locks immediately on non-overload errors or cancellation.

### 4.3 In-Flight Deduplication & Double-Click Protection
* **Client Mutex (`useAIStream`):** Rejects concurrent duplicate clicks if a stream is active in `reserved`, `streaming`, or `committing` state.
* **Server Race Recovery (`reserveAndUpdateUsage`):** Catches PostgreSQL unique constraint collisions, reverses speculative usage increments, and returns winner's reservation.

### 4.4 AI Client (`src/lib/ai/client.ts`)
* **Synchronous Generation (`processWithAI`)** and **Stream Generation (`streamWithAI`)**.
* **Fail-Fast on 400**: Immediately throws on client errors / safety blocks without wasting quota.
* **Native AbortSignal & Teardown**: Handles client aborts cleanly, stopping generator loops via `ReadableStream.cancel()`. As of v1.5.0 the signal is additionally forwarded into the Gemini SDK request options (`generateContent(request, { signal })` / `generateContentStream(request, { signal })`), so cancellation terminates the upstream provider HTTP socket instead of leaving the server pinned in `reader.read()` until generation finishes on its own (see Section 7, DEF-2).
* **Dynamic Max Retries**: Bounded by key pool size `Math.min(Math.max(6, keys.length), 10)`.

---

## 5. Error Classification Matrix

| Category | Trigger Conditions | Retry with Key? | Retry with Model? | Action |
|---|---|---|---|---|
| `quota` | HTTP 429, ResourceExhausted | Yes | No | Place current key in `cooldown` (300s), rotate to next healthy key |
| `authentication` | HTTP 401, API_KEY_INVALID | Yes | No | Mark current key `disabled`, rotate to next healthy key |
| `overload` | HTTP 503, High demand, Overloaded | No | Yes | In-flight failover to fallback model, trip circuit breaker |
| `transient` | HTTP 500, 502, 504, ECONNRESET, Timeout | Yes | No | Retry with next healthy key |
| `invalid_request` | HTTP 400, Bad Request, Safety Filter | **No** | **No** | **Fail-Fast**: Throw immediately without rotating keys |
| `cancelled` | AbortSignal triggered, AbortError | **No** | **No** | Clean cancellation, throw `AbortError` |

---

## 5a. Streaming Runtime Remediation (v1.5.0)

Four compounding runtime defects — invisible ghost preview and a perceived infinite
send/receive deadlock — were root-caused and closed. None were visible to Phase 7 unit
suites because each sits on an async boundary that mocked tests do not exercise.

### Root Causes

| ID | Defect | Impact |
|----|--------|--------|
| **DEF-1** | `consumeAIStream` invoked the async completion callback synchronously. Any rejection inside it (empty response, integrity failure, server-commit failure) became an **unhandled promise rejection**: ghost never dismantled, quota never refunded, session stuck non-terminal → the in-flight mutex silently dropped every subsequent trigger. | Permanent deadlock after first failure |
| **DEF-2** | The downstream `AbortSignal` was not forwarded into Gemini SDK request options; cancellation killed only the client read loop while the upstream socket kept running. `route.ts`'s `reader.read()` blocked until generation finished server-side; zero chunks reached the browser meanwhile. | Indefinite hang + empty ghost header |
| **DEF-3** | No bound on time-to-first-token or total stream duration; any provider stall before the first byte left the UI in `streaming` forever. | Unbounded hang (compounded DEF-2) |
| **DEF-4** | `onChunk` appended the *accumulated* text into `EphemeralPreviewBuffer` on every delta — O(n²) growth and corrupted `getText()`. | Buffer corruption / premature truncation |

### Remediations

| ID | Fix | File |
|----|-----|------|
| DEF-1 | `emitComplete` chains `Promise.resolve().then(onComplete).catch(...)`; a completion rejection resets the terminal latch and routes through `emitError`, guaranteeing **exactly one terminal callback** (error teardown: ghost cleared, refund issued, mutex released). | `src/lib/ai/stream-handler.ts` |
| DEF-2 | Signal forwarded as SDK request options (`@google/generative-ai ^0.24`). Cancellation tears down the upstream socket. | `src/lib/ai/client.ts` |
| DEF-3 | Watchdogs armed post-reader: first-chunk (`FIRST_CHUNK_TIMEOUT_MS = 20s`) and absolute duration (`MAX_STREAM_DURATION_MS = 120s`); timeout fires `reader.cancel()` plus structured errors (`AI_STREAM_FIRST_CHUNK_TIMEOUT` / `AI_STREAM_DURATION_EXCEEDED`). Both overridable per call for ops/tests. | `src/lib/ai/stream-handler.ts` |
| DEF-4 | `previewBuffer.append(sessionId, latestChunk)` — only the newest delta is appended; the accumulated view remains available via the callback's first argument. | `src/hooks/use-ai-stream.ts` |

Related hardening in the same release: AI atomic-commit / rollback document mutations are
routed through `UseAIStreamOptions.onProgrammaticTransaction` so the orchestrator's
programmatic-update guard suppresses the spurious post-commit autosave race
(`docs/editor-sync-orchestration.md` §6b), and `/api/ai/stream` now actually enforces
`FEATURES.AI_STREAMING_ENABLED` with `processWithAI` as a buffered NDJSON fallback.

### Terminality Contract (Post-Fix)

For any session, exactly one of the following terminal outcomes is emitted:

```
stream end + valid payload   -> onComplete -> [async commit] -> committed | conflict | failed
provider stall / slow start  -> onError(AI_STREAM_FIRST_CHUNK_TIMEOUT)
runaway stream               -> onError(AI_STREAM_DURATION_EXCEEDED)
user abort / disconnect      -> onError(AbortError) + server-side refund
mid-stream provider error    -> onError(classified error) + server-side refund
commit pipeline rejection    -> onError(original rejection) + client-side refund
```

### Verification

| Suite | Coverage |
|-------|----------|
| `src/test/ai-stream-completion-terminality.test.ts` (3 tests) | Async commit-pipeline rejection routes into `onError` with a single terminal callback; clean async completion emits no error; stalled provider fails closed via the first-chunk watchdog |
| `src/test/ai-client-abort-propagation.test.ts` | The AbortSignal reaches `generateContentStream` request options verbatim |

```bash
npx vitest run src/test/ai-stream-completion-terminality.test.ts src/test/ai-client-abort-propagation.test.ts
node_modules/.bin/tsc --noEmit
```

---

## 6. Verification & Test Evidence

All components have been rigorously verified through automated test suites:
- `src/lib/ai/key-rotation.test.ts` (37 tests): 24h fixed window, 4 key states, atomic 5-minute probe lock, Fail-Closed policy, sanitization.
- `src/lib/ai/client.test.ts` (20 tests): Model configuration, fast-path circuit breaker, in-flight 503 failover, streaming, cancellation.
- `src/test/ai-provider-smoke.test.ts` (4 tests): Model contracts, error classifications.
- `src/server/actions/ai-ops.integrity.test.ts` (6 tests on real PostgreSQL): Concurrency races, single charge on duplicates, cross-midnight safety, blind refund rejection.
- `src/server/actions/ai-ops.refund.test.ts` (5 tests on real PostgreSQL): Bounded subtraction, underflow safety, quota restoration.
- **Total Passing Tests**: **72 / 72 tests (100% passing)**.
- **Type Safety**: **0 errors** via `npx tsc --noEmit`.
