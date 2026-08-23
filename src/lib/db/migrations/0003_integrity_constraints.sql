-- Migration: 0003_integrity_constraints
-- DATA INTEGRITY: unique constraint on usage(user_id, date), sync-related
-- indexes on files, and a self-referencing FK for the folder hierarchy.

-- ---------------------------------------------------------------------------
-- 1. Usage: exactly one usage row per (user, day).
--    This is the database-level backstop that prevents the race condition
--    where two concurrent upserts could previously insert duplicate daily
--    rows. It also makes INSERT ... ON CONFLICT DO UPDATE safe and idempotent.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_date_unique
    ON usage USING btree (user_id, date);

CREATE INDEX IF NOT EXISTS idx_usage_user_date
    ON usage USING btree (user_id, date);

-- ---------------------------------------------------------------------------
-- 2. Files: sync query performance indexes.
--    - (user_id, deleted_at): the standard "live files for user" filter.
--    - (parent_folder_id, user_id): "children of folder" listing.
--    - Partial unique (user_id, parent_folder_id, title) WHERE deleted_at IS NULL:
--      prevents two live files with the same name in the same folder.
--      The partial scope keeps soft-deleted rows out of uniqueness, so a
--      deleted file can be restored without colliding with a live sibling.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_files_user_deleted
    ON files USING btree (user_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_files_parent_user
    ON files USING btree (parent_folder_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_files_user_parent_title_live
    ON files USING btree (user_id, COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid), title)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Files: self-referencing FK for the folder hierarchy.
--    ON DELETE SET NULL keeps children alive when a folder is deleted
--    (they move to the root) instead of being cascade-deleted with it.
--    Wrapped in DO $$ ... EXCEPTION so the migration stays idempotent on
--    deployments where the FK already exists (e.g. created by drizzle push).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    BEGIN
        ALTER TABLE files
            ADD CONSTRAINT files_parent_folder_id_files_id_fk
            FOREIGN KEY (parent_folder_id)
            REFERENCES files (id)
            ON DELETE SET NULL
            ON UPDATE NO ACTION;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;
END $$;
