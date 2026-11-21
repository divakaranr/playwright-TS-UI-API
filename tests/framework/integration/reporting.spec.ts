import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { FailureAnalysisService } from '../../../src/ai/services/failure-analysis.service.js';
import type { RunSummary } from '../../../src/core/reporting/summary.reporter.js';
import { ResultsService } from '../../../src/core/services/results.service.js';
import { paths } from '../../../src/utils/paths.js';

const require = createRequire(import.meta.url);

interface JsonReport {
  suites: Array<{
    specs: Array<{
      title: string;
      tests: Array<{
        results: Array<{ attachments: Array<{ name: string; body?: string; path?: string }> }>;
      }>;
    }>;
  }>;
}

/**
 * Reporting integration: runs a small sample suite in a nested Playwright process
 * and verifies that every reporter produces output and that failure diagnostics
 * are attached *and sanitised*.
 */
test.describe('reporting pipeline', () => {
  test.describe.configure({ timeout: 120_000 });
  let reportDir: string;

  test.beforeAll(() => {
    // Inside the project: ResultsService only reads artifacts located under the project root.
    mkdirSync(paths.testResults, { recursive: true });
    reportDir = mkdtempSync(path.join(paths.testResults, 'framework-reporting-'));
    const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
    const result = spawnSync(
      process.execPath,
      [cli, 'test', '-c', 'tests/framework/support/reporting.config.ts'],
      {
        cwd: paths.root,
        env: { ...process.env, REPORT_DIR: reportDir, LOG_CONSOLE_LEVEL: 'silent', CI: '' },
        encoding: 'utf8',
        timeout: 110_000,
      },
    );
    expect(result.status, `nested run should fail (1 failing sample): ${result.stderr}`).toBe(1);
  });

  test('summary reporter aggregates totals and failures', () => {
    const summary = JSON.parse(readFileSync(path.join(reportDir, 'summary.json'), 'utf8')) as RunSummary;

    expect(summary.status).toBe('failed');
    expect(summary.totals).toMatchObject({ total: 3, passed: 1, failed: 1, skipped: 1, flaky: 0 });
    expect(summary.projects.sample).toEqual({ passed: 1, failed: 1, skipped: 1, flaky: 0 });
    expect(summary.failures[0]).toMatchObject({
      title: 'sample failing test with secrets in diagnostics',
      project: 'sample',
    });
    expect(summary.failures[0]!.error).toContain('deliberate failure');
  });

  test('JSON, JUnit and Allure outputs are produced', () => {
    expect(existsSync(path.join(reportDir, 'results.json'))).toBe(true);
    expect(readFileSync(path.join(reportDir, 'junit.xml'), 'utf8')).toContain('tests="3"');
    expect(readdirSync(path.join(reportDir, 'allure-results')).some((f) => f.endsWith('-result.json'))).toBe(
      true,
    );
  });

  test('failure diagnostics are attached and contain no secrets', () => {
    const report = JSON.parse(readFileSync(path.join(reportDir, 'results.json'), 'utf8')) as JsonReport;
    const failing = report.suites.flatMap((s) => s.specs).find((s) => s.title.startsWith('sample failing'))!;
    const attachment = failing.tests[0]!.results[0]!.attachments.find(
      (a) => a.name === 'failure-diagnostics.json',
    )!;
    expect(attachment, 'diagnostics attachment present').toBeDefined();

    const content = attachment.body
      ? Buffer.from(attachment.body, 'base64').toString()
      : readFileSync(attachment.path!, 'utf8');
    const diagnostics = JSON.parse(content) as {
      apiCalls: unknown[];
      errors: unknown[];
      context: { correlationId: string };
    };
    expect(diagnostics.apiCalls).toHaveLength(1);
    expect(diagnostics.errors).toHaveLength(1);
    expect(diagnostics.context.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    for (const secret of ['sample-secret-token', 'sample-secret-password', 'someone@example.com'])
      expect(content).not.toContain(secret);
  });

  test('ResultsService finds failures, diagnostics and trace metadata', async () => {
    const results = new ResultsService(reportDir);

    expect(results.getSummary().totals.failed).toBe(1);
    const [failure, ...others] = await results.findFailedTests();
    expect(others).toHaveLength(0);
    expect(failure).toMatchObject({
      title: 'sample failing test with secrets in diagnostics',
      project: 'sample',
      status: 'failed',
    });
    expect(failure!.errorMessage).toContain('deliberate failure');
    expect(failure!.errorMessage).not.toContain('\u001b[');

    const diagnostics = await results.readDiagnostics(failure!);
    expect(diagnostics?.apiCalls?.[0]).toMatchObject({ method: 'POST', status: 500 });

    const trace = await results.traceMetadata(failure!);
    expect(trace.entryCount).toBeGreaterThan(0);
    expect(trace.actions.length).toBeGreaterThan(0);
    expect(trace.showTraceCommand).toContain('show-trace');

    await expect(results.getFailure(undefined, 'does-not-exist')).rejects.toThrow(/No failed test matching/);
    expect(() => results.reportDir('../../etc')).toThrow(/invalid characters/);
  });

  test('failure report feeds AI analysis (heuristic mode) with sanitised evidence', async () => {
    const results = new ResultsService(reportDir);
    const failure = await results.getFailure(undefined, 'sample failing');
    const report = await results.buildFailureReport(failure);

    expect(report.apiCalls).toEqual([expect.objectContaining({ status: 500 })]);
    expect(report.sourceSnippets?.[0]?.content).toContain('deliberate failure');
    expect(JSON.stringify(report)).not.toContain('sample-secret');

    const analysis = await new FailureAnalysisService().analyze(report);
    expect(analysis.source).toBe('heuristic');
    expect(analysis.analysis.classification).toBe('application_defect');
  });
});
