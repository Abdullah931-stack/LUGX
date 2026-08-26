# Phase 13: Stripe Webhook & Subscriptions Architecture & Verification

## 1. Executive Summary & Objective

This document records the final architectural hardening, adversarial verification, and closure evidence for **Phase 13: Stripe Webhook and Subscriptions Lifecycle** of the technical roadmap (`docs/.Plans/خطة التنفيذ التقنية.md`, lines 402–442).

The objective was to transform Stripe webhook ingestion and subscription lifecycle processing into a **durable, idempotent, fail-closed, atomic, and period-accurate** system ready for mission-critical production workloads.

---

## 2. Key Architectural Invariants & Upgrades

```
                       +-----------------------------------+
                       |    Incoming Stripe Webhook POST   |
                       +-----------------+-----------------+
                                         |
                                         v
                       +-----------------------------------+
                       | Signature & Timestamp Tolerance   |
                       | (Fail-Closed: 300s window)        |
                       +-----------------+-----------------+
                                         |
                                         v
                       +-----------------------------------+
                       | Idempotency Gate:                 |
                       | 1. Fast-path in-memory Set        |
                       | 2. Durable `subscription_events`  |
                       +-----------------+-----------------+
                                         |
                        +----------------+----------------+
                        | (If new event)                  | (If already recorded)
                        v                                 v
        +-------------------------------+   +-----------------------------+
        | Atomic ACID Transaction (`tx`)|   | Return 200                  |
        | - Terminal State Guard Check  |   | { received: true,           |
        | - Period Extraction (end>start)|   |   duplicate: true }         |
        | - Local DB Subscription Sync  |   +-----------------------------+
        | - User Tier & Sub Upsert      |
        | - Record `subscription_events`|
        +---------------+---------------+
                        |
                        v
        +-------------------------------+
        | Update In-Memory Fast-Path    |
        | (Zero-Allocation Set Eviction)|
        +---------------+---------------+
                        |
                        v
        +-------------------------------+
        | Return 200 { received: true } |
        +-------------------------------+
```

### 2.1 Durable Idempotency Ledger (`subscription_events`)
- **Migration `0006_subscription_events.sql`**: Created the `subscription_events` table in PostgreSQL with unique index `idx_subscription_events_event_id`.
- **Restart Resilience**: Prior to Phase 13, event deduplication was stored solely in an in-memory `Set<string>`. Any server restart or cold boot in serverless functions lost deduplication state. Now, the database ledger provides the authoritative backstop.
- **Zero-Allocation Set Eviction**: In-memory cache is bounded to 10,000 entries and evicted via direct Set iteration without intermediate array allocations.

### 2.2 Atomic ACID Transitions (`executeSubscriptionTransition`)
- In `route.ts`, each event handler wraps user tier updates, subscription upserts, and durable event recording within a single atomic database transaction (`executeSubscriptionTransition(async (tx) => { ... })`).
- Guarantees complete All-or-Nothing atomicity across database connection drops.

### 2.3 Terminal State Protection (Preventing Zombie Revivals)
- When a subscription is marked `canceled` in the database, delayed out-of-order `customer.subscription.updated` events with `status: 'active'` are safely ignored and recorded as `ignored_stale`.
- Reactivation can only occur through an explicit, fresh `checkout.session.completed` payment.

### 2.4 Billing Period Normalization (Fixing the 3-Location Bug)
- **Problem**: In previous versions, `start_date` was duplicated into both `currentPeriodStart` and `currentPeriodEnd`, setting them to identical timestamps (`start === end`).
- **Solution (`extractPeriod`)**:
  - Periods are extracted from `SubscriptionItem` (`item.current_period_start/end`) or associated `Invoice` line items (`invoice.lines.data[0].period.start/end`).
  - Strict invariant: `currentPeriodEnd` is guaranteed to strictly exceed `currentPeriodStart` (`end > start`).

### 2.5 Local DB Subscription Reconciliation for Invoices
- `handleInvoicePaymentFailed` queries local database state by `userId` directly rather than making external network calls to Stripe, eliminating network latency and rate limit risks.

---

## 3. Database Schema Updates

```sql
-- Migration: 0006_subscription_events.sql
CREATE TABLE IF NOT EXISTS subscription_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id varchar(255) NOT NULL,
    event_type varchar(128) NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    stripe_subscription_id varchar(255),
    status varchar(64) NOT NULL DEFAULT 'processed',
    created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_event_id
    ON subscription_events USING btree (event_id);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user_id
    ON subscription_events USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_subscription_events_created_at
    ON subscription_events USING btree (created_at);
```

---

## 4. Verification Evidence

### 4.1 Unit / Contract Test Suite (`npx vitest run src/app/api/stripe/webhook/route.test.ts`)
```
✓ src/app/api/stripe/webhook/route.test.ts (9 tests)
  ✓ unmapped subscription status is fail-closed: throws, updates nothing
  ✓ checkout.session.completed with unpaid payment grants no tier (fail-closed)
  ✓ invoice.payment_failed downgrades to free and reconciles from local DB
  ✓ in-memory fast-path deduplicates rapid sequential delivery
  ✓ durable DB ledger deduplicates event after server restart (__resetProcessedEventIds)
  ✓ terminal state protection: ignores stale customer.subscription.updated on canceled subscription
  ✓ calculates distinct period boundaries for checkout.session.completed (end > start)
  ✓ calculates distinct period boundaries for customer.subscription.updated (end > start)
  ✓ unknown event type logs fail-closed, persists event, and returns success
```

### 4.2 Isolated Neon Branch Live Integration Suite (`npx vitest run --config vitest.live.config.ts src/app/api/stripe/webhook/route.live.test.ts`)
```
✓ src/app/api/stripe/webhook/route.live.test.ts (6 tests)
  ✓ rejects an invalid signature with 400 BEFORE any parsing or mutation
  ✓ checkout.session.completed (paid) upgrades tier, persists subscription with valid period, and writes durable event
  ✓ durable restart idempotency: re-sending event after in-memory cache clear yields duplicate: true with ZERO DB mutation
  ✓ unmapped subscription status is fail-closed: no DB mutation
  ✓ customer.subscription.deleted downgrades tier to free and updates subscription status
  ✓ terminal state protection: stale customer.subscription.updated active event does not resurrect a canceled subscription on live DB
```

---

## 5. Closure Status

- **Phase ID**: Phase 13 (المرحلة 13: Stripe webhook والاشتراكات)
- **Status**: `CLOSED`
- **Next Transition Gate**: Phase 14 (Supabase Storage) is fully unblocked.
