import path from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * Configuration for REVIEWING generated drafts (generated-tests/) against any site.
 * Deliberately independent from the main config: no framework fixtures, no auth
 * setup project, no demo app – generated tests use plain @playwright/test.
 *
 *   CONSOLE_BASE_URL=https://example.com npx playwright test -c playwright.generated.config.ts generated-tests/console/<run>/
 *
 * Once a draft is reviewed, move it into tests/ and adapt it to the framework's
 * page objects and fixtures.
 */
const baseURL = process.env.CONSOLE_BASE_URL;
if (!baseURL) throw new Error('Set CONSOLE_BASE_URL to the site under test');
const reportDir = process.env.REPORT_DIR ?? path.join(import.meta.dirname, 'reports', 'generated');

export default defineConfig({
  testDir: './generated-tests',
  testMatch: /\.spec\.ts$/,
  outputDir: path.join(reportDir, 'test-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 2,
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(reportDir, 'results.json') }],
    ['html', { outputFolder: path.join(reportDir, 'html'), open: 'never' }],
  ],
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
