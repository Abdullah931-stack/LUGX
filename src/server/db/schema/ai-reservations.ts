import { pgTable, uuid, varchar, timestamp, integer, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { files } from "./files";

// AI Reservation status enum for idempotent quota & streaming lifecycle
export const aiReservationStatusEnum = pgEnum("ai_reservation_status", [
    "reserved",
    "committed",
    "refunded",
    "expired",
]);

// AI Reservations table - tracks idempotent quota reservation lifecycle
// Hardened for Phase 7 (LUGX-030, LUGX-031):
// 1. Composite unique index (user_id, operation_id) prevents duplicate reservation race conditions.
// 2. request_hash prevents replay attacks with divergent prompt payloads.
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
    requestHash: varchar("request_hash", { length: 64 }).notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
    // LUGX-030: Composite unique constraint preventing concurrent reservation races per user
    uniqueIndex("idx_ai_reservations_user_op").on(table.userId, table.operationId),
    uniqueIndex("idx_ai_reservations_user_op_period").on(table.userId, table.operationId, table.periodKey),
    uniqueIndex("idx_ai_reservations_operation_id").on(table.operationId),
    index("idx_ai_reservations_user_status").on(table.userId, table.status),
    index("idx_ai_reservations_status_expires").on(table.status, table.expiresAt),
    index("idx_ai_reservations_request_hash").on(table.requestHash),
]);

export type AIReservation = typeof aiReservations.$inferSelect;
export type NewAIReservation = typeof aiReservations.$inferInsert;
