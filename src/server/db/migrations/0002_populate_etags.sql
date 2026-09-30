-- Migration: Populate ETags for existing files
-- This migration generates ETags for all existing files that don't have one

-- Generate ETag using MD5 hash of id + content + updated_at
-- This ensures existing files can participate in sync immediately
UPDATE files 
SET etag = MD5(
  COALESCE(id::text, '') || 
  COALESCE(content, '') || 
  COALESCE(updated_at::text, '')
)
WHERE etag IS NULL;

-- Set version to 1 for any files that might have NULL version
UPDATE files 
SET version = 1 
WHERE version IS NULL;
