import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeonServerless } from "drizzle-orm/neon-serverless";
import { Pool as NodePgPool } from "pg";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

let instance: ReturnType<typeof drizzleNodePg<typeof schema>> | null = null;
let currentDbUrl: string | null = null;

export function getTxDb() {
    const dbUrl =
        process.env.DATABASE_URL ||
        "postgresql://placeholder:placeholder@localhost:5432/placeholder";

    // Invalidate cached instance if DATABASE_URL was rebound (e.g. during test setup)
    if (instance && currentDbUrl === dbUrl) {
        return instance;
    }

    currentDbUrl = dbUrl;

    const isNeonCloud =
        dbUrl.includes("neon.tech") &&
        !dbUrl.includes("localhost") &&
        !dbUrl.includes("127.0.0.1");

    if (isNeonCloud) {
        const pool = new NeonPool({
            connectionString: dbUrl,
            max: 5,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
        });
        instance = drizzleNeonServerless(pool, { schema }) as unknown as ReturnType<typeof drizzleNodePg<typeof schema>>;
    } else {
        const isSsl =
            dbUrl.includes("sslmode=require") ||
            dbUrl.includes("supabase.co") ||
            dbUrl.includes("pooler.supabase.com");

        const pool = new NodePgPool({
            connectionString: dbUrl,
            ssl: isSsl ? { rejectUnauthorized: false } : undefined,
            max: 5,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
        });
        instance = drizzleNodePg(pool, { schema });
    }

    return instance;
}

/**
 * Transactional DB client with multi-environment adaptive driver support:
 * - Uses Neon Serverless WebSocket Pool in Neon Cloud
 * - Uses node-postgres TCP Pool in CI, Docker, and local PostgreSQL environments
 *
 * Implemented via Proxy to lazily resolve the active connection URL and driver.
 */
export const txDb = new Proxy({} as ReturnType<typeof drizzleNodePg<typeof schema>>, {
    get(_target, prop, receiver) {
        const target = getTxDb();
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
            return value.bind(target);
        }
        return value;
    },
});

export { schema };

