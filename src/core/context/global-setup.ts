import { rmSync } from 'node:fs';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';

import { getConfig } from '../../config/index.js';
import { writeJsonFileAtomic } from '../../utils/file.util.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Runs once before all tests:
 *  - validates configuration (fail fast before any browser starts)
 *  - records run metadata (environment, projects, versions) for reporting
 *  - logs prominent warnings for read-only environments
 * Authentication is NOT done here; it lives in the `setup` project so it is
 * traced, reported and retried like any other test.
 */
export default function globalSetup(config: FullConfig): void {
  const frameworkConfig = getConfig();
  const logger = getLogger();
  const { environment } = frameworkConfig;

  const metadata = {
    environment: environment.name,
    baseUrl: environment.baseUrl,
    apiBaseUrl: environment.apiBaseUrl,
    readOnly: environment.readOnly,
    projects: config.projects.map((p) => p.name),
    workers: config.workers,
    shard: config.shard,
    playwrightVersion: config.version,
    node: process.version,
    ci: frameworkConfig.execution.ci,
    startedAt: new Date().toISOString(),
  };
  const reportDir = process.env.REPORT_DIR ?? path.join(config.rootDir, 'reports');
  // allure-playwright appends results; clear stale ones so each report reflects one run.
  rmSync(path.join(reportDir, 'allure-results'), { recursive: true, force: true });
  writeJsonFileAtomic(path.join(reportDir, 'run-metadata.json'), metadata);

  if (environment.readOnly) {
    logger.warn(
      { environment: environment.name },
      'READ-ONLY environment: only @prod-safe tests will run; writes are blocked',
    );
  }
  logger.info(metadata, 'test run starting');
}
