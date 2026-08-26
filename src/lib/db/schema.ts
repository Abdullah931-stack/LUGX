import { pgTable, uuid, varchar, text, boolean, timestamp, date, integer, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums
export const tierEnum = pgEnum("tier", ["free", "pro", "ultra"]);
// ENGINEERING UPGRADE (W2): extended (migration 0004) with the Stripe
// payment-failure states ("incomplete", "incomplete_expired", "unpaid") so
// the webhook handler can map every real Stripe status explicitly and fail
// CLOSED on unknown ones — previously any unrecognized status silently
// fell back to "active", potentially granting paid-tier privileges on
// payment failures.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
    "active",
    "canceled",
    "past_due",
    "trialing",
    "incomplete",
    "incomplete_expired",
    "unpaid",
]);

// Users table - linked to Supabase Auth via UUID
export const users = pgTable("users", {
    id: uuid("id").primaryKey(), // From Supabase Auth
    email: varchar("email", { length: 255 }).notNull().unique(),
    displayName: varchar("display_name", { length: 255 }),
    avatarUrl: text("avatar_url"),
    tier: tierEnum("tier").notNull().default("free"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Files table - user documents and folders
export const files = pgTable("files", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 500 }).notNull(),
    /** Normalized UTF-8 Markdown source text (MarkdownSource) */
    content: text("content"),
    parentFolderId: uuid("parent_folder_id").references((): any => files.id, { onDelete: "set null" }), // Self-referencing FK (deferred at schema level; see migration 0003 for ON DELETE behavior and deferrability)
    isFolder: boolean("is_folder").notNull().default(false),
    // Sync-related fields
    etag: varchar("etag", { length: 64 }), // SHA-256 hash for change detection
    version: integer("version").default(1), // Monotonically increasing version
    deletedAt: timestamp("deleted_at"), // Soft delete for sync reconciliation
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
    // Partial unique index: a user cannot have two live (non-deleted) files
    // with the same parent folder and title. Partial indexes keep soft-deleted
    // rows out of the uniqueness scope so restored files never collide.
    uniqueIndex("idx_files_user_parent_title_live")
        .on(table.userId, sql`COALESCE(parent_folder_id, '00000000-0000-0000-0000-000000000000'::uuid)`, table.title)
        .where(sql`deleted_at IS NULL`),
    // Sync query performance: the two most common filter patterns are
    // "all live files for a user" and "children of a folder".
    index("idx_files_user_deleted").on(table.userId, table.deletedAt),
    index("idx_files_parent_user").on(table.parentFolderId, table.userId),
]);

// Subscriptions table - Stripe subscription tracking
export const subscriptions = pgTable("subscriptions", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    tier: tierEnum("tier").notNull().default("free"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Daily usage tracking table
export const usage = pgTable("usage", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    correctWords: integer("correct_words").notNull().default(0),
    improveWords: integer("improve_words").notNull().default(0),
    translateWords: integer("translate_words").notNull().default(0),
    summarizeCount: integer("summarize_count").notNull().default(0),
    summarizeWords: integer("summarize_words").notNull().default(0),
    toPromptCount: integer("to_prompt_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
    // DATA INTEGRITY FIX: exactly one usage row per (user, day). This unique
    // index is the database-level backstop against the race where concurrent
    // upserts could previously insert duplicate daily rows. It also makes the
    // getTodayUsage UPSERT (INSERT ... ON CONFLICT DO UPDATE) safe and idempotent.
    uniqueIndex("idx_usage_user_date_unique").on(table.userId, table.date),
    // Common lookup pattern: today's usage for a user.
    index("idx_usage_user_date").on(table.userId, table.date),
]);

// AI Reservation status enum for idempotent quota & streaming lifecycle
export const aiReservationStatusEnum = pgEnum("ai_reservation_status", [
    "reserved",
    "committed",
    "refunded",
    "expired",
]);

// AI Reservations table - tracks idempotent quota reservation lifecycle
export const aiReservations = pgTable("ai_reservations", {
    id: uuid("id").primaryKey().defaultRandom(),
    operationId: varchar("operation_id", { length: 255 }).notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    operation: varchar("operation", { length: 64 }).notNull(),
    reservedUnits: integer("reserved_units").notNull().default(0),
    committedUnits: integer("committed_units").notNull().default(0),
    refundedUnits: integer("refunded_units").notNull().default(0),
    periodKey: varchar("period_key", { length: 32 }).notNull(),
    status: aiReservationStatusEnum("status").notNull().default("reserved"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
    uniqueIndex("idx_ai_reservations_user_op_period").on(table.userId, table.operationId, table.periodKey),
    uniqueIndex("idx_ai_reservations_operation_id").on(table.operationId),
    index("idx_ai_reservations_user_status").on(table.userId, table.status),
    index("idx_ai_reservations_status_expires").on(table.status, table.expiresAt),
]);

// Subscription Events table - durable idempotency ledger for Stripe webhooks
export const subscriptionEvents = pgTable("subscription_events", {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: varchar("event_id", { length: 255 }).notNull().unique(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
    status: varchar("status", { length: 64 }).notNull().default("processed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
    uniqueIndex("idx_subscription_events_event_id").on(table.eventId),
    index("idx_subscription_events_user_id").on(table.userId),
    index("idx_subscription_events_created_at").on(table.createdAt),
]);

// Types for TypeScript
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Usage = typeof usage.$inferSelect;
export type AIReservation = typeof aiReservations.$inferSelect;
export type NewAIReservation = typeof aiReservations.$inferInsert;
export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;

