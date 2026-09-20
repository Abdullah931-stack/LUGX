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
    'src/test/api/api-files-putguard.live.test.ts',
    'src/test/ai/ai-ops.integrity.test.ts',
    'src/test/ai/ai-ops.refund.test.ts',
    'src/test/server/file-ops.lostupdate.test.ts',
    'src/test/server/file-ops.ownership.test.ts',
    'src/test/server/file-ops.softdelete.test.ts',
    'src/test/ai/ai-atomic-commit.integration.test.ts',
    'src/test/sync/conflict-resolution.integration.test.ts',
    // Live twins of previously fully-mocked suites:
    'src/test/ai/ai-quota-idempotency.live.test.ts',
    'src/test/ai/ai-server-atomic-commit.live.test.ts',
    'src/test/editor/editor-orchestration.live.test.ts',
    'src/test/ai/ai-preview-decision.live.test.ts',
    'src/test/ai/ai-reservation-status.live.test.ts',
    'src/test/api/stripe-webhook.live.test.ts',
    'src/test/server/cross-user-ownership.test.ts',
    'src/test/infrastructure/cron-expire-reservations.live.test.ts',
    'src/test/vault/vault-sync.live.test.ts',
    'src/test/server/document-pipeline.live.test.ts',
    'src/test/infrastructure/multi-system-lifecycle.live.test.ts',
];

/**
 * Cloud E2E test suites gated to specific provider smoke runs.
 */
export const CLOUD_E2E_FILES = [
    'src/test/ai/ai-live-e2e.test.ts',
];
