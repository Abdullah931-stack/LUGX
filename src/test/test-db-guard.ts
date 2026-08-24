/**
 * Fail-closed guard for the integration-test database connection
 * (Phase 10 — Neon Branch isolation).
 *
 * Guarantees enforced BEFORE any pg Pool is created:
 *   - `TEST_DATABASE_URL` must be configured; otherwise booting is refused
 *     (mandatory in CI, mandatory locally too — the previous incident in
 *     `docs/records/test-database-safety.md` happened without such a gate).
 *   - The effective `DATABASE_URL` must be EXACTLY the designated
 *     `TEST_DATABASE_URL`; any other target is refused.
 *   - Hosts listed in `TEST_DB_FORBIDDEN_HOSTS` (comma-separated) are rejected
 *     even if someone pastes the production/main-branch URL into
 *     `TEST_DATABASE_URL` by mistake.
 *
 * This module is intentionally PURE (no pg imports, no side effects) so the
 * guard itself is unit-testable without touching any database.
 */

export interface GuardContext {
    /** Effective DATABASE_URL the test process would connect with. */
    databaseUrl?: string | null;
    /** Designated isolated Neon test-branch connection string. */
    testDatabaseUrl?: string | null;
    /** Optional comma-separated denylist of hosts that must never be used. */
    forbiddenHosts?: string | null;
    /** CI flag; defaults to `process.env.CI` when omitted. */
    ci?: boolean;
}

export interface ResolvedTestDbTarget {
    /** Lowercased hostname of the connection string (e.g. ep-x-123.aws.neon.tech). */
    host: string;
    /** First DNS label of the host — Neon endpoint id (e.g. "ep-x-123"). */
    endpointId: string;
}

function detectCiFlag(ci?: boolean): boolean {
    if (typeof ci === "boolean") return ci;
    const raw = String(process.env.CI ?? "").toLowerCase();
    return raw === "true" || raw === "1";
}

/** Returns the lowercased hostname of a postgres URL, or null when unparseable. */
export function extractDbHost(dbUrl: string): string | null {
    try {
        const parsed = new URL(dbUrl);
        return parsed.hostname.toLowerCase() || null;
    } catch {
        return null;
    }
}

/** Endpoint id = first DNS label of a Neon host (e.g. "ep-cool-name-123456"). */
export function extractNeonEndpointId(host: string | null): string | null {
    if (!host) return null;
    return host.split(".")[0] || null;
}

/**
 * Validates that the given DATABASE_URL is safe for test execution and
 * returns the resolved branch identity. Throws (fail-closed) otherwise.
 */
export function assertSafeTestDatabaseUrl(
    ctx: GuardContext
): ResolvedTestDbTarget {
    const dbUrl = (ctx.databaseUrl ?? "").trim();
    const testUrl = (ctx.testDatabaseUrl ?? "").trim();
    const ci = detectCiFlag(ctx.ci);

    if (!dbUrl) {
        throw new Error(
            "[test-db] Refusing to boot: DATABASE_URL is empty. " +
                "Configure TEST_DATABASE_URL in .env.test.local."
        );
    }

    if (!testUrl) {
        throw new Error(
            "[test-db] Refusing to boot: TEST_DATABASE_URL is not configured. " +
                (ci
                    ? "CI runs REQUIRE the isolated Neon test branch."
                    : "Create a Neon test branch and put its URL in " +
                      ".env.test.local as TEST_DATABASE_URL.")
        );
    }

    const dbHost = extractDbHost(dbUrl);
    const testHost = extractDbHost(testUrl);
    if (!dbHost || !testHost) {
        throw new Error(
            "[test-db] Refusing to boot: DATABASE_URL / TEST_DATABASE_URL " +
                "is not a parseable postgres connection string."
        );
    }

    if (dbUrl !== testUrl) {
        throw new Error(
            `[test-db] Refusing to boot: effective DATABASE_URL points at ` +
                `'${dbHost}' but the designated isolated test branch is ` +
                `'${testHost}'. Tests must run ONLY on the test branch.`
        );
    }

    const forbidden = (ctx.forbiddenHosts ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    if (forbidden.includes(dbHost)) {
        throw new Error(
            `[test-db] Refusing to boot: '${dbHost}' matches ` +
                "TEST_DB_FORBIDDEN_HOSTS (the production main branch was " +
                "passed as the test branch)."
        );
    }

    return { host: dbHost, endpointId: extractNeonEndpointId(dbHost) ?? "" };
}

/**
 * Prints the resolved branch identity. Phase 10 makes this line a MANDATORY
 * part of every phase-closure report.
 */
export function printTestDbIdentity(target: ResolvedTestDbTarget): void {
    console.log(
        `[test-db] Isolated test branch identity — endpointId: ` +
            `'${target.endpointId}' host: '${target.host}'`
    );
}
