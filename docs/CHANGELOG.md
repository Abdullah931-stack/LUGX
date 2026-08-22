# Changelog - LUGX Project

All notable changes to the LUGX project will be documented in this file.

## [1.5.0] - 2026-08-23 (Runtime Remediation: AI Streaming & Local-First Editor Sync)

### Fixed - AI Streaming Deadlock & Invisible Ghost Preview

Root-cause remediation for four compounding runtime defects; full analysis in
`docs/AI_KEY_ROTATION_AND_STREAMING_RESILIENCE.md` (§5a) and
`docs/UI_STREAMING_ARCHITECTURE_IMPLEMENTATION.md` (§6.3):

- **Detached async completion (`stream-handler.ts`)** — rejections inside the async commit
  pipeline are now routed into `onError`, guaranteeing exactly one terminal callback per
  session (previously an unhandled promise rejection stranded the session, leaked the quota
  reservation, and permanently locked the in-flight trigger mutex).
- **Provider abort propagation (`client.ts`)** — the downstream `AbortSignal` is forwarded
  into Gemini SDK request options so user cancellation and client disconnects terminate the
  upstream socket instead of pinning `reader.read()` until generation finishes server-side.
- **Runtime watchdogs (`stream-handler.ts`)** — first-chunk (20s) and absolute-duration
  (120s) ceilings fail closed with structured errors instead of hanging the editor session.
- **Preview buffer integrity (`use-ai-stream.ts`)** — only the latest delta is appended to
  the ephemeral buffer (the previous accumulated append grew it quadratically).
- **Feature-flag enforcement (G10)** — `/api/ai/stream` now branches on
  `AI_STREAMING_ENABLED` with `processWithAI` as the buffered NDJSON fallback.

### Fixed - UI-Blocking Synchronization (Text Vanishing Mid-Typing)

Full policy specification in `docs/editor-sync-orchestration.md` (§6a):

- **Stable orchestrator lifecycle** — the navigation callback identity no longer re-triggers
  the initial-load effect on every render; the IDB-paint + background-fetch + reconciliation
  pipeline runs exactly once per mounted `fileId`.
- **Deterministic reconciliation policy** (`src/lib/sync/reconciliation.ts`) replacing the
  blind content overwrite:
  - `apply` — fast-forward when local is clean and the remote revision is verified-newer
    (version advanced + ETag changed + corroborating timestamps), i.e. built on our state;
  - `adopt_metadata` — identical payload adopts authoritative version/ETag silently;
  - `keep_local` — dirty divergence or non-newer remote retains local truth without
    advancing anchors, surfacing a genuine `412` through explicit three-way conflict flow.
- **Programmatic transaction guard wiring** — AI atomic commits and rollbacks are wrapped by
  `onProgrammaticTransaction` so post-commit autosave races are eliminated.

### Tests

- New: `reconciliation.test.ts` (8 decision-matrix tests),
  `ai-stream-completion-terminality.test.ts` (3 terminality/watchdog tests),
  `ai-client-abort-propagation.test.ts` (SDK request-options assertion).
- Regression verified clean: parser, session FSM, ai-transaction, editor atomic commit,
  use-sync (45/45); `tsc --noEmit` 0 errors.

---

## [1.4.0] - 2026-08-21 (Phase 9: TipTap Editor, Auto-save & Sync Orchestration)

### Added - Centralized Editor Orchestration & Authoritative Write Controller

#### Core Architecture & Controller
- **Centralized Editor Orchestrator Hook** (`src/hooks/use-editor-orchestrator.ts`)
  - Decomposes editor state into 6 isolated state slices: Document, Preview, Dirty, Server Version, Conflict, and Write State.
  - Acts as the single authoritative write gateway for manual saves, AI commits, conflict resolutions, and sync replays.
  - Strict AutoSave suspension invariants: auto-save is paused during active streaming (`streaming`, `reserved`), committing (`committing`), active conflicts (`conflict`), sync stoppage (`stopped`), and programmatic updates (`setContent`).
  - Target-scoped manual edit policy: user modifications inside the active AI streaming selection abort generation, refund quota, and clear ghost decorations immediately; edits to other paragraphs outside the target range proceed without interrupting the AI stream (coordinates mapped automatically via ProseMirror `tr.mapping`).

