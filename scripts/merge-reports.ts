/**
 * Merges blob reports produced by sharded runs (PW_BLOB_REPORT=true) into a single
 * HTML + JSON + JUnit report.  npm run reports:merge [-- <blob-dir>]
 *
 * CI downloads every shard's reports/blob/*.zip into one folder and runs this.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { playwrightCli } from '../src/core/services/process.util.js';
import { paths } from '../src/utils/paths.js';

const blobDir = path.resolve(process.argv[2] ?? path.join(paths.reports, 'blob'));
if (!existsSync(blobDir) || readdirSync(blobDir).filter((f) => f.endsWith('.zip')).length === 0) {
  console.error(`No blob reports (*.zip) found in ${blobDir}`);
  process.exit(1);
}

const outDir = path.join(paths.reports, 'merged');
const result = spawnSync(
  process.execPath,
  [playwrightCli(), 'merge-reports', '--reporter', 'html,json,junit', blobDir],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(outDir, 'html'),
      PLAYWRIGHT_HTML_OPEN: 'never',
      PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(outDir, 'results.json'),
      PLAYWRIGHT_JUNIT_OUTPUT_NAME: path.join(outDir, 'junit.xml'),
    },
  },
);
console.log(
  result.status === 0 ? `merged report written to ${path.relative(paths.root, outDir)}` : 'merge failed',
);
process.exit(result.status ?? 1);
