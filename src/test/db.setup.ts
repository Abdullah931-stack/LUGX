/**
 * Shared integration-test database setup.
 *
 * 1. Applies the canonical schema (via drizzle-kit push against the local DB)
 *    so the test DB matches production's latest schema.ts.
 * 2. Applies the official hand-written migration 0003 directly via `psql`,
 *    guaranteeing the UNIQUE INDEX on usage(user_id, date) and the sync
 *    indexes actually exist on the DB being tested.
 *
 * Environment requirements (see .env.test and vitest.config.ts envFile):
 *   - Local Postgres on localhost:5432 with user `lugx`, db `lugx_test`
 *   - DATABASE_URL=postgresql://lugx:lugx_test@localhost:5432/lugx_test
 *
 * This module parses .env.test itself (no dotenv runtime dependency) so it
 * works reliably inside Vitest workers.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "src/lib/db/migrations");

function getDatabaseUrl(): string {
    const url =
        process.env.DATABASE_URL ||
        fs
            .readFileSync(path.join(ROOT, ".env.test"), "utf8")
            .split("\n")
            .find((line) => line.startsWith("DATABASE_URL="))
            ?.slice("DATABASE_URL=".length)
            .trim();
    if (!url) throw new Error("DATABASE_URL not found for integration tests");
    return url;
}

let ensured = false;

export async function ensureTestDb() {
    if (ensured) return;

    const dbUrl = getDatabaseUrl();
    const env = { ...process.env, DATABASE_URL: dbUrl };

    // 1. Canonical schema via drizzle-kit (idempotent).
    execSync(
        `npx drizzle-kit push --force --config=${path.join(ROOT, "drizzle.config.test.ts")}`,
        { cwd: ROOT, stdio: "ignore", env }
    );

    // 2. Official hand-written migration 0003 (idempotent via IF NOT EXISTS).
    execSync(
        `psql "${dbUrl}" -f ${path.join(MIGRATIONS_DIR, "0003_integrity_constraints.sql")}`,
        { cwd: ROOT, stdio: "ignore", env }
    );
    ensured = true;
}

export async function runMigrations() {
    await ensureTestDb();
}
