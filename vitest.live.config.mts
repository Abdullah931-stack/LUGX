import { defineConfig } from 'vitest/config';
import path from 'path';
import { LIVE_TEST_FILES } from './vitest.constants.mjs';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
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
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
});
