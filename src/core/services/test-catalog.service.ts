import path from 'node:path';

import type { JSONReport, JSONReportSuite } from '@playwright/test/reporter';

import { paths } from '../../utils/paths.js';
import { FrameworkError } from '../exceptions/index.js';
import { playwrightCli, runNodeScript } from './process.util.js';

export interface TestCatalog {
  generatedAt: string;
  totalTests: number;
  byProject: Record<string, number>;
  byTag: Record<string, number>;
  files: Array<{ file: string; tests: number; titles: string[] }>;
}

const CACHE_TTL_MS = 5 * 60_000;

/** Discovers the test suite via `playwright test --list` (no tests are executed). */
export class TestCatalogService {
  private cache: { at: number; catalog: TestCatalog } | undefined;

  async getCatalog(options: { refresh?: boolean } = {}): Promise<TestCatalog> {
    if (!options.refresh && this.cache && Date.now() - this.cache.at < CACHE_TTL_MS)
      return this.cache.catalog;

    const result = await runNodeScript(playwrightCli(), ['test', '--list', '--reporter=json'], {
      cwd: paths.root,
      env: { ...process.env, LOG_CONSOLE_LEVEL: 'silent', FORCE_COLOR: '0' },
      timeoutMs: 120_000,
      maxOutputChars: 20_000_000,
    });
    const start = result.output.indexOf('{');
    if (result.exitCode !== 0 || start === -1) {
      throw new FrameworkError(
        'CATALOG_FAILED',
        `Test discovery failed (exit ${result.exitCode}): ${result.output.slice(-500)}`,
      );
    }
    const report = JSON.parse(result.output.slice(start, result.output.lastIndexOf('}') + 1)) as JSONReport;
    const catalog = summarize(report);
    this.cache = { at: Date.now(), catalog };
    return catalog;
  }
}

export function summarize(report: JSONReport): TestCatalog {
  const byProject: Record<string, number> = {};
  const byTag: Record<string, number> = {};
  const files = new Map<string, { tests: number; titles: Set<string> }>();
  let total = 0;

  const visit = (suite: JSONReportSuite) => {
    for (const spec of suite.specs) {
      const file = spec.file.split(path.sep).join('/');
      const entry = files.get(file) ?? { tests: 0, titles: new Set<string>() };
      entry.titles.add(spec.title);
      for (const test of spec.tests) {
        total += 1;
        entry.tests += 1;
        byProject[test.projectName] = (byProject[test.projectName] ?? 0) + 1;
        for (const tag of spec.tags)
          byTag[`@${tag.replace(/^@/, '')}`] = (byTag[`@${tag.replace(/^@/, '')}`] ?? 0) + 1;
      }
      files.set(file, entry);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);

  return {
    generatedAt: new Date().toISOString(),
    totalTests: total,
    byProject,
    byTag,
    files: [...files.entries()]
      .map(([file, v]) => ({ file, tests: v.tests, titles: [...v.titles].slice(0, 50) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
}
