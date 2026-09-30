import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users";

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

export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type NewSubscriptionEvent = typeof subscriptionEvents.$inferInsert;
