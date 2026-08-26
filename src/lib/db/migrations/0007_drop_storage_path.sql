-- Phase 14: Drop unused Supabase Storage column from files table
ALTER TABLE "files" DROP COLUMN IF EXISTS "storage_path";
