/**
 * Test database client: plain `pg` driver pointing at the configured Postgres
 * database (local or live database from .env.local).
 */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";

const dbUrl = process.env.DATABASE_URL || "";
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
