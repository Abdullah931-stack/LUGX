-- ---------------------------------------------------------------------------
-- 0004: Stripe subscription integrity constraints (W2 + W6)
-- ---------------------------------------------------------------------------
-- ENGINEERING UPGRADE:
-- a) UNIQUE constraint on subscriptions.stripe_subscription_id:
--    Previously two different Stripe subscriptions could be upserted onto the
--    same subscription row (upsertSubscription matches on userId only),
--    silently overwriting the real subscription id. The constraint makes a
--    duplicated/substituted subscription id impossible at the database level.
-- b) subscription_status enum extended to the full Stripe lifecycle:
--    ["active","canceled","past_due","trialing","incomplete","incomplete_expired",
--     "unpaid","paused","trialing"] → extended to cover
--    "incomplete","incomplete_expired","unpaid".
--    The old code fell through to `status = 'active'` on any unrecognized
--    status (a fail-open bug that could grant paid-tier status on payment
--    failures). The handler now uses fail-closed semantics instead.
-- c) Partial unique index on (user_id) WHERE stripe_subscription_id IS NOT NULL
--    is already covered by the subscriptions.user_id UNIQUE; we add the
--    stripe-side uniqueness here.
-- Idempotent: wrapped in DO $$ EXCEPTION blocks; safe to run repeatedly.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    -- 1. Extend the subscription_status enum with payment-failure states.
    BEGIN
        ALTER TYPE subscription_status ADD VALUE 'incomplete';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE subscription_status ADD VALUE 'incomplete_expired';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
    BEGIN
        ALTER TYPE subscription_status ADD VALUE 'unpaid';
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    -- 2. UNIQUE on stripe_subscription_id (with a partial index so NULL ids,
    --    which a user can legitimately have before any subscription, are not
    --    constrained).
    BEGIN
        CREATE UNIQUE INDEX idx_subscriptions_stripe_id_unique
            ON subscriptions (stripe_subscription_id)
            WHERE stripe_subscription_id IS NOT NULL;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END $$;
