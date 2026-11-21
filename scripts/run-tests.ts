/**
 * Test runner wrapper used by the npm scripts.
 *
 *   tsx scripts/run-tests.ts [--env <name>] [--skip-typecheck] [--mobile] [-- <playwright args>]
 *
 * 1. Selects the environment (sets TEST_ENV) – cross-platform, no cross-env needed.
 * 2. Runs the TypeScript compiler independently first (Playwright only strips
 *    types; it never type-checks). Skipped with --skip-typecheck or SKIP_TYPECHECK=true
 *    (CI runs typecheck as its own pipeline step).
 * 3. Delegates to `playwright test`. Playwright remains the only test runner.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ENVIRONMENTS = ['local', 'dev', 'qa', 'uat', 'staging', 'prod'];
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const own = separator === -1 ? argv : argv.slice(0, separator);
const playwrightArgs = separator === -1 ? [] : argv.slice(separator + 1);

const env: NodeJS.ProcessEnv = { ...process.env };
for (let i = 0; i < own.length; i++) {
  const arg = own[i];
  if (arg === '--env') {
    const value = own[++i];
    if (!value || !ENVIRONMENTS.includes(value)) {
      console.error(`--env must be one of: ${ENVIRONMENTS.join(', ')}`);
      process.exit(2);
    }
    env.TEST_ENV = value;
  } else if (arg === '--skip-typecheck') {
    env.SKIP_TYPECHECK = 'true';
  } else if (arg === '--mobile') {
    env.MOBILE = 'true';
  } else {
    console.error(`Unknown option "${arg}". Pass Playwright options after "--".`);
    process.exit(2);
  }
}

const run = (script: string, args: string[]): number =>
  spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env }).status ?? 1;

if (env.SKIP_TYPECHECK !== 'true') {
  console.log('> tsc --noEmit');
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const status = run(tsc, ['-p', 'tsconfig.json', '--noEmit']);
  if (status !== 0) {
    console.error('Type check failed – fix compilation errors before running tests.');
    process.exit(status);
  }
}

const cli = path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
console.log(`> playwright test ${playwrightArgs.join(' ')} (TEST_ENV=${env.TEST_ENV ?? 'local'})`);
process.exit(run(cli, ['test', ...playwrightArgs]));
