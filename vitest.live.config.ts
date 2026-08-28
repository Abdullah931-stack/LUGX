import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Single source of truth for LIVE integration suites — tests that require a
 * REAL environment (isolated Neon test branch, live AI keys). They run ONLY
 * via `npm run test:live`, never as part of the default `npm run test`.
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
    'src/test/ai-live-e2e.test.ts',
    // Live twins of previously fully-mocked suites (post Phase 10 follow-up):
    'src/test/ai-quota-idempotency.live.test.ts',
    'src/test/ai-server-atomic-commit.live.test.ts',
    'src/test/editor-orchestration.live.test.ts',
    'src/test/ai-preview-decision.live.test.ts',
    'src/test/ai-reservation-status.live.test.ts',
    'src/app/api/stripe/webhook/route.live.test.ts',
    'src/test/cross-user-ownership.test.ts',
];

export default defineConfig({
    test: {
        environment: 'node', setupFiles: ['./vitest.setup.ts'],
        globals: true,
        include: LIVE_TEST_FILES,
        // Fail-closed gate: verify branch identity + reachability up front.
        globalSetup: ['./vitest.live.global-setup.ts'],
        // External providers (Gemini) can legitimately take >30s under load;
        // 60s removes provider-latency flakiness without hiding real hangs.
        testTimeout: 60_000,
        // Serialized against the shared isolated branch (same rationale as
        // the default config's singleFork).
        pool: 'forks',
        // @ts-expect-error -- singleFork serializes test files.
        singleFork: true,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});
