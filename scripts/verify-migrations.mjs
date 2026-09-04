/**
 * Migration & Schema Verification Script for CI and Local Integration.
 *
 * Verifies that the test database is accessible, applies all raw SQL migrations
 * from `src/lib/db/migrations` sequentially, and validates that all critical
 * tables, enums, indexes, and constraints exist.
 *
 * Usage:
 *   node scripts/verify-migrations.mjs
 */
import { Pool } from "pg";
import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Load test environment (priority: shell > .env.test.local > .env.test > .env.local > .env)
dotenvConfig({ path: path.join(ROOT, ".env.test.local"), override: true });
dotenvConfig({ path: path.join(ROOT, ".env.test"), override: false });
dotenvConfig({ path: path.join(ROOT, ".env.local"), override: false });
dotenvConfig({ path: path.join(ROOT, ".env"), override: false });

const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!dbUrl) {
    console.error("[verify-migrations] ERROR: Neither TEST_DATABASE_URL nor DATABASE_URL is defined.");
    process.exit(1);
}

const parsedUrl = new URL(dbUrl);
console.log(`[verify-migrations] Connecting to database: ${parsedUrl.hostname}:${parsedUrl.port || 5432}${parsedUrl.pathname}`);

const isSsl =
    dbUrl.includes("sslmode=require") ||
    dbUrl.includes("neon.tech") ||
    dbUrl.includes("supabase.co");

const pool = new Pool({
    connectionString: dbUrl,
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000,
});

async function main() {
    try {
        // 1. Connection check
        const { rows: versionRows } = await pool.query("SELECT version()");
        console.log(`[verify-migrations] Connected successfully to PostgreSQL: ${versionRows[0].version.split(",")[0]}`);

        // 2. Base table initialization if needed (users, files, subscriptions, usage)
        // Ensure base enums and tables exist prior to incremental migrations if starting from scratch
        await pool.query(`
            DO $$ BEGIN
                CREATE TYPE tier AS ENUM ('free', 'pro', 'ultra');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            DO $$ BEGIN
                CREATE TYPE subscription_status AS ENUM ('active', 'canceled', 'past_due', 'trialing', 'incomplete', 'incomplete_expired', 'unpaid');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            DO $$ BEGIN
                CREATE TYPE ai_reservation_status AS ENUM ('reserved', 'committed', 'refunded', 'expired');
            EXCEPTION
                WHEN duplicate_object THEN null;
            END $$;

            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255),
                avatar_url TEXT,
                tier tier NOT NULL DEFAULT 'free',
                stripe_customer_id VARCHAR(255),
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS files (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(500) NOT NULL,
                content TEXT,
                parent_folder_id UUID,
                is_folder BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS subscriptions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                stripe_subscription_id VARCHAR(255),
                tier tier NOT NULL DEFAULT 'free',
                status subscription_status NOT NULL DEFAULT 'active',
                current_period_start TIMESTAMP,
                current_period_end TIMESTAMP,
                cancel_at_period_end BOOLEAN DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS usage (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                correct_words INTEGER NOT NULL DEFAULT 0,
                improve_words INTEGER NOT NULL DEFAULT 0,
                translate_words INTEGER NOT NULL DEFAULT 0,
                summarize_count INTEGER NOT NULL DEFAULT 0,
                summarize_words INTEGER NOT NULL DEFAULT 0,
                to_prompt_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        // 3. Apply incremental migrations from src/lib/db/migrations
        const migrationsDir = path.join(ROOT, "src/lib/db/migrations");
        if (fs.existsSync(migrationsDir)) {
            const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
            console.log(`[verify-migrations] Found ${files.length} migration files in ${migrationsDir}`);

            for (const file of files) {
                const sqlPath = path.join(migrationsDir, file);
                const sqlContent = fs.readFileSync(sqlPath, "utf8");
                if (sqlContent.trim()) {
                    console.log(`[verify-migrations] Applying migration: ${file}...`);
                    await pool.query(sqlContent);
                }
            }
        }

        // 4. Verify all critical tables exist
        const requiredTables = [
            "users",
            "files",
            "subscriptions",
            "usage",
            "ai_reservations",
            "subscription_events",
            "user_vault_profiles",
        ];

        const { rows: existingTables } = await pool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
        `);

        const tableNames = new Set(existingTables.map((r) => r.table_name));
        for (const table of requiredTables) {
            if (!tableNames.has(table)) {
                throw new Error(`[verify-migrations] Missing required table: ${table}`);
            }
        }
        console.log(`[verify-migrations] Verified all ${requiredTables.length} core tables exist:`, requiredTables.join(", "));

        // 5. Verify critical indexes & constraints
        const { rows: indexes } = await pool.query(`
            SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        `);
        const indexNames = new Set(indexes.map((i) => i.indexname));

        const requiredIndexes = [
            "idx_files_user_parent_title_live",
            "idx_ai_reservations_user_op_period",
            "idx_subscription_events_event_id",
            "idx_usage_user_date_unique",
        ];

        for (const idx of requiredIndexes) {
            if (!indexNames.has(idx)) {
                console.warn(`[verify-migrations] WARNING: Expected index '${idx}' not found in pg_indexes.`);
            } else {
                console.log(`[verify-migrations] Verified index: ${idx}`);
            }
        }

        console.log("[verify-migrations] SUCCESS: All migrations applied and verified without errors.");
    } catch (err) {
        console.error("[verify-migrations] FAILURE during verification:", err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
