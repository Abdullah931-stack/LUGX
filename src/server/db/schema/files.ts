import { pgTable, uuid, varchar, text, boolean, timestamp, integer, jsonb, uniqueIndex, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export interface FileEncryptionMetadata {
    version: number;
    algorithm: string;
    keyId: string;
    salt: string;
    iv: string;
    kdfIterations?: number;
}

export const files = pgTable("files", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 500 }).notNull(),
    /** Normalized UTF-8 Markdown source text (MarkdownSource) */
    content: text("content"),
    parentFolderId: uuid("parent_folder_id").references((): AnyPgColumn => files.id, { onDelete: "set null" }), // Self-referencing FK
    isFolder: boolean("is_folder").notNull().default(false),
    // Encryption fields (Dual-Tier Hybrid & Zero-Knowledge Vault)
    isEncrypted: boolean("is_encrypted").notNull().default(false),
    encryptionMetadata: jsonb("encryption_metadata").$type<FileEncryptionMetadata>(),
    // Sync-related fields
    etag: varchar("etag", { length: 64 }), // SHA-256 hash for change detection
    version: integer("version").default(1), // Monotonically increasing version
    deletedAt: timestamp("deleted_at"), // Soft delete for sync reconciliation
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
    // Partial unique index: a user cannot have two live (non-deleted) files with the same parent folder and title
    uniqueIndex("idx_files_user_parent_title_live")
        .on(table.userId, sql`COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid)`, table.title)
        .where(sql`deleted_at IS NULL`),
    // Sync query performance
    index("idx_files_user_deleted").on(table.userId, table.deletedAt),
    index("idx_files_parent_user").on(table.parentFolderId, table.userId),
    // LUGX-143: direct parent_folder_id index for fast hierarchical traversal
    index("idx_files_parent_folder").on(table.parentFolderId),
]);

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
