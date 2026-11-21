import type { FrameworkConfig } from './config.schema.js';
import { loadConfig, loadDotenvFiles } from './framework.config.js';

export * from './config.schema.js';
export { assertWriteAllowed, isTestAllowedInEnvironment } from './environment-policy.js';
export { getCredentials, loadConfig, loadDotenvFiles, type Credentials } from './framework.config.js';

let cached: FrameworkConfig | undefined;

/**
 * Returns the validated configuration for the current process (cached).
 * The first call loads `.env` files and fails fast on invalid configuration.
 */
export function getConfig(): FrameworkConfig {
  if (!cached) {
    loadDotenvFiles();
    cached = loadConfig();
  }
  return cached;
}

/** Clears the cached configuration (unit tests only). */
export function resetConfigCache(): void {
  cached = undefined;
}
