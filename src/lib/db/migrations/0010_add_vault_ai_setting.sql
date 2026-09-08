-- Migration 0010: Add allow_ai_on_encrypted_files to user_vault_profiles
ALTER TABLE "user_vault_profiles" ADD COLUMN IF NOT EXISTS "allow_ai_on_encrypted_files" boolean DEFAULT false NOT NULL;
