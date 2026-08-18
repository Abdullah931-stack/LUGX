import { config as dotenvConfig } from "dotenv";
import path from "node:path";

// Load .env.local first (user-configured live database & services), then .env
const ROOT = path.resolve(__dirname);
dotenvConfig({ path: path.join(ROOT, ".env.local"), override: true });
dotenvConfig({ path: path.join(ROOT, ".env"), override: false });
