-- Add sync-related fields to files table
-- Migration: 0001_add_sync_fields

-- Add etag column for change detection (SHA-256 hash, 32 chars)
ALTER TABLE files ADD COLUMN IF NOT EXISTS etag VARCHAR(64);

-- Add version column for optimistic locking
ALTER TABLE files ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- Add deleted_at for soft deletes (sync reconciliation)
ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_files_etag ON files(etag);
CREATE INDEX IF NOT EXISTS idx_files_version ON files(version);
CREATE INDEX IF NOT EXISTS idx_files_deleted_at ON files(deleted_at);
CREATE INDEX IF NOT EXISTS idx_files_updated_at ON files(updated_at);
