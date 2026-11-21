import { devices, type PlaywrightTestConfig } from '@playwright/test';

import type { FrameworkConfig } from './config.schema.js';

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];

/** Tests that need a real browser. */
const BROWSER_TEST_MATCH = [/tests[\\/](ui|e2e|integration)[\\/].*\.spec\.ts$/];

/**
 * Builds the Playwright project matrix. Projects are the only mechanism used for
 * browser/device selection – there is no custom parallel runner.
 */
export function buildProjects(config: FrameworkConfig): Project[] {
  const browserDependencies = ['setup'];

  const projects: Project[] = [
    {
      name: 'setup',
      testMatch: /tests[\\/]fixtures[\\/].*\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'framework-unit',
      testMatch: /tests[\\/]framework[\\/]unit[\\/].*\.spec\.ts$/,
    },
    {
      name: 'framework-integration',
      testMatch: /tests[\\/]framework[\\/]integration[\\/].*\.spec\.ts$/,
    },
    {
      name: 'api',
      testMatch: /tests[\\/]api[\\/].*\.spec\.ts$/,
    },
    {
      name: 'chromium',
      testMatch: BROWSER_TEST_MATCH,
      dependencies: browserDependencies,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: BROWSER_TEST_MATCH,
      dependencies: browserDependencies,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: BROWSER_TEST_MATCH,
      dependencies: browserDependencies,
      use: { ...devices['Desktop Safari'] },
    },
  ];

  if (config.execution.mobile) {
    projects.push(
      {
        name: 'mobile-chrome',
        testMatch: BROWSER_TEST_MATCH,
        grep: /@mobile/,
        dependencies: browserDependencies,
        use: { ...devices['Pixel 7'] },
      },
      {
        name: 'mobile-safari',
        testMatch: BROWSER_TEST_MATCH,
        grep: /@mobile/,
        dependencies: browserDependencies,
        use: { ...devices['iPhone 15'] },
      },
    );
  }
  return projects;
}
