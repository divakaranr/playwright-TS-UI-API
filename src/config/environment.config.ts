import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigurationError } from '../core/exceptions/index.js';
import { paths } from '../utils/paths.js';
import {
  environmentFileSchema,
  formatZodIssues,
  type EnvironmentFile,
  type EnvironmentName,
} from './config.schema.js';

/**
 * Loads and validates config/environments/<env>.json. Throws a ConfigurationError
 * listing every problem (not just the first) so misconfiguration is fixed in one pass.
 */
export function loadEnvironmentFile(
  name: EnvironmentName,
  configDir: string = paths.environments,
): EnvironmentFile {
  const file = path.join(configDir, `${name}.json`);
  if (!existsSync(file)) {
    throw new ConfigurationError(`Environment file not found for "${name}": ${file}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigurationError(`Environment file is not valid JSON: ${file}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = environmentFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error);
    throw new ConfigurationError(`Invalid environment file ${file}:\n - ${issues.join('\n - ')}`, { issues });
  }
  if (parsed.data.name !== name) {
    throw new ConfigurationError(
      `Environment file ${file} declares name "${parsed.data.name}", expected "${name}"`,
    );
  }
  return parsed.data;
}
