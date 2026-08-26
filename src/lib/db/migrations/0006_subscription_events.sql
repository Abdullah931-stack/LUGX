-- Migration: 0006_subscription_events
-- DATA INTEGRITY & IDEMPOTENCY: subscription_events table for durable tracking of Stripe webhook events.
-- Prevents duplicate mutations across server restarts and multi-instance deployments.

-- ---------------------------------------------------------------------------
-- 1. Create subscription_events table if not exists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscription_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id varchar(255) NOT NULL,
    event_type varchar(128) NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    stripe_subscription_id varchar(255),
    status varchar(64) NOT NULL DEFAULT 'processed',
    created_at timestamp NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. Create unique index on event_id and lookup indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_event_id
    ON subscription_events USING btree (event_id);

CREATE INDEX IF NOT EXISTS idx_subscription_events_user_id
    ON subscription_events USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_subscription_events_created_at
    ON subscription_events USING btree (created_at);
