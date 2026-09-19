import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

// Load isolated test environment in strict priority order (matches src/test/load-test-env.ts)
dotenv.config({ path: path.resolve(process.cwd(), '.env.test.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.test') });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
    throw new Error(
        '[Playwright Config] TEST_DATABASE_URL is not set. Refusing to run tests against undefined database.'
    );
}

// Safety check: ensure TEST_DATABASE_URL does not point to forbidden production hosts
const forbiddenHosts = (process.env.TEST_DB_FORBIDDEN_HOSTS || 'ep-lucky-star-b1vlsh1f-pooler.c-5.eu-central-1.aws.neon.tech,ep-lucky-star-b1vlsh1f.c-5.eu-central-1.aws.neon.tech')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

for (const forbidden of forbiddenHosts) {
    if (testDbUrl.includes(forbidden)) {
        throw new Error(
            `[Playwright Config Guard] TEST_DATABASE_URL contains forbidden production host: ${forbidden}. Execution halted to protect production data.`
        );
    }
}

const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
    testDir: './e2e/specs',
    fullyParallel: false, // Single worker to prevent concurrent database mutation races on shared test branch
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0, // Zero flakiness tolerance
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ],
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: `npx next dev --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: false,
        timeout: 120000,
        env: {
            ...process.env,
            PORT: String(PORT),
            DATABASE_URL: testDbUrl,
            TEST_DATABASE_URL: testDbUrl,
            NEXT_PUBLIC_APP_URL: BASE_URL,
            NODE_ENV: 'test',
            PLAYWRIGHT: '1',
        },
    },
});
