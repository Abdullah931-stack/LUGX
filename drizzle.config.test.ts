import { defineConfig } from "drizzle-kit";
import { config as dotenvConfig } from "dotenv";
import path from "node:path";

// Phase 10: point schema pushes at the isolated Neon TEST branch.
// Priority mirrors vitest.setup.ts: .env.test.local > .env.test.
// Usage: npx drizzle-kit push --config drizzle.config.test.ts
dotenvConfig({
    path: path.resolve(process.cwd(), ".env.test.local"),
    override: true,
});
dotenvConfig({ path: path.resolve(process.cwd(), ".env.test"), override: false });

export default defineConfig({
    schema: "./src/lib/db/schema.ts",
    out: "./drizzle/migrations-test",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
    },
    strict: true,
});

