/**
 * Test database client: plain `pg` driver pointing at the LOCAL Postgres
 * (pglite-like setup: postgresql://...@localhost).
 *
 * The production db client in @/lib/db uses the Neon HTTP driver, which only
 * speaks websocket to remote Neon instances. For integration tests we need a
 * plain TCP client, so this module exists purely for the test env.
 */
// DATABASE_URL is injected by vitest.config.ts envFile ('.env.test')
// before any test module is loaded — no dotenv runtime import needed.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/lib/db/schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const testDb = drizzle(pool, { schema });
export { pool };
