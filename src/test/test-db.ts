/**
 * Test database client: plain `pg` driver pointing at the ISOLATED Neon test
 * branch (TEST_DATABASE_URL), never at the app's production main branch.
 *
 * Phase 10 fail-closed gate: `assertSafeTestDatabaseUrl()` throws BEFORE the
 * Pool below is created unless the effective DATABASE_URL is exactly the
 * designated TEST_DATABASE_URL. See `src/test/test-db-guard.ts` and
 * docs/reference/test-database-isolation.md.
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { inArray, like, or } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import {
    assertSafeTestDatabaseUrl,
    printTestDbIdentity,
} from "@/test/test-db-guard";

const dbUrl = process.env.DATABASE_URL || "";
// Fail-closed identity check — no connection object exists until this passes.
const branchIdentity = assertSafeTestDatabaseUrl({
    databaseUrl: dbUrl,
    testDatabaseUrl: process.env.TEST_DATABASE_URL,
    forbiddenHosts: process.env.TEST_DB_FORBIDDEN_HOSTS,
});
printTestDbIdentity(branchIdentity);

const isSsl =
    dbUrl.includes("sslmode=require") ||
    dbUrl.includes("neon.tech") ||
    dbUrl.includes("supabase.co") ||
    dbUrl.includes("pooler.supabase.com");

const pool = new Pool({
    connectionString: dbUrl,
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
});

export const testDb = drizzle(pool, { schema });
export { pool };

/**
 * Placeholder UUID shape used by integration tests to seed throwaway
 * accounts: recognizable repeating-block patterns — either a single repeated
 * digit (1111…, 2222…, …) or a repeated 4-digit block (1212…).
 *
 * SAFETY: `assertPlaceholderUserIds()` enforces this shape so a real-looking
 * auth UUID can never be passed into the destructive cleanup by accident.
 */
export const PLACEHOLDER_UUID_PATTERN =
    /^(\d{4})\1-\1-\1-\1-\1{3}$/;

/**
 * Email suffix reserved for throwaway per-test accounts created with
 * `crypto.randomUUID()` inside test bodies (e.g. `<uuid>@integrity.test`).
 * `.test` is an IETF-reserved TLD (RFC 2606) that can never belong to a real
 * Supabase auth account.
 */
export const TEST_USER_EMAIL_PATTERN = "%.test";

/**
 * Guards a cleanup target list: every entry MUST be a recognizable
 * placeholder UUID. Throws if a real-looking UUID sneaks onto the list,
 * so the destructive cleanup below can never target production accounts.
 */
export function assertPlaceholderUserIds(ids: readonly string[]): void {
    if (ids.length === 0) {
        throw new Error(
            "[cleanupTestUsers] Refusing to run with an empty id list."
        );
    }
    for (const id of ids) {
        if (!PLACEHOLDER_UUID_PATTERN.test(id)) {
            throw new Error(
                `[cleanupTestUsers] Refusing to run: id '${id}' does not match the placeholder pattern. Real user IDs must never be passed here.`
            );
        }
    }
}

/**
 * Deletes ONLY the given test accounts from the users table.
 *
 * IMPORTANT: always pass EXACTLY the ids seeded by *this* test file. Suites
 * run in parallel workers against the live database — deleting another
 * suite's ids here would yank its data mid-run.
 *
 * Schema FKs (`files`, `usage`, `ai_reservations`) reference users.id with
 * ON DELETE CASCADE, so all dependent rows of those accounts are removed in
 * the same statement. Real users are untouched by construction.
 */
export async function cleanupTestUsers(
    ids: readonly string[],
    options?: { emailPattern?: string }
): Promise<void> {
    assertPlaceholderUserIds(ids);

    const conditions = [inArray(schema.users.id, [...ids])];
    if (options?.emailPattern) {
        // Only suites that mint random per-run accounts (emails under the
        // RFC-reserved `.test` domain) may use the email-pattern branch.
        conditions.push(like(schema.users.email, options.emailPattern));
    }

    await testDb.delete(schema.users).where(or(...conditions));
}
