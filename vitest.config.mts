import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';
import { LIVE_TEST_FILES, CLOUD_E2E_FILES } from './vitest.constants.mjs';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./vitest.setup.ts'],
        globals: true,
        testTimeout: 15_000,
        include: ['src/**/*.test.{ts,tsx}', 'src/**/*.test.ts'],
        // Phase 10: LIVE integration suites and external cloud suites are excluded from default runner
        exclude: [...configDefaults.exclude, ...LIVE_TEST_FILES, ...CLOUD_E2E_FILES],
        // Pure unit and contract tests are completely hermetic (zero DB / network).
        // Each test file runs in an isolated fork worker, preventing V8 heap
        // accumulation and environment switching segfaults across mixed jsdom/node suites.
        pool: 'forks',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/lib/ai/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, './src'),
        },
    },
});
