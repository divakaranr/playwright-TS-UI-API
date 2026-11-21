import path from 'node:path';

import { defineConfig } from '@playwright/test';

/** Config for the nested reporting verification run (see reporting.spec.ts). */
const reportDir = process.env.REPORT_DIR!;

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /reporting\.sample\.ts$/,
  outputDir: path.join(reportDir, 'test-results'),
  retries: 0,
  workers: 1,
  use: { trace: 'on' },
  reporter: [
    ['json', { outputFile: path.join(reportDir, 'results.json') }],
    ['junit', { outputFile: path.join(reportDir, 'junit.xml') }],
    ['allure-playwright', { resultsDir: path.join(reportDir, 'allure-results') }],
    ['../../../src/core/reporting/summary.reporter.ts', { outputFile: path.join(reportDir, 'summary.json') }],
  ],
  projects: [{ name: 'sample' }],
});
