import path from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { formatDuration } from '../../utils/date.util.js';
import { writeJsonFileAtomic } from '../../utils/file.util.js';
import { maskSensitiveText, truncate } from '../../utils/sanitizer.js';

export interface RunSummary {
  environment: string;
  status: FullResult['status'];
  startedAt: string;
  durationMs: number;
  totals: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    timedOut: number;
    interrupted: number;
  };
  projects: Record<string, { passed: number; failed: number; skipped: number; flaky: number }>;
  failures: Array<{ title: string; project: string; file: string; error: string; retries: number }>;
  flakyTests: Array<{ title: string; project: string; retries: number }>;
  slowestTests: Array<{ title: string; project: string; durationMs: number }>;
}

/**
 * Lightweight custom reporter producing `reports/summary.json` – a stable,
 * compact contract consumed by CI dashboards, the MCP `get_test_results` tool
 * and AI failure analysis. Complements (does not replace) HTML/Allure/JUnit.
 */
export default class SummaryReporter implements Reporter {
  private readonly outputFile: string;
  private startedAt = new Date();
  private readonly finalResults = new Map<TestCase, TestResult>();

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile =
      options.outputFile ??
      path.join(process.env.REPORT_DIR ?? path.join(process.cwd(), 'reports'), 'summary.json');
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startedAt = new Date();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Keep only the last attempt; test.outcome() accounts for retries.
    this.finalResults.set(test, result);
  }

  onEnd(result: FullResult): void {
    const summary: RunSummary = {
      environment: process.env.TEST_ENV ?? 'local',
      status: result.status,
      startedAt: this.startedAt.toISOString(),
      durationMs: Math.round(result.duration),
      totals: { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, timedOut: 0, interrupted: 0 },
      projects: {},
      failures: [],
      flakyTests: [],
      slowestTests: [],
    };

    for (const [test, last] of this.finalResults) {
      const project = test.parent.project()?.name ?? 'unknown';
      const title = test.titlePath().slice(3).join(' > ') || test.title;
      const bucket = (summary.projects[project] ??= { passed: 0, failed: 0, skipped: 0, flaky: 0 });
      summary.totals.total += 1;
      if (last.status === 'timedOut') summary.totals.timedOut += 1;
      if (last.status === 'interrupted') summary.totals.interrupted += 1;

      switch (test.outcome()) {
        case 'expected':
          summary.totals.passed += 1;
          bucket.passed += 1;
          break;
        case 'flaky':
          summary.totals.flaky += 1;
          bucket.flaky += 1;
          summary.flakyTests.push({ title, project, retries: last.retry });
          break;
        case 'skipped':
          summary.totals.skipped += 1;
          bucket.skipped += 1;
          break;
        case 'unexpected':
          summary.totals.failed += 1;
          bucket.failed += 1;
          summary.failures.push({
            title,
            project,
            file: path.relative(process.cwd(), test.location.file),
            error: truncate(maskSensitiveText(last.errors.map((e) => e.message ?? '').join('\n')), 1500),
            retries: last.retry,
          });
          break;
      }
      summary.slowestTests.push({ title, project, durationMs: last.duration });
    }
    summary.slowestTests = summary.slowestTests.sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);

    writeJsonFileAtomic(this.outputFile, summary);
    const t = summary.totals;
    process.stdout.write(
      `\n[summary] env=${summary.environment} status=${summary.status} total=${t.total} passed=${t.passed} ` +
        `failed=${t.failed} flaky=${t.flaky} skipped=${t.skipped} duration=${formatDuration(summary.durationMs)}\n`,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}
