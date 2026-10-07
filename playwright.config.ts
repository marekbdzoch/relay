import { defineConfig } from '@playwright/test';
import { OWNER_STATE } from './e2e/support/users';

const PORT = 3123;

export default defineConfig({
  testDir: 'e2e',
  // one server + one database shared by all tests
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'en-US',
    timezoneId: 'Europe/Prague',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      // first-run setup through the UI, then the shared test accounts
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: OWNER_STATE, viewport: { width: 1360, height: 860 } },
    },
  ],
  webServer: {
    // The client is built into a private folder (e2e/.web-dist): other people rebuilding web/dist while
    // the suite runs would otherwise delete the hashed assets the running server's index.html points to.
    command: 'npm -w web run build -- --outDir ../e2e/.web-dist --emptyOutDir && node e2e/start-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
