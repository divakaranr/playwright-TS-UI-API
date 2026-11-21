import { EnvironmentPolicyError } from '../core/exceptions/index.js';
import type { FrameworkConfig } from './config.schema.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchesOperation(pattern: string, method: string, endpointPath: string): boolean {
  const [patternMethod, patternPath = ''] = pattern.split(' ');
  if (patternMethod !== method) return false;
  const regex = new RegExp(
    `^${patternPath
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+')}$`,
  );
  return regex.test(endpointPath);
}

/**
 * Enforces the environment write policy for an outgoing request.
 *
 * - Safe methods (GET/HEAD/OPTIONS) are always allowed.
 * - Writable environments allow everything.
 * - Read-only environments (prod) block every write unless ALLOW_PROD_WRITES=true
 *   AND the operation is allow-listed (env JSON `allowedWriteOperations` or
 *   PROD_WRITE_ALLOWLIST). DELETE is never allowed against a read-only environment.
 */
export function assertWriteAllowed(config: FrameworkConfig, method: string, endpointPath: string): void {
  const upper = method.toUpperCase();
  if (SAFE_METHODS.has(upper)) return;
  const { environment, security } = config;
  if (!environment.readOnly) return;

  const context = { environment: environment.name, method: upper, path: endpointPath };
  if (upper === 'DELETE') {
    throw new EnvironmentPolicyError(
      `Destructive operation blocked: DELETE ${endpointPath} is never permitted against read-only environment "${environment.name}"`,
      context,
    );
  }
  if (!security.allowProdWrites) {
    throw new EnvironmentPolicyError(
      `Write blocked: ${upper} ${endpointPath} against read-only environment "${environment.name}". ` +
        'Set ALLOW_PROD_WRITES=true and allow-list the operation to opt in.',
      context,
    );
  }
  const allowlist = [...environment.allowedWriteOperations, ...security.prodWriteAllowlist];
  if (!allowlist.some((pattern) => matchesOperation(pattern, upper, endpointPath))) {
    throw new EnvironmentPolicyError(
      `Write blocked: ${upper} ${endpointPath} is not in the production write allowlist`,
      context,
    );
  }
}

/** True when the given test tags may run in the configured environment. */
export function isTestAllowedInEnvironment(config: FrameworkConfig, tags: readonly string[]): boolean {
  if (!config.environment.readOnly) return true;
  return tags.includes('@prod-safe') && !tags.includes('@destructive');
}
