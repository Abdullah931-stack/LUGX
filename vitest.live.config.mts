import { defineConfig } from 'vitest/config';
import path from 'path';
import { LIVE_TEST_FILES, CLOUD_E2E_FILES } from './vitest.constants.mjs';

const isCloudSmoke = process.env.CLOUD_SMOKE === 'true' || process.argv.some((arg) => arg.includes('ai-live-e2e'));

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        globals: true,
        include: isCloudSmoke ? CLOUD_E2E_FILES : LIVE_TEST_FILES,
        // Fail-closed gate: verify branch identity + reachability up front for db integration, bypassed for pure cloud AI smoke.
        globalSetup: isCloudSmoke ? [] : ['./vitest.live.global-setup.ts'],
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
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
});
