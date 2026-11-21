import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  JSONReport,
  JSONReportSuite,
  JSONReportTest,
  JSONReportTestResult,
} from '@playwright/test/reporter';

import type { FailureReportInput } from '../../ai/services/failure-report.js';
import { isPathInside, paths } from '../../utils/paths.js';
import { maskSensitiveText, redactSensitive, stripAnsi, truncate } from '../../utils/sanitizer.js';
import { FrameworkError } from '../exceptions/index.js';
import type { BrowserDiagnosticsSnapshot } from '../diagnostics/browser-diagnostics.js';
import type { ApiCallRecord } from '../diagnostics/api-call.recorder.js';
import type { RunSummary } from '../reporting/summary.reporter.js';
import { readTraceMetadata } from './trace-reader.js';

export interface FailedTest {
  title: string;
  file: string;
  line: number;
  project: string;
  status: JSONReportTestResult['status'];
  retry: number;
  errorMessage: string;
  errorStack?: string;
  /** `body` (base64) is retained only for the small JSON diagnostics attachment. */
  attachments: Array<{ name: string; contentType: string; path?: string; body?: string }>;
  steps: string[];
}

interface FailureDiagnosticsAttachment {
  apiCalls?: ApiCallRecord[];
  browser?: BrowserDiagnosticsSnapshot;
}

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Read-only access to test results produced by the reporters: summaries,
 * failed tests, failure diagnostics and trace metadata. Used by MCP debugging
 * tools and AI failure analysis. All returned text is sanitised.
 */
export class ResultsService {
  constructor(private readonly reportsRoot: string = paths.reports) {}

  /** Resolves a run's report directory (latest local run when runId is omitted). */
  reportDir(runId?: string): string {
    if (!runId) return this.reportsRoot;
    if (!RUN_ID.test(runId)) throw new FrameworkError('INVALID_RUN_ID', 'runId contains invalid characters');
    const dir = path.join(this.reportsRoot, 'mcp-runs', runId);
    if (!isPathInside(this.reportsRoot, dir) || !existsSync(dir))
      throw new FrameworkError('RUN_NOT_FOUND', `No results for run "${runId}"`);
    return dir;
  }

  getSummary(runId?: string): RunSummary {
    const file = path.join(this.reportDir(runId), 'summary.json');
    if (!existsSync(file))
      throw new FrameworkError(
        'RESULTS_NOT_FOUND',
        `No summary.json found${runId ? ` for run ${runId}` : ''}; run tests first`,
      );
    return JSON.parse(readFileSync(file, 'utf8')) as RunSummary;
  }

  async listRuns(
    limit = 10,
  ): Promise<Array<{ runId: string; status?: string; totals?: RunSummary['totals'] }>> {
    const dir = path.join(this.reportsRoot, 'mcp-runs');
    if (!existsSync(dir)) return [];
    const ids = (await readdir(dir))
      .filter((d) => RUN_ID.test(d))
      .sort()
      .reverse()
      .slice(0, limit);
    return ids.map((runId) => {
      try {
        const summary = this.getSummary(runId);
        return { runId, status: summary.status, totals: summary.totals };
      } catch {
        return { runId };
      }
    });
  }

  async loadReport(runId?: string): Promise<JSONReport> {
    const file = path.join(this.reportDir(runId), 'results.json');
    if (!existsSync(file))
      throw new FrameworkError('RESULTS_NOT_FOUND', 'No results.json found; run tests first');
    return JSON.parse(await readFile(file, 'utf8')) as JSONReport;
  }

  async findFailedTests(runId?: string, titleContains?: string): Promise<FailedTest[]> {
    const report = await this.loadReport(runId);
    // Spec paths are relative to the run's rootDir (testDir); normalise them to the project root.
    const rootDir = report.config.rootDir || paths.tests;
    const toProjectPath = (file: string) =>
      path.relative(paths.root, path.resolve(rootDir, file)).split(path.sep).join('/');
    const failures: FailedTest[] = [];
    const needle = titleContains?.toLowerCase();

    const visit = (suite: JSONReportSuite, titlePath: string[]) => {
      const nextPath = suite.title && !suite.title.endsWith('.ts') ? [...titlePath, suite.title] : titlePath;
      for (const spec of suite.specs) {
        const title = [...nextPath, spec.title].join(' > ');
        if (needle && !title.toLowerCase().includes(needle)) continue;
        for (const test of spec.tests) {
          const last = test.results.at(-1);
          if (!last || !isUnexpected(test, last)) continue;
          failures.push(toFailedTest(title, toProjectPath(spec.file), spec.line, test, last));
        }
      }
      for (const child of suite.suites ?? []) visit(child, nextPath);
    };
    for (const suite of report.suites) visit(suite, []);
    return failures;
  }

  async getFailure(runId: string | undefined, titleContains: string): Promise<FailedTest> {
    const [failure] = await this.findFailedTests(runId, titleContains);
    if (!failure) throw new FrameworkError('FAILURE_NOT_FOUND', `No failed test matching "${titleContains}"`);
    return failure;
  }

