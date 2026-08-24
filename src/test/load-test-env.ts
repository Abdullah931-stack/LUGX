/**
 * Test environment loader (Phase 10 — Neon Branch isolation).
 *
 * Priority order (highest first):
 *   1. Shell-exported TEST_DATABASE_URL (CI injects the branch URL here;
 *      dotenv files must never clobber it).
 *   2. `.env.test.local` — developer-local isolated Neon branch URL
 *      (git-ignored via the `.env*` pattern).
 *   3. `.env.test`       — tracked non-secret defaults.
 *   4. `.env.local`      — app runtime configuration (lowest precedence for
 *      tests; never allowed to win over the test branch).
 *   5. `.env`
 *
 * After loading, `DATABASE_URL` is hard-bound to `TEST_DATABASE_URL`, so every
 * Postgres consumer inside the vitest process (test-db.ts pools, server
 * actions, API routes under test) resolves to the isolated Neon test branch
 * and can never leak writes onto the production main branch.
 */
import { config as dotenvConfig } from "dotenv";
import path from "node:path";

// Captured at MODULE LOAD time — i.e. before this loader ever runs — so it
// reflects the true CI/shell-provided value and is immune to repeated
// invocations within one process (e.g. unit tests loading other roots).
const MODULE_LOAD_TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export function loadTestEnv(
    rootDir: string = process.cwd(),
    // Injectable for deterministic unit tests; defaults to the true shell value.
    shellTestDatabaseUrl: string | undefined = MODULE_LOAD_TEST_DATABASE_URL
): void {
    dotenvConfig({
        path: path.join(rootDir, ".env.test.local"),
        override: true,
    });
    dotenvConfig({ path: path.join(rootDir, ".env.test"), override: false });
    dotenvConfig({ path: path.join(rootDir, ".env.local"), override: false });
    dotenvConfig({ path: path.join(rootDir, ".env"), override: false });

    if (shellTestDatabaseUrl) {
        process.env.TEST_DATABASE_URL = shellTestDatabaseUrl;
    }

    const testUrl = process.env.TEST_DATABASE_URL;
    if (testUrl) {
        // Binding contract: the vitest DATABASE_URL IS the test branch URL.
        process.env.DATABASE_URL = testUrl;
    }
}
