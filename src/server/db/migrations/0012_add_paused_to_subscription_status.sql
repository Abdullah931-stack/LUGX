-- Migration: 0012_add_paused_to_subscription_status
-- Hardened for Phase 12 (LUGX-069):
-- Add 'paused' status to subscription_status PostgreSQL enum if not already present.

DO $$
BEGIN
    ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'paused';
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
