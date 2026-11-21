import type { TestInfo } from '@playwright/test';

import { correlationId } from '../../utils/random.util.js';

/** Per-test execution metadata shared by logging, API clients and diagnostics. */
export interface TestContext {
  readonly testId: string;
  readonly title: string;
  readonly file: string;
  readonly project: string;
  readonly environment: string;
  readonly retry: number;
  readonly workerIndex: number;
  readonly tags: readonly string[];
  /** Correlates logs, API calls (X-Correlation-Id prefix) and artifacts for this test. */
  readonly correlationId: string;
  readonly startedAt: string;
}

export function createTestContext(testInfo: TestInfo, environment: string): TestContext {
  return {
    testId: testInfo.testId,
    title: testInfo.titlePath.slice(1).join(' > '),
    file: testInfo.file,
    project: testInfo.project.name,
    environment,
    retry: testInfo.retry,
    workerIndex: testInfo.workerIndex,
    tags: testInfo.tags,
    correlationId: correlationId(),
    startedAt: new Date().toISOString(),
  };
}
