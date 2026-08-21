import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

let poolInstance: Pool | null = null;

function getPool(): Pool {
    if (!poolInstance) {
        poolInstance = new Pool({
            connectionString: process.env.DATABASE_URL || "",
            max: 5,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
        });
    }
    return poolInstance;
}

/**
 * Transactional DB client powered by Neon Serverless Pool / WebSockets.
 * Allows interactive SQL transactions (BEGIN / COMMIT / ROLLBACK) via `txDb.transaction(...)`.
 */
export const txDb = drizzle(getPool(), { schema });
export { schema };
