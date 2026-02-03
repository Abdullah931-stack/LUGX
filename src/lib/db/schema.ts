import { pgTable, uuid, varchar, text, boolean, timestamp, date, integer, pgEnum } from "drizzle-orm/pg-core";

// Enums
export const tierEnum = pgEnum("tier", ["free", "pro", "ultra"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["active", "canceled", "past_due", "trialing"]);

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
    content: text("content"),
    parentFolderId: uuid("parent_folder_id"),
    isFolder: boolean("is_folder").notNull().default(false),
    storagePath: text("storage_path"), // Supabase Storage path for original files
    // Sync-related fields
    etag: varchar("etag", { length: 64 }), // SHA-256 hash for change detection
    version: integer("version").default(1), // Monotonically increasing version
    deletedAt: timestamp("deleted_at"), // Soft delete for sync reconciliation
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

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
});

// Types for TypeScript
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type Usage = typeof usage.$inferSelect;
