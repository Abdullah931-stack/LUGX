import { loadTestEnv } from "./src/test/load-test-env";

// Phase 10 (Neon Branch isolation): load the isolated test-branch environment
// BEFORE any test module — and its database pool — is imported.
// Priority: shell TEST_DATABASE_URL > .env.test.local > .env.test > .env.local > .env
// Then DATABASE_URL is hard-bound to TEST_DATABASE_URL (fail-closed binding).
loadTestEnv();

