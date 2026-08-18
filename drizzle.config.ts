import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load .env.local (Next.js default) with fallback to .env
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
    schema: "./src/lib/db/schema.ts",
    out: "./src/lib/db/migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL!,
    },
    verbose: true,
    strict: true,
});

