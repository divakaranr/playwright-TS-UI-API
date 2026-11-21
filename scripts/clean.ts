/**
 * Removes generated artifacts.  npm run clean [-- --all]
 * --all additionally removes stored auth sessions (.auth) and dist/.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

import { paths } from '../src/utils/paths.js';

const targets = ['reports', 'test-results', 'playwright-report', 'blob-report', 'logs', '.playwright-mcp'];
if (process.argv.includes('--all')) targets.push('.auth', 'dist', 'generated-tests');

for (const target of targets) {
  rmSync(path.join(paths.root, target), { recursive: true, force: true });
  console.log(`removed ${target}/`);
}
