import { pgTable, uuid, date, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users";

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
    // DATA INTEGRITY: exactly one usage row per (user, day)
    uniqueIndex("idx_usage_user_date_unique").on(table.userId, table.date),
    index("idx_usage_user_date").on(table.userId, table.date),
]);

export type Usage = typeof usage.$inferSelect;
