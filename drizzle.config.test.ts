import { defineConfig } from "drizzle-kit";
import "dotenv/config";
export default defineConfig({
    schema: "./src/lib/db/schema.ts",
    out: "./drizzle/migrations-test",
    dialect: "postgresql",
    dbCredentials: { url: process.env.DATABASE_URL! },
    strict: true,
});
