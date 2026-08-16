import { config as dotenvConfig } from "dotenv";
import path from "node:path";

// Load .env first, then override with .env.test (test-specific values
// such as the local Postgres DATABASE_URL).
const ROOT = path.resolve(__dirname);
dotenvConfig({ path: path.join(ROOT, ".env"), override: false });
dotenvConfig({ path: path.join(ROOT, ".env.test"), override: true });