- **Unified Editor Workspace Page** (`src/app/workspace/editor/[fileId]/page.tsx`)
  - Refactored page component to delegate all state and write management to `useEditorOrchestrator`.
  - Integrated `AIStreamPreview`, `AIStreamStatus`, `ConflictDialog`, and `SyncIndicator` directly with the centralized orchestrator.
  - Sibling tab version synchronization for clean tabs with optimistic version precondition locking for dirty tabs.
  - Page unload & navigation guards (`beforeunload`) protecting dirty or in-flight committing states.

- **Cleanup of Redundant Editor Instances**
  - Removed unused duplicate canvas component (`src/components/editor/editor-canvas.tsx`) ensuring zero competing editor paths.

- **Technical Architecture Documentation** (`docs/editor-sync-orchestration.md`)
  - Full architectural specifications, state slicing, AutoSave suspension invariants, and target-scoped manual edit policy.

#### Automated Integration Test Suite (48 Tests Passing, 100% Rate)
- `src/test/editor-orchestration.integration.test.ts` (7 Integration tests)
- `src/test/editor-atomic-commit.test.ts` (4 Editor Atomic Commit tests)
- `src/hooks/use-sync.test.ts` (13 Sync Hook tests)
- `src/test/conflict-resolution.integration.test.ts` (3 Conflict Resolution tests)
- `src/test/ai-stream-session.test.ts` (12 Session tests)
- `src/test/ai-server-atomic-commit.test.ts` (10 Server Commit tests)

---

## [1.3.0] - 2026-08-21 (Phase 8: AI Atomic Commit & Transactional Settlement)

### Added - AI Atomic Commit Architecture & Real PostgreSQL Verification

#### Core Transactional Architecture
- **Transactional Database Client** (`src/lib/db/transactional.ts`)
  - WebSocket-enabled Neon Serverless Pool for interactive SQL transactions (`BEGIN` / `COMMIT` / `ROLLBACK`).
  - Hardened connection limits and timeout boundaries (`max: 5`, `connectionTimeoutMillis: 10_000`, `idleTimeoutMillis: 30_000`) preventing orphaned reservations.

- **Atomic Commit Server Action** (`src/server/actions/ai-commit.ts`)
  - Atomic transaction executing file content update (`files` table), version increment, ETag calculation, and quota reservation settlement (`aiReservations` table -> `committed`) inside a single database transaction.
  - Server-side optimistic locking with explicit `412 Conflict` on concurrent modifications (`WHERE version = expectedVersion`).
  - Production transactional invariant: hard-fails if transaction client is unavailable in production.
  - Idempotent retries via `operationId` returning current persisted document state.
  - Lean conflict payload omitting large unneeded document bodies.

- **Editor Server-First Commit Invariant** (`src/hooks/use-ai-stream.ts`)
  - Server-first transaction: TipTap editor modifications applied as a single history step only after server transaction confirmation.
  - Ephemeral ghost preview cleanly removed on conflict or error, preserving pristine document state.

- **Technical Architecture Documentation** (`docs/ai-atomic-commit-architecture.md`)
  - Comprehensive specification of invariants, sequence diagram, test suites, and technical debt.

#### Automated Test Suite (44 Tests Passing, 100% Rate)
- `src/test/ai-atomic-commit.integration.test.ts` (6 Real PostgreSQL integration tests)
- `src/test/ai-server-atomic-commit.test.ts` (10 Unit / Contract tests)
- `src/lib/ai-transaction.test.ts` (5 Editor Unit tests)
- `src/test/editor-atomic-commit.test.ts` (4 Editor Invariant tests)
- `src/test/ai-quota-idempotency.test.ts` (8 Quota tests)
- `src/server/actions/ai-ops.refund.test.ts` (5 Real Quota Refund tests)
- `src/server/actions/ai-ops.integrity.test.ts` (6 Real Concurrency Integrity tests)

