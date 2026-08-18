-- Migration: 0005_ai_reservations
-- DATA INTEGRITY & IDEMPOTENCY: ai_reservations table for tracking AI quota reservations,
-- preventing double-refunds, supporting TTL expiration sweeps, and enforcing atomic commits.

-- ---------------------------------------------------------------------------
-- 1. Create ai_reservation_status enum if not exists
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_reservation_status') THEN
        CREATE TYPE ai_reservation_status AS ENUM ('reserved', 'committed', 'refunded', 'expired');
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Create ai_reservations table if not exists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_reservations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id varchar(255) NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id uuid REFERENCES files(id) ON DELETE SET NULL,
    operation varchar(64) NOT NULL,
    reserved_amount integer NOT NULL DEFAULT 0,
    period_key varchar(32) NOT NULL,
    status ai_reservation_status NOT NULL DEFAULT 'reserved',
    expires_at timestamp NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. Create unique index on operation_id and lookup/sweep indexes
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reservations_operation_id
    ON ai_reservations USING btree (operation_id);

CREATE INDEX IF NOT EXISTS idx_ai_reservations_user_status
    ON ai_reservations USING btree (user_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_reservations_status_expires
    ON ai_reservations USING btree (status, expires_at);
