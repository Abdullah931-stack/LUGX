import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";

// Enums
export const tierEnum = pgEnum("tier", ["free", "pro", "ultra"]);

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
}, (table) => [
    // LUGX-141: Fast customer lookup on Stripe webhooks
    index("idx_users_stripe_customer_id").on(table.stripeCustomerId),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
