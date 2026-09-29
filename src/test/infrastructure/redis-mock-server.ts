import http from "node:http";
import type { Socket } from "node:net";

export interface MockServerOptions {
    port?: number;
    host?: string;
}

/**
 * Lightweight, in-memory Upstash HTTP REST protocol emulator.
 *
 * Emulates the Upstash Redis REST wire protocol:
 * - Handles `/pipeline` batched array commands and root `/` single command requests.
 * - Complies with `Upstash-Encoding: base64` header contract.
 * - Implements atomic `SET ... NX EX`, `GET`, and `DEL` semantics.
 * - Provides programmable latency (`setDelay`) for testing upstream timeout degradation.
 */
export class UpstashHttpMockServer {
    private store = new Map<string, string>();
    private ttls = new Map<string, number>();
    private delayMs = 0;
    private server: http.Server;
    private sockets = new Set<Socket>();
    public url = "";
    public port = 0;

    constructor() {
        this.server = http.createServer((req, res) => {
            void this.handleRequest(req, res);
        });

        this.server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.on("close", () => {
                this.sockets.delete(socket);
            });
        });
    }

    /**
     * Boots the HTTP server on a free port.
     */
    public start(options: MockServerOptions = {}): Promise<string> {
        return new Promise((resolve, reject) => {
            const host = options.host || "127.0.0.1";
            const port = options.port || 0;

            this.server.listen(port, host, () => {
                const address = this.server.address();
                if (address && typeof address === "object") {
                    this.port = address.port;
                    this.url = `http://${host}:${this.port}`;
                    resolve(this.url);
                } else {
                    reject(new Error("Failed to bind mock HTTP server address"));
                }
            });

            this.server.once("error", reject);
        });
    }

    /**
     * Forcefully terminates all sockets and stops the HTTP server.
     */
    public stop(): Promise<void> {
        return new Promise((resolve) => {
            for (const socket of this.sockets) {
                socket.destroy();
            }
            this.sockets.clear();
            this.server.close(() => {
                resolve();
            });
        });
    }

    /**
     * Clears in-memory keys, TTLs, and resets simulated latency.
     */
    public clear(): void {
        this.store.clear();
        this.ttls.clear();
        this.delayMs = 0;
    }

    /**
     * Configures simulated network delay in milliseconds.
     */
    public setDelay(ms: number): void {
        this.delayMs = ms;
    }

    /**
     * Returns true if the key currently exists and is unexpired.
     */
    public has(key: string): boolean {
        this.evictIfExpired(key);
        return this.store.has(key);
    }

    /**
     * Returns the raw unencoded stored value for a key, or null if missing/expired.
     */
    public getRaw(key: string): string | null {
        this.evictIfExpired(key);
        return this.store.get(key) ?? null;
    }

    private evictIfExpired(key: string): void {
        const expiresAt = this.ttls.get(key);
        if (expiresAt !== undefined && expiresAt <= Date.now()) {
            this.store.delete(key);
            this.ttls.delete(key);
        }
    }

    private executeCommand(cmd: unknown[]): unknown {
        if (!Array.isArray(cmd) || cmd.length === 0) {
            return null;
        }

        const name = String(cmd[0]).toLowerCase();
        const args = cmd.slice(1);
        const now = Date.now();

        switch (name) {
            case "get": {
                const key = String(args[0]);
                this.evictIfExpired(key);
                return this.store.has(key) ? this.store.get(key) : null;
            }

            case "set": {
                const key = String(args[0]);
                const rawVal = args[1];
                const opts = args.slice(2);

                let nx = false;
                let exSeconds: number | undefined;

                for (let i = 0; i < opts.length; i++) {
                    const opt = String(opts[i]).toLowerCase();
                    if (opt === "nx") {
                        nx = true;
                    } else if (opt === "ex" && i + 1 < opts.length) {
                        exSeconds = Number(opts[i + 1]);
                        i++;
                    }
                }

                this.evictIfExpired(key);

                if (nx && this.store.has(key)) {
                    return null;
                }

                const stringified =
                    typeof rawVal === "string"
                        ? rawVal
                        : typeof rawVal === "object" && rawVal !== null
                        ? JSON.stringify(rawVal)
                        : String(rawVal ?? "");

                this.store.set(key, stringified);

                if (exSeconds !== undefined && !Number.isNaN(exSeconds)) {
                    this.ttls.set(key, now + exSeconds * 1000);
                } else {
                    this.ttls.delete(key);
                }

                return "OK";
            }

            case "del": {
                let deletedCount = 0;
                for (const arg of args) {
                    const key = String(arg);
                    if (this.store.delete(key)) {
                        deletedCount++;
                    }
                    this.ttls.delete(key);
                }
                return deletedCount;
            }

            // Fallback stubs for sliding-window rate limiters if triggered
            case "zremrangebyscore":
                return 0;
            case "zcard":
                return 0;
            case "zadd":
                return 1;
            case "expire":
                return 1;

            default:
                return "OK";
        }
    }

    private encodeResult(val: unknown, encoding?: string): unknown {
        if (val === null || val === undefined || val === "OK" || typeof val === "number") {
            return val;
        }
        if (encoding === "base64" && typeof val === "string") {
            return Buffer.from(val).toString("base64");
        }
        return val;
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (this.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));

        req.on("end", () => {
            const rawBody = Buffer.concat(chunks).toString("utf8");
            const encoding = req.headers["upstash-encoding"] as string | undefined;

            res.setHeader("Content-Type", "application/json");

            try {
                const parsed = rawBody ? JSON.parse(rawBody) : [];
                const pathname = req.url ? req.url.split("?")[0] : "/";
                if (pathname === "/pipeline") {
                    const pipelineCmds = Array.isArray(parsed) ? parsed : [];
                    const results = pipelineCmds.map((cmd) => {
                        const raw = this.executeCommand(Array.isArray(cmd) ? cmd : []);
                        return { result: this.encodeResult(raw, encoding) };
                    });
                    res.statusCode = 200;
                    res.end(JSON.stringify(results));
                } else {
                    const cmd = Array.isArray(parsed) ? parsed : [];
                    const raw = this.executeCommand(cmd);
                    res.statusCode = 200;
                    res.end(JSON.stringify({ result: this.encodeResult(raw, encoding) }));
                }
            } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
            }
        });
    }
}
