/**
 * Single source of truth for Vitest test file categories and partitioning.
 *
 * Separating file arrays here prevents [MIXED_EXPORTS] warnings in configuration
 * entry points (vitest.config.ts and vitest.live.config.ts) by keeping config
 * files strictly default-exported.
 */

/**
 * LIVE integration suites that require a real environment (isolated Neon test branch,
 * live AI keys, Upstash Redis). They run ONLY via `npm run test:live`, never in default `npm run test`.
 */
export const LIVE_TEST_FILES = [
    'src/app/api/files/[id]/route.putguard.test.ts',
    'src/server/actions/ai-ops.integrity.test.ts',
    'src/server/actions/ai-ops.refund.test.ts',
    'src/server/actions/file-ops.lostupdate.test.ts',
    'src/server/actions/file-ops.ownership.test.ts',
    'src/server/actions/file-ops.softdelete.test.ts',
    'src/test/ai-atomic-commit.integration.test.ts',
    'src/test/conflict-resolution.integration.test.ts',
    // Live twins of previously fully-mocked suites:
    'src/test/ai-quota-idempotency.live.test.ts',
    'src/test/ai-server-atomic-commit.live.test.ts',
    'src/test/editor-orchestration.live.test.ts',
    'src/test/ai-preview-decision.live.test.ts',
    'src/test/ai-reservation-status.live.test.ts',
    'src/app/api/stripe/webhook/route.live.test.ts',
    'src/test/cross-user-ownership.test.ts',
];

/**
 * Cloud E2E test suites gated to specific provider smoke runs.
 */
export const CLOUD_E2E_FILES = [
    'src/test/ai-live-e2e.test.ts',
];
