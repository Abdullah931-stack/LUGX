import { pgTable, uuid, varchar, boolean, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { users, tierEnum } from "./users";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
    "active",
    "canceled",
    "past_due",
    "trialing",
    "incomplete",
    "incomplete_expired",
    "unpaid",
    "paused",
]);

// Subscriptions table - Stripe subscription tracking
// Hardened for Phase 7 (LUGX-025, LUGX-027, LUGX-068, LUGX-069):
// 1. Shifting uniqueness from userId to stripe_subscription_id allows 1:N subscriptions per user.
// 2. Cascade foreign key ensures automated cleanup on account removal.
// 3. Dedicated indexes on tier, userId, and status optimize entitlement gates.
export const subscriptions = pgTable("subscriptions", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }).unique(),
    tier: tierEnum("tier").notNull().default("free"),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
    index("idx_subscriptions_user_id").on(table.userId),
    index("idx_subscriptions_tier").on(table.tier),
    index("idx_subscriptions_status").on(table.status),
]);

export type Subscription = typeof subscriptions.$inferSelect;
