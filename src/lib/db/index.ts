import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Create Neon client with runtime URL or build-safe placeholder
const sql = neon(
    process.env.DATABASE_URL || "postgresql://placeholder:placeholder@localhost:5432/placeholder"
);

// Create Drizzle instance with schema
export const db = drizzle(sql, { schema });

// Export schema for use in queries
export { schema };
