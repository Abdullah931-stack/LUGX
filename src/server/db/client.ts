import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const dbUrl =
    process.env.DATABASE_URL ||
    "postgresql://placeholder:placeholder@localhost:5432/placeholder";

// Detect whether the target connection string points to Neon cloud HTTP proxy
// vs a standard local/containerized PostgreSQL database (e.g. CI / Docker / localhost).
const isNeonCloud =
    dbUrl.includes("neon.tech") &&
    !dbUrl.includes("localhost") &&
    !dbUrl.includes("127.0.0.1");

function createDbInstance() {
    if (isNeonCloud) {
        const sql = neon(dbUrl);
        return drizzleNeonHttp(sql, { schema });
    }

    const isSsl =
        dbUrl.includes("sslmode=require") ||
        dbUrl.includes("supabase.co") ||
        dbUrl.includes("pooler.supabase.com");

    const pool = new Pool({
        connectionString: dbUrl,
        ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    });
    return drizzleNodePg(pool, { schema });
}

// Export unified Drizzle instance with schema
export const db = createDbInstance() as unknown as ReturnType<typeof drizzleNodePg<typeof schema>>;

// Export schema for use in queries
export { schema };
