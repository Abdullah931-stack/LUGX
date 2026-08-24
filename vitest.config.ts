import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { LIVE_TEST_FILES } from './vitest.live.config';

export default defineConfig({
    test: {
        environment: 'node', setupFiles: ['./vitest.setup.ts'],
        globals: true,
        include: ['src/**/*.test.ts'],
        // Phase 10: LIVE integration suites (real Neon branch / live AI keys)
        // are excluded here and run exclusively via `npm run test:live`.
        exclude: [...configDefaults.exclude, ...LIVE_TEST_FILES],
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

