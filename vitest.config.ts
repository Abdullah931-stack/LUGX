import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { LIVE_TEST_FILES } from './vitest.live.config';

export const CLOUD_E2E_FILES = [
    'src/test/ai-live-e2e.test.ts',
];

export default defineConfig({
    test: {
        environment: 'node', setupFiles: ['./vitest.setup.ts'],
        globals: true,
        include: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.ts'],
        // Phase 10: LIVE integration suites and external cloud suites are excluded from default runner
        exclude: [...configDefaults.exclude, ...LIVE_TEST_FILES, ...CLOUD_E2E_FILES],
        // Postgres integration tests share one local database. Running test
        // files in parallel lets their setup/cleanup interfere with each
        // other (flaky failures from rows leaking between files), so files
        // are serialized into a single worker — per-test parallelism inside
        // each file is preserved by default.
        pool: 'forks',
        // @ts-expect-error -- singleFork serializes test files to protect the
        // shared local Postgres database from cross-file setup/cleanup races.
        singleFork: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/lib/ai/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
});

