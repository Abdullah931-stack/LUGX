import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and } from "drizzle-orm";
import * as schema from "../../src/lib/db/schema";
import dotenv from "dotenv";
import path from "path";

// Ensure test environment is loaded
dotenv.config({ path: path.resolve(process.cwd(), ".env.test.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.test") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
    throw new Error("[E2E Test DB] TEST_DATABASE_URL is not set.");
}

// Ensure safety check
if (testDbUrl.includes("ep-lucky-star")) {
    throw new Error("[E2E Test DB Guard] Refusing to connect to production database!");
}

const pool = new Pool({
    connectionString: testDbUrl,
    ssl: { rejectUnauthorized: false },
    max: 5,
});

export const e2eDb = drizzle(pool, { schema });

/**
 * Seed an E2E user directly in the test database
 */
export async function seedE2EUser(userId: string, email: string, displayName = "E2E User") {
    await e2eDb
        .insert(schema.users)
        .values({
            id: userId,
            email,
            displayName,
            tier: "free",
        })
        .onConflictDoUpdate({
            target: schema.users.id,
            set: { displayName, updatedAt: new Date() },
        });

    await e2eDb
        .insert(schema.usage)
        .values({
            userId,
            date: new Date().toISOString().split("T")[0],
        })
        .onConflictDoNothing();
}

/**
 * Clean up all data associated with an E2E user
 */
export async function cleanupE2EUser(userId: string) {
    try {
        await e2eDb.delete(schema.files).where(eq(schema.files.userId, userId));
        await e2eDb.delete(schema.aiReservations).where(eq(schema.aiReservations.userId, userId));
        await e2eDb.delete(schema.usage).where(eq(schema.usage.userId, userId));
        await e2eDb.delete(schema.subscriptionEvents).where(eq(schema.subscriptionEvents.userId, userId));
        await e2eDb.delete(schema.userVaultProfiles).where(eq(schema.userVaultProfiles.userId, userId));
        await e2eDb.delete(schema.users).where(eq(schema.users.id, userId));
    } catch (err) {
        console.warn(`[E2E Cleanup] Warning during cleanup for user ${userId}:`, err);
    }
}

/**
 * Retrieve file from database for assertions
 */
export async function getDbFile(fileId: string) {
    return e2eDb.query.files.findFirst({
        where: eq(schema.files.id, fileId),
    });
}

/**
 * Update file version directly in database (simulates concurrent writes from another client/tab)
 */
export async function simulateRemoteFileUpdate(fileId: string, newContent: string, newVersion: number) {
    return e2eDb
        .update(schema.files)
        .set({
            content: newContent,
            version: newVersion,
            updatedAt: new Date(),
        })
        .where(eq(schema.files.id, fileId));
}

/**
 * Retrieve user usage row
 */
export async function getDbUsage(userId: string) {
    const today = new Date().toISOString().split("T")[0];
    return e2eDb.query.usage.findFirst({
        where: and(eq(schema.usage.userId, userId), eq(schema.usage.date, today)),
    });
}

/**
 * Retrieve AI reservations for user
 */
export async function getDbReservations(userId: string) {
    return e2eDb.query.aiReservations.findMany({
        where: eq(schema.aiReservations.userId, userId),
    });
}

/**
 * Retrieve subscription events
 */
export async function getDbSubscriptionEvents(userId: string) {
    return e2eDb.query.subscriptionEvents.findMany({
        where: eq(schema.subscriptionEvents.userId, userId),
    });
}