  /** Reads and sanitises the failure-diagnostics.json attachment, if present. */
  async readDiagnostics(failure: FailedTest): Promise<FailureDiagnosticsAttachment | undefined> {
    const attachment = failure.attachments.find((a) => a.name === 'failure-diagnostics.json');
    if (!attachment) return undefined;
    let raw: string | undefined;
    // The JSON reporter inlines body attachments as base64; file attachments are referenced by path.
    if (attachment.body) raw = Buffer.from(attachment.body, 'base64').toString('utf8');
    else if (attachment.path && isPathInside(paths.root, attachment.path) && existsSync(attachment.path))
      raw = await readFile(attachment.path, 'utf8');
    return raw === undefined ? undefined : redactSensitive(JSON.parse(raw) as FailureDiagnosticsAttachment);
  }

  async traceMetadata(failure: FailedTest) {
    const trace = failure.attachments.find((a) => a.name === 'trace' && a.path);
    if (!trace?.path || !existsSync(trace.path))
      throw new FrameworkError('TRACE_NOT_FOUND', `No trace recorded for "${failure.title}"`);
    return readTraceMetadata(trace.path);
  }

  /** Builds the sanitised diagnostic package used by AI failure analysis. */
  async buildFailureReport(failure: FailedTest): Promise<FailureReportInput> {
    const diagnostics = await this.readDiagnostics(failure);
    let traceSummary: string[] = [];
    try {
      const trace = await this.traceMetadata(failure);
      traceSummary = trace.actions
        .slice(-40)
        .map(
          (a) =>
            `${a.title}${a.durationMs !== undefined ? ` (${a.durationMs}ms)` : ''}${a.error ? ` ERROR: ${a.error}` : ''}`,
        );
    } catch {
      // trace optional
    }
    const browser = diagnostics?.browser;
    return {
      testTitle: failure.title,
      file: failure.file,
      line: failure.line,
      project: failure.project,
      retry: failure.retry,
      error: { message: failure.errorMessage, ...(failure.errorStack ? { stack: failure.errorStack } : {}) },
      steps: failure.steps,
      artifacts: failure.attachments.map((a) => ({
        name: a.name,
        contentType: a.contentType,
        ...(a.path ? { path: path.relative(paths.root, a.path) } : {}),
      })),
      traceSummary,
      consoleErrors: browser?.consoleErrors.map((c) => c.text) ?? [],
      pageErrors: browser?.pageErrors.map((p) => p.message) ?? [],
      failedRequests:
        browser?.failedRequests.map((r) => ({
          method: r.method,
          url: r.url,
          ...(r.status !== undefined ? { status: r.status } : {}),
          ...(r.failure ? { failure: r.failure } : {}),
        })) ?? [],
      apiCalls:
        diagnostics?.apiCalls?.map((c) => ({
          method: c.method,
          url: c.url,
          ...(c.status !== undefined ? { status: c.status } : {}),
          durationMs: c.durationMs,
          ...(c.error ? { error: c.error } : {}),
        })) ?? [],
      sourceSnippets: this.sourceSnippet(failure),
    };
  }

  private sourceSnippet(failure: FailedTest): Array<{ path: string; content: string }> {
    const file = path.resolve(paths.root, failure.file);
    if (!isPathInside(paths.root, file) || !existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n');
    const start = Math.max(0, failure.line - 5);
    // Masked at collection time (defence in depth – the analysis service sanitises again).
    return [
      {
        path: path.relative(paths.root, file),
        content: maskSensitiveText(lines.slice(start, start + 60).join('\n')),
      },
    ];
  }
}

function isUnexpected(test: JSONReportTest, last: JSONReportTestResult): boolean {
  return test.status === 'unexpected' || (last.status !== test.expectedStatus && last.status !== 'skipped');
}

function toFailedTest(
  title: string,
  file: string,
  line: number,
  test: JSONReportTest,
  result: JSONReportTestResult,
): FailedTest {
  const error = result.errors[0] ?? result.error;
  const flatSteps: string[] = [];
  const walk = (steps: JSONReportTestResult['steps'] | undefined, depth: number) => {
    for (const step of steps ?? []) {
      if (flatSteps.length >= 100) return;
      flatSteps.push(`${'  '.repeat(depth)}${step.title}${step.error ? ' [FAILED]' : ''}`);
      walk(step.steps, depth + 1);
    }
  };
  walk(result.steps, 0);
  return {
    title,
    file,
    line,
    project: test.projectName,
    status: result.status,
    retry: result.retry,
    errorMessage: truncate(maskSensitiveText(stripAnsi(error?.message ?? 'unknown error')), 6000),
    ...(error && 'stack' in error && error.stack
      ? { errorStack: truncate(maskSensitiveText(stripAnsi(error.stack)), 6000) }
      : {}),
    attachments: result.attachments.map((a) => ({
      name: a.name,
      contentType: a.contentType,
      ...(a.path ? { path: a.path } : {}),
      ...(a.body && a.name === 'failure-diagnostics.json' ? { body: a.body } : {}),
    })),
    steps: flatSteps,
  };
}