---

## [1.2.0] - 2026-08-21 (Phase 7: NDJSON Streaming & Session State Machine)

### Added - AI NDJSON Streaming & Finite State Machine

#### Core Streaming Architecture
- **Resilient NDJSON Stream Parser** (`src/lib/ai/stream-handler.ts`)
  - Canonical event framing: `start`, `chunk`, `metadata`, `done`, `error`, `cancelled`.
  - Multi-byte UTF-8 boundary preservation via `TextDecoder({ stream: true })`.
  - Incomplete EOF stream detection as `failed_incomplete_stream`.
  - Duplicate `done` protection and unknown frame resilience.
  - `MAX_LINE_BUFFER_CHARS` (256KB) line buffer flooding ceiling (ADV-01).
  - Single terminal callback emission guarantee (ADV-05).

- **Deterministic Session State Machine** (`src/lib/ai/stream-session.ts`)
  - Canonical state flow: `idle -> reserving -> streaming -> preview_ready -> committing -> committed`.
  - Terminal failure & cancellation states: `aborted`, `failed`, `conflict`, `rolled_back`.
  - Editor generation and version mismatch integrity guards (`assertSessionIntegrity`).
  - Double-decision prevention on late cancellations.

- **Route Handler Hardening & Quota Protection** (`src/app/api/ai/stream/route.ts`)
  - Emits structured NDJSON event frames with zero prompt/sensitive text leakage in headers.
  - Automatic quota reservation before stream dispatch and idempotent refund on client abort or mid-stream exceptions.
  - Strict payload validation and `MAX_INPUT_CHARS = 100,000` ceiling (ADV2-01).

- **Ephemeral Preview & Atomic Commit Hook** (`src/hooks/use-ai-stream.ts`)
  - Zero TipTap document mutation during streaming (appends strictly to `EphemeralPreviewBuffer` and ghost decoration layer).
  - Dynamic ProseMirror mapped selection coordinate resolution (`streamingGhostPluginKey`) preventing selection drift (ADV-04).
  - Non-abortable committing state guard preventing client/server version desynchronization (ADV2-02).

- **DOM XSS Sanitization in TipTap Ghost Widget** (`src/lib/extensions/streaming-ghost-extension.ts`)
  - DOM node construction via `document.createElement` and `textContent` (ADV-06).

- **AI Stream Status Indicator** (`src/components/editor/ai-stream-status.tsx`)
  - Accurate cancellation UI state reflecting non-abortable server transactions (ADV2-03).

- **Technical Documentation** (`docs/architecture/ai-streaming-protocol.md`)
  - Comprehensive specification of NDJSON framing, state transitions, adversarial edge cases, and quota lifecycle.

#### Automated Test Suite
- `src/test/ai-stream-parser.test.ts` (11 unit tests passed)
- `src/test/ai-stream-session.test.ts` (12 unit tests passed)

---

## [1.0.0] - 2026-01-27

### Added - Stripe Integration

#### Core Infrastructure
- **Stripe Library Wrapper** (`src/lib/stripe/index.ts`)
  - Customer management functions
  - Checkout session creation
  - Webhook signature verification
  - Subscription cancellation

- **Stripe Configuration** (`src/lib/stripe/config.ts`)
  - Price ID mappings for Pro and Ultra tiers
  - Tier validation utilities

#### API Routes
- **Create Checkout Endpoint** (`src/app/api/stripe/create-checkout/route.ts`)
  - User authentication and validation
  - Tier upgrade validation
  - Stripe customer creation/retrieval
  - Secure checkout session creation

- **Webhook Handler** (`src/app/api/stripe/webhook/route.ts`)
  - Signature verification for security
  - Event processing:
    - `checkout.session.completed` - Updates user tier on successful payment
    - `customer.subscription.updated` - Syncs subscription status
    - `customer.subscription.deleted` - Handles cancellations
  - Comprehensive error logging

