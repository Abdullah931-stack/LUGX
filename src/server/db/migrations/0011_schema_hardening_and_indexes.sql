-- Migration: 0011_schema_hardening_and_indexes
-- Hardened for Phase 7 (LUGX-025, LUGX-027, LUGX-030, LUGX-031, LUGX-068, LUGX-069, LUGX-141, LUGX-143)
-- 1. Shifting subscriptions uniqueness to stripe_subscription_id (enabling 1:N multi-subscriptions per user)
-- 2. Indexing subscriptions tier, user_id, status
-- 3. Composite unique constraint (user_id, operation_id) and request_hash on ai_reservations
-- 4. Indexing users.stripe_customer_id and files.parent_folder_id

DO $$
BEGIN
    -- 1. Subscriptions: Drop single-subscription unique constraint on user_id if present
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'subscriptions_user_id_unique'
          AND table_name = 'subscriptions'
    ) THEN
        ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_user_id_unique;
    END IF;
END $$;

DROP INDEX IF EXISTS subscriptions_user_id_unique;
DROP INDEX IF EXISTS idx_subscriptions_user_id_unique;

-- Subscriptions: Ensure cascade foreign key to users
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'subscriptions_user_id_users_id_fk'
          AND table_name = 'subscriptions'
    ) THEN
        ALTER TABLE subscriptions
            ADD CONSTRAINT subscriptions_user_id_users_id_fk
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Subscriptions: Unique constraint on stripe_subscription_id (partial index for non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe_id_unique
    ON subscriptions USING btree (stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

-- Subscriptions: Operational indexes for entitlement lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id
    ON subscriptions USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tier
    ON subscriptions USING btree (tier);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
    ON subscriptions USING btree (status);

-- 2. AI Reservations: Add request_hash column if missing
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ai_reservations' AND column_name = 'request_hash'
    ) THEN
        ALTER TABLE ai_reservations ADD COLUMN request_hash VARCHAR(64) NOT NULL DEFAULT '';
    END IF;
END $$;

-- AI Reservations: Composite unique constraint (user_id, operation_id) preventing race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_reservations_user_op
    ON ai_reservations USING btree (user_id, operation_id);

-- AI Reservations: Index for request_hash replay inspection
CREATE INDEX IF NOT EXISTS idx_ai_reservations_request_hash
    ON ai_reservations USING btree (request_hash);

-- 3. Users: Fast Stripe customer lookup index (LUGX-141)
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id
    ON users USING btree (stripe_customer_id);

-- 4. Files: Direct parent_folder_id index for directory traversal (LUGX-143)
CREATE INDEX IF NOT EXISTS idx_files_parent_folder
    ON files USING btree (parent_folder_id);
