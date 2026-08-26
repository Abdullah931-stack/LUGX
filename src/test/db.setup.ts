/**
 * Shared integration-test database setup.
 *
 * Supports local Postgres and live Postgres database specified in environment.
 */
import path from "node:path";
import fs from "node:fs";
import net from "node:net";

const ROOT = path.resolve(__dirname, "../..");

function getDatabaseUrl(): string {
    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }
    if (fs.existsSync(path.join(ROOT, ".env.test"))) {
        const url = fs
            .readFileSync(path.join(ROOT, ".env.test"), "utf8")
            .split("\n")
            .find((line) => line.startsWith("DATABASE_URL="))
            ?.slice("DATABASE_URL=".length)
            .trim();
        if (url) return url;
    }
    throw new Error("DATABASE_URL not found for integration tests");
}

async function isPortOpen(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
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

let ensured = false;

export async function isTestDbAvailable(): Promise<boolean> {
    try {
        const dbUrl = getDatabaseUrl();
        const parsed = new URL(dbUrl);
        const host = parsed.hostname || "127.0.0.1";
        const port = parseInt(parsed.port || "5432", 10);
        return await isPortOpen(host, port, 3000);
    } catch {
        return false;
    }
}

export async function ensureTestDb() {
    if (ensured) return;

    try {
        const dbUrl = getDatabaseUrl();
        const parsed = new URL(dbUrl);
        const host = parsed.hostname || "127.0.0.1";
        const port = parseInt(parsed.port || "5432", 10);

        const reachable = await isPortOpen(host, port, 3000);
        if (!reachable) {
            console.warn(`[ensureTestDb] Postgres DB (${host}:${port}) unreachable; skipping integration DB setup.`);
            return;
        }

        ensured = true;
    } catch (err) {
        console.warn("[ensureTestDb] Postgres DB unreachable; skipping integration DB setup.");
    }
}

export async function runMigrations() {
    await ensureTestDb();
    if (!ensured) return;

    try {
        const { testDb } = await import("./test-db");
        const { sql } = await import("drizzle-orm");

        const migrationsDir = path.join(ROOT, "src/lib/db/migrations");
        if (fs.existsSync(migrationsDir)) {
            const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
            for (const file of files) {
                const sqlContent = fs.readFileSync(path.join(migrationsDir, file), "utf8");
                if (sqlContent.trim()) {
                    await testDb.execute(sql.raw(sqlContent));
                }
            }
        }
    } catch (err) {
        console.warn("[runMigrations] Error applying migrations to test DB:", err);
    }
}
