import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'playwright-enterprise-framework';

/**
 * Resolves the project root by walking up from this module until the framework's
 * package.json is found. This keeps file resolution correct regardless of the
 * process working directory (MCP hosts frequently launch servers from elsewhere)
 * and regardless of whether code runs from `src/` (tsx/Playwright) or `dist/`.
 */
function resolveProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === PACKAGE_NAME) return dir;
      } catch {
        // Unreadable package.json: keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

export const PROJECT_ROOT = resolveProjectRoot();

export const paths = {
  root: PROJECT_ROOT,
  environments: path.join(PROJECT_ROOT, 'config', 'environments'),
  testData: path.join(PROJECT_ROOT, 'test-data'),
  tests: path.join(PROJECT_ROOT, 'tests'),
  docs: path.join(PROJECT_ROOT, 'docs'),
  src: path.join(PROJECT_ROOT, 'src'),
  reports: path.join(PROJECT_ROOT, 'reports'),
  testResults: path.join(PROJECT_ROOT, 'test-results'),
  logs: path.join(PROJECT_ROOT, 'logs'),
  auth: path.join(PROJECT_ROOT, '.auth'),
  generatedTests: path.join(PROJECT_ROOT, 'generated-tests'),
  demoApp: path.join(PROJECT_ROOT, 'demo-app'),
} as const;

/** Returns true when `target` resolves inside `base` (prevents path traversal). */
export function isPathInside(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
