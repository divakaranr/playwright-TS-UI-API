import path from 'node:path';

import { defineConfig, type ReporterDescription } from '@playwright/test';

import { buildProjects } from './src/config/browser.config.js';
import { getConfig } from './src/config/index.js';

/**
 * Playwright configuration. All values derive from the validated framework
 * configuration (config/environments/<TEST_ENV>.json + environment variables),
 * so an invalid setup fails here, before any test starts.
 */
const config = getConfig();
const { environment, execution } = config;

const reportDir = process.env.REPORT_DIR ?? path.join(import.meta.dirname, 'reports');
const isCI = execution.ci;

const reporters: ReporterDescription[] = [
  [isCI ? 'dot' : 'list'],
  ['html', { outputFolder: path.join(reportDir, 'html'), open: 'never' }],
  ['json', { outputFile: path.join(reportDir, 'results.json') }],
  ['junit', { outputFile: path.join(reportDir, 'junit.xml') }],
  [
    'allure-playwright',
    {
      resultsDir: path.join(reportDir, 'allure-results'),
      environmentInfo: {
        environment: environment.name,
        baseUrl: environment.baseUrl,
        node: process.version,
        os: process.platform,
      },
    },
  ],
  ['./src/core/reporting/summary.reporter.ts', { outputFile: path.join(reportDir, 'summary.json') }],
];
// Sharded CI jobs emit blob reports that are merged afterwards (npm run reports:merge).
if (process.env.PW_BLOB_REPORT === 'true')
  reporters.push(['blob', { outputDir: path.join(reportDir, 'blob') }]);

const demoAppPort = new URL(environment.baseUrl).port || '4000';

export default defineConfig({
  testDir: './tests',
  outputDir: process.env.PW_OUTPUT_DIR ?? './test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: execution.retries,
  ...(execution.workers !== undefined ? { workers: execution.workers } : isCI ? { workers: 2 } : {}),
  timeout: environment.timeouts.testMs,
  expect: { timeout: environment.timeouts.expectMs },
  reporter: reporters,
  globalSetup: './src/core/context/global-setup.ts',
  globalTeardown: './src/core/context/global-teardown.ts',
  metadata: { environment: environment.name, baseUrl: environment.baseUrl },

  use: {
    baseURL: environment.baseUrl,
    headless: execution.headless,
    actionTimeout: environment.timeouts.actionMs,
    navigationTimeout: environment.timeouts.navigationMs,
    testIdAttribute: 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: buildProjects(config),

  // The bundled demo app is started only for environments that request it (local).
  ...(environment.features.startDemoApp
    ? {
        webServer: {
          command: 'npx tsx demo-app/server.ts',
          url: `${environment.apiBaseUrl}/health`,
          // Runs triggered by automation (MCP) reuse an already running app instead of failing on the port.
          reuseExistingServer: !isCI || process.env.PW_REUSE_SERVER === 'true',
          timeout: 60_000,
          stdout: 'ignore',
          stderr: 'pipe',
          env: { DEMO_APP_PORT: demoAppPort },
        },
      }
    : {}),
});
