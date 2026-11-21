import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { FrameworkError } from '../../../core/exceptions/index.js';
import { ensureDir, slugify } from '../../../utils/file.util.js';
import { fileTimestamp } from '../../../utils/date.util.js';
import { isPathInside, paths } from '../../../utils/paths.js';

/**
 * Persists generated drafts to generated-tests/ (git-ignored, outside the test
 * directory) so they can never silently enter the regression suite.
 */
export function saveDraft(name: string, code: string): string {
  const dir = ensureDir(paths.generatedTests);
  const file = path.join(dir, `${slugify(name)}-${fileTimestamp()}.spec.ts`);
  if (!isPathInside(dir, file))
    throw new FrameworkError('INVALID_DRAFT_PATH', 'Draft path escaped generated-tests/');
  writeFileSync(file, code, 'utf8');
  return path.relative(paths.root, file);
}
