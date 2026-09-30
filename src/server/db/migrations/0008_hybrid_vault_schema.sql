-- Migration 0008: Hybrid Vault Schema & Zero-Knowledge Encryption Support
-- Creates user_vault_profiles table and adds encryption fields to files table

CREATE TABLE IF NOT EXISTS "user_vault_profiles" (
    "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "encrypted_master_key" text NOT NULL,
    "recovery_encrypted_master_key" text NOT NULL,
    "key_salt" text NOT NULL,
    "recovery_salt" text NOT NULL,
    "kdf_iterations" integer DEFAULT 600000 NOT NULL,
    "key_version" integer DEFAULT 1 NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "is_encrypted" boolean DEFAULT false NOT NULL;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "encryption_metadata" jsonb;

CREATE INDEX IF NOT EXISTS "idx_files_user_encrypted" ON "files"("user_id", "is_encrypted");