#### Server Actions
- **Subscription Actions** (`src/server/actions/subscription-actions.ts`)
  - `updateUserTier()` - Updates user subscription tier
  - `updateUserStripeCustomerId()` - Links Stripe customer to user
  - `upsertSubscription()` - Creates/updates subscription records
  - `cancelUserSubscription()` - Handles subscription cancellation

#### UI Components
- **UpgradeButton Component** (`src/components/subscription/upgrade-button.tsx`)
  - Interactive upgrade button with loading states
  - Error handling with toast notifications
  - Smart disabled states based on tier hierarchy
  - Auto-redirect to Stripe Checkout

#### Documentation
- `STRIPE_SETUP.md` - Complete setup guide
- `FINAL_DOCUMENTATION.md` - Comprehensive technical documentation
- `CHANGELOG.md` - This file

### Changed

- **Account Page** (`src/app/account/page.tsx`)
  - Replaced static upgrade button with interactive `UpgradeButton` component
  - Added dual button display for Pro and Ultra tiers
  - Conditional rendering based on current tier:
    - Free: Shows both Pro and Ultra buttons
    - Pro: Shows Ultra button only
    - Ultra: Shows no buttons (highest tier)

- **Environment Configuration** (`.env`)
  - Added `STRIPE_PRO_PRICE_ID`
  - Added `STRIPE_ULTRA_PRICE_ID`

### Fixed

#### Fix #1: Non-functional Upgrade Button
- **Issue**: Upgrade buttons had no event handlers
- **Solution**: Created complete Stripe integration with API routes and webhook handling
- **Status**: ✅ Resolved

#### Fix #2: Webhook Configuration
- **Issue**: Webhooks not reaching correct endpoint
- **Root Cause**: Stripe CLI forwarding to wrong path (`/api/webhooks/stripe` instead of `/api/stripe/webhook`)
- **Solution**: Corrected Stripe CLI command and added detailed logging
- **Status**: ✅ Resolved

#### Fix #3: Tier Upgrade Flow
- **Issue**: Pro users unable to upgrade to Ultra
- **Root Causes**:
  - Restrictive disabled logic in UpgradeButton
  - Missing Ultra button in UI
  - API validation preventing Pro→Ultra upgrades
- **Solutions**:
  - Implemented tier hierarchy system (Free=0, Pro=1, Ultra=2)
  - Added both Pro and Ultra buttons with smart conditional rendering
  - Updated button text to show target tier
  - Fixed API validation logic
- **Status**: ✅ Resolved

### Security

- ✅ PCI-DSS Compliant (no card data storage)
- ✅ Webhook signature verification
- ✅ Server-side validation for all operations
- ✅ HTTPS required for production webhooks
- ✅ No hardcoded secrets (environment variables only)

### Supported Upgrade Paths

#### Allowed ✅
- Free → Pro ($0 → $12/month)
- Free → Ultra ($0 → $120/month)
- Pro → Ultra ($12 → $120/month)

#### Blocked ❌
- Same tier upgrades (Pro → Pro, Ultra → Ultra)
- Downgrades (Ultra → Pro, Ultra → Free, Pro → Free)

---

## Testing

### Test Mode Setup Required
1. Create Products in Stripe Dashboard (Test Mode)
2. Update Price IDs in `.env`
3. Run Stripe CLI: `stripe listen --forward-to http://localhost:3000/api/stripe/webhook`

### Test Card
- Number: 4242 4242 4242 4242
- Expiry: Any future date
- CVC: Any 3 digits
- ZIP: Any 5 digits

---

## Production Deployment Checklist

- [ ] Create Products in Stripe Live Mode
- [ ] Obtain Live API Keys (Secret + Publishable)
- [ ] Update production environment variables
- [ ] Configure production webhook endpoint
- [ ] Test in staging environment
- [ ] Deploy to production
- [ ] Monitor webhook events in Stripe Dashboard

---

**Version:** 1.0.0  
**Status:** Production Ready (after production keys setup)  
**Last Updated:** 2026-01-27
