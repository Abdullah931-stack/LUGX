import net from "node:net";
import { loadTestEnv } from "./src/test/load-test-env";
import {
    assertSafeTestDatabaseUrl,
    printTestDbIdentity,
} from "./src/test/test-db-guard";

function isPortOpen(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, host);
    });
}

/**
 * Global setup for the LIVE integration suite (`npm run test:live`).
 *
 * Fail-closed: the whole run refuses to start unless
 *  1. TEST_DATABASE_URL is configured and DATABASE_URL binds to it exactly,
 *  2. the target host is not on TEST_DB_FORBIDDEN_HOSTS,
 *  3. the isolated Neon branch is actually reachable.
 *
 * This deliberately overrides the historical silent-skip behavior of
 * `ensureTestDb()` — a live run with no database must FAIL, never "pass".
 */
export default async function globalSetup(): Promise<void> {
    // globalSetup runs in its own process BEFORE setupFiles, so it must load
    // the test environment itself.
    loadTestEnv();

    const target = assertSafeTestDatabaseUrl({
        databaseUrl: process.env.DATABASE_URL,
        testDatabaseUrl: process.env.TEST_DATABASE_URL,
        forbiddenHosts: process.env.TEST_DB_FORBIDDEN_HOSTS,
    });
    printTestDbIdentity(target);

    const parsed = new URL(process.env.TEST_DATABASE_URL!);
    const host = parsed.hostname;
    const port = Number(parsed.port || 5432);
    if (!(await isPortOpen(host, port))) {
        throw new Error(
            `[test:live] Isolated test branch ${host}:${port} is unreachable. ` +
                "Refusing to run live suites against nothing — check the " +
                "branch exists and TEST_DATABASE_URL is correct."
        );
    }
    console.log(
        `[test:live] Isolated test branch ${host}:${port} reachable — starting live suites.`
    );
}
