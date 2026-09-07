-- Migration 0009: Add device_trust_epoch for trusted device epoch revocation
-- Ensures global device invalidation counter is stored in user_vault_profiles

ALTER TABLE "user_vault_profiles" ADD COLUMN IF NOT EXISTS "device_trust_epoch" integer DEFAULT 1 NOT NULL;
