import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { randomBytes } from 'node:crypto';

import { getConfig, type EnvironmentName, type FrameworkConfig } from '../../config/index.js';
import { fileTimestamp } from '../../utils/date.util.js';
import { getLogger, type Logger } from '../../utils/logger.js';
import { isPathInside, paths } from '../../utils/paths.js';
import { maskSensitiveText, truncate } from '../../utils/sanitizer.js';
import { EnvironmentPolicyError, FrameworkError } from '../exceptions/index.js';
import type { RunSummary } from '../reporting/summary.reporter.js';
import { playwrightCli, runNodeScript } from './process.util.js';

/** Projects that may be executed through automation (setup runs implicitly as a dependency). */
export const RUNNABLE_PROJECTS = [
  'chromium',
  'firefox',
  'webkit',
  'api',
  'framework-unit',
  'framework-integration',
] as const;
export type RunnableProject = (typeof RUNNABLE_PROJECTS)[number];

/**
 * Safe grep: tags, words, spaces and a small set of regex operators (alternation,
 * groups, lookaheads for tag AND-matching). Length-bounded and matched only
 * against short test titles, so pathological backtracking is not a practical risk.
 */
export const SAFE_GREP = /^[\w@\s|().:'",>?=*^-]{1,200}$/;

export interface RunRequest {
  environment: EnvironmentName;
  /** Test paths relative to the project root; must stay inside tests/. */
  paths?: string[];
  projects?: RunnableProject[];
  grep?: string;
  grepInvert?: string;
  workers?: number;
  retries?: number;
  /** Short label for logs/audit (e.g. the MCP tool name). */
  label: string;
}

export interface RunResult {
  runId: string;
  label: string;
  environment: EnvironmentName;
  status: 'passed' | 'failed' | 'timedout' | 'interrupted' | 'error';
  exitCode: number | null;
  durationMs: number;
  args: string[];
  summary?: Pick<RunSummary, 'totals' | 'projects' | 'failures' | 'flakyTests'>;
  reportDir: string;
  htmlReport: string;
  /** Tail of the runner output (sanitised), included when the run did not pass. */
  outputTail?: string;
}

/** Builds the Playwright CLI argument list. Pure function – unit tested. */
export function buildPlaywrightArgs(request: RunRequest, root: string = paths.root): string[] {
  const args = ['test'];
  for (const p of request.paths ?? []) {
    const absolute = path.resolve(root, p);
    if (!isPathInside(path.join(root, 'tests'), absolute)) {
      throw new FrameworkError('INVALID_TEST_PATH', `Test path must be inside tests/: ${p}`);
    }
    args.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  for (const project of request.projects ?? []) {
    if (!RUNNABLE_PROJECTS.includes(project))
      throw new FrameworkError('INVALID_PROJECT', `Unknown project: ${String(project)}`);
    args.push(`--project=${project}`);
  }
  for (const [flag, value] of [
    ['--grep', request.grep],
    ['--grep-invert', request.grepInvert],
  ] as const) {
    if (value === undefined) continue;
    if (!SAFE_GREP.test(value))
      throw new FrameworkError('INVALID_GREP', `${flag} contains unsupported characters or is too long`);
    args.push(flag, value);
  }
  if (request.workers !== undefined) args.push(`--workers=${Math.min(Math.max(1, request.workers), 8)}`);
  if (request.retries !== undefined) args.push(`--retries=${Math.min(Math.max(0, request.retries), 3)}`);
  return args;
}

/**
 * Executes Playwright test runs on behalf of automation (MCP tools, scripts).
 * One run at a time per process; each run gets an isolated report directory
 * under reports/mcp-runs/<runId>. Never exposes a shell.
 */
export class TestExecutionService {
  private active: string | undefined;
  private readonly logger: Logger;
  private readonly config: FrameworkConfig;

  constructor(options: { config?: FrameworkConfig; logger?: Logger } = {}) {
    this.config = options.config ?? getConfig();
    this.logger = options.logger ?? getLogger();
  }

  get activeRun(): string | undefined {
    return this.active;
  }

  async run(request: RunRequest, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
    if (!this.config.mcp.allowedEnvironments.includes(request.environment)) {
      throw new EnvironmentPolicyError(
        `Environment "${request.environment}" is not allowed for automated execution (allowed: ${this.config.mcp.allowedEnvironments.join(', ')})`,
      );
    }
    if (this.active)
      throw new FrameworkError(
        'RUN_IN_PROGRESS',
        `Another test run is in progress (${this.active}); try again later`,
      );

    const args = buildPlaywrightArgs(request);
    const runId = `${fileTimestamp()}-${randomBytes(3).toString('hex')}`;
    const reportDir = path.join(paths.reports, 'mcp-runs', runId);
    this.active = runId;
    this.logger.info(
      { runId, label: request.label, environment: request.environment, args },
      'test run started',
    );

    try {
      const result = await runNodeScript(playwrightCli(), args, {
        cwd: paths.root,
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        env: {
          ...process.env,
          TEST_ENV: request.environment,
          REPORT_DIR: reportDir,
          PW_OUTPUT_DIR: path.join(paths.testResults, 'mcp-runs', runId),
          PW_REUSE_SERVER: 'true',
          LOG_CONSOLE_LEVEL: 'silent',
          FORCE_COLOR: '0',
          SKIP_TYPECHECK: 'true',
        },
      });

      const summaryFile = path.join(reportDir, 'summary.json');
      const summary = existsSync(summaryFile)
        ? (JSON.parse(readFileSync(summaryFile, 'utf8')) as RunSummary)
        : undefined;
      const status: RunResult['status'] = result.timedOut
        ? 'timedout'
        : summary
          ? summary.status === 'passed'
            ? 'passed'
            : summary.status === 'interrupted'
              ? 'interrupted'
              : 'failed'
          : result.exitCode === 0
            ? 'passed'
            : 'error';

      const runResult: RunResult = {
        runId,
        label: request.label,
        environment: request.environment,
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        args,
        reportDir: path.relative(paths.root, reportDir),
        htmlReport: path.relative(paths.root, path.join(reportDir, 'html', 'index.html')),
        ...(summary
          ? {
              summary: {
                totals: summary.totals,
                projects: summary.projects,
                failures: summary.failures.slice(0, 10),
                flakyTests: summary.flakyTests,
              },
            }
          : {}),
        ...(status !== 'passed'
          ? { outputTail: truncate(maskSensitiveText(result.output.slice(-4000)), 4000) }
          : {}),
      };
      this.logger.info(
        { runId, status, durationMs: result.durationMs, totals: summary?.totals },
        'test run finished',
      );
      return runResult;
    } finally {
      this.active = undefined;
    }
  }
}
