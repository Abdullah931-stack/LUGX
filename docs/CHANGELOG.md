# Changelog - LUGX Project

All notable changes to the LUGX project will be documented in this file.

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
