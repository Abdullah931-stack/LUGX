/**
 * Unit tests for the Phase 10 test-database isolation guards.
 * Pure modules only — no real database connection is made here.
 *
 * Covered closure criteria (roadmap Phase 10):
 *  - The guard REFUSES a deliberate production/main-branch connection string.
 *  - The guard fails fast when TEST_DATABASE_URL is missing (esp. in CI).
 *  - vitest.setup.ts env loading cannot leak a production DATABASE_URL into
 *    the test environment when TEST_DATABASE_URL is declared.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assertSafeTestDatabaseUrl,
    extractDbHost,
    extractNeonEndpointId,
} from "@/test/test-db-guard";
import { loadTestEnv } from "@/test/load-test-env";

const MAIN_BRANCH_URL =
    "postgresql://prod_user:secret@ep-main-branch-000000.us-east-2.aws.neon.tech/neondb?sslmode=require";
const TEST_BRANCH_URL =
    "postgresql://test_user:secret@ep-test-branch-111111.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("test-db-guard", () => {
    it("extracts host and endpoint id from a Neon connection string", () => {
        const host = extractDbHost(TEST_BRANCH_URL);
        expect(host).toBe("ep-test-branch-111111.us-east-2.aws.neon.tech");
        expect(extractNeonEndpointId(host)).toBe("ep-test-branch-111111");
        expect(extractNeonEndpointId(null)).toBeNull();
        expect(extractDbHost("not-a-url")).toBeNull();
    });

    it("accepts the designated isolated test branch and reports its identity", () => {
        const target = assertSafeTestDatabaseUrl({
            databaseUrl: TEST_BRANCH_URL,
            testDatabaseUrl: TEST_BRANCH_URL,
            ci: false,
        });
        expect(target.endpointId).toBe("ep-test-branch-111111");
    });

    it("REFUSES the production main branch passed deliberately as the test URL", () => {
        expect(() =>
            assertSafeTestDatabaseUrl({
                databaseUrl: MAIN_BRANCH_URL,
                testDatabaseUrl: MAIN_BRANCH_URL,
                forbiddenHosts: "ep-main-branch-000000.us-east-2.aws.neon.tech",
                ci: false,
            })
        ).toThrow(/forbidden|TEST_DB_FORBIDDEN_HOSTS/i);
    });

    it("REFUSES production main branch when connection string uses pooled endpoint (-pooler)", () => {
        const POOLED_MAIN_URL =
            "postgresql://prod_user:secret@ep-main-branch-000000-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
        expect(() =>
            assertSafeTestDatabaseUrl({
                databaseUrl: POOLED_MAIN_URL,
                testDatabaseUrl: POOLED_MAIN_URL,
                forbiddenHosts: "ep-main-branch-000000.us-east-2.aws.neon.tech",
                ci: false,
            })
        ).toThrow(/forbidden|TEST_DB_FORBIDDEN_HOSTS/i);
    });

    it("REFUSES when effective DATABASE_URL differs from TEST_DATABASE_URL", () => {
        expect(() =>
            assertSafeTestDatabaseUrl({
                databaseUrl: MAIN_BRANCH_URL,
                testDatabaseUrl: TEST_BRANCH_URL,
                ci: false,
            })
        ).toThrow(/must run ONLY on the test branch/i);
    });

    it("fails fast when TEST_DATABASE_URL is missing — explicitly in CI", () => {
        expect(() =>
            assertSafeTestDatabaseUrl({
                databaseUrl: TEST_BRANCH_URL,
                testDatabaseUrl: undefined,
                ci: true,
            })
        ).toThrow(/CI runs REQUIRE/i);

        // Fail-closed locally too: without TEST_DATABASE_URL there is no
        // guarantee the target is not the production main branch.
        expect(() =>
            assertSafeTestDatabaseUrl({
                databaseUrl: MAIN_BRANCH_URL,
                testDatabaseUrl: undefined,
                ci: false,
            })
        ).toThrow(/TEST_DATABASE_URL is not configured/i);
    });
});

describe("loadTestEnv (vitest.setup.ts logic)", () => {
    let saved: Record<string, string | undefined>;
    let tmpDir: string;

    function writeEnvFile(name: string, contents: string): void {
        fs.writeFileSync(path.join(tmpDir, name), contents, "utf8");
    }

    afterEach(() => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("binds DATABASE_URL to the isolated test branch and never leaks the app DATABASE_URL", () => {
        saved = {
            DATABASE_URL: process.env.DATABASE_URL,
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        };
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lugx-env-test-"));

        // Simulated hostile layout: .env.local holds the PRODUCTION url.
        writeEnvFile(
            ".env.test.local",
            `TEST_DATABASE_URL=${TEST_BRANCH_URL}\n`
        );
        writeEnvFile(".env.test", "DATABASE_URL=ignored\n");
        writeEnvFile(`.env.local`, `DATABASE_URL=${MAIN_BRANCH_URL}\n`);

        loadTestEnv(tmpDir);

        expect(process.env.TEST_DATABASE_URL).toBe(TEST_BRANCH_URL);
        // Closure criterion: the production URL must NEVER survive loading.
        expect(process.env.DATABASE_URL).toBe(TEST_BRANCH_URL);
        expect(process.env.DATABASE_URL).not.toBe(MAIN_BRANCH_URL);
    });

    it("shell-exported TEST_DATABASE_URL wins over dotenv files (CI safety)", () => {
        saved = {
            DATABASE_URL: process.env.DATABASE_URL,
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
        };
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lugx-env-test-"));
        writeEnvFile(
            ".env.test.local",
            `TEST_DATABASE_URL=postgresql://file@file-host.neon.tech/db\n`
        );

        const shellUrl =
            "postgresql://ci@ci-host.neon.tech/ci?sslmode=require";
        try {
            // Inject the simulated shell value explicitly (the module-level
            // capture already happened when vitest.setup ran for this process).
            loadTestEnv(tmpDir, shellUrl);
            expect(process.env.TEST_DATABASE_URL).toBe(shellUrl);
            expect(process.env.DATABASE_URL).toBe(shellUrl);
        } finally {
            delete process.env.TEST_DATABASE_URL;
        }
    });
});
