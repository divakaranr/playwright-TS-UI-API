import { existsSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

import { ConfigurationError } from '../core/exceptions/index.js';
import { paths } from '../utils/paths.js';
import { formatZodIssues, processEnvSchema, type FrameworkConfig } from './config.schema.js';
import { loadEnvironmentFile } from './environment.config.js';

export interface LoadConfigOptions {
  /** Environment variables to read (defaults to process.env). Injected in unit tests. */
  env?: NodeJS.ProcessEnv;
  /** Directory containing <env>.json files (defaults to config/environments). */
  configDir?: string;
}

/**
 * Loads `.env` files into process.env exactly once. Real environment variables always
 * win (dotenv never overrides). `quiet: true` is mandatory: dotenv otherwise prints to
 * stdout, which would corrupt the MCP stdio protocol stream.
 */
let dotenvLoaded = false;
export function loadDotenvFiles(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const testEnv = process.env.TEST_ENV?.trim();
  const candidates = [testEnv ? `.env.${testEnv}` : undefined, '.env']
    .filter((f): f is string => Boolean(f))
    .map((f) => path.join(paths.root, f))
    .filter((f) => existsSync(f));
  if (candidates.length > 0) dotenv.config({ path: candidates, quiet: true });
}

/**
 * Pure configuration loader: validates environment variables, loads the selected
 * environment JSON, applies overrides and cross-field rules. Fails fast with a
 * ConfigurationError that lists every issue.
 */
export function loadConfig(options: LoadConfigOptions = {}): FrameworkConfig {
  const env = options.env ?? process.env;
  const parsedEnv = processEnvSchema.safeParse(env);
  if (!parsedEnv.success) {
    const issues = formatZodIssues(parsedEnv.error);
    throw new ConfigurationError(`Invalid environment variables:\n - ${issues.join('\n - ')}`, { issues });
  }
  const e = parsedEnv.data;
  const file = loadEnvironmentFile(e.TEST_ENV, options.configDir);

  const environment = {
    ...file,
    baseUrl: stripTrailingSlash(e.BASE_URL ?? file.baseUrl),
    apiBaseUrl: stripTrailingSlash(e.API_BASE_URL ?? file.apiBaseUrl),
  };

  const config: FrameworkConfig = {
    environment,
    execution: {
      ci: e.CI,
      workers: e.WORKERS,
      retries: e.RETRIES ?? (e.CI ? 2 : 0),
      headless: e.HEADLESS,
      mobile: e.MOBILE,
    },
    security: {
      allowProdWrites: e.ALLOW_PROD_WRITES,
      prodWriteAllowlist: e.PROD_WRITE_ALLOWLIST,
    },
    apiClient: { clientId: e.API_CLIENT_ID, clientSecret: e.API_CLIENT_SECRET },
    logging: {
      level: e.LOG_LEVEL,
      consoleLevel: e.LOG_CONSOLE_LEVEL,
      destination: e.LOG_DESTINATION,
      file: e.LOG_FILE,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      apiKey: e.LLM_API_KEY,
      baseUrl: e.LLM_BASE_URL,
      timeoutMs: e.LLM_TIMEOUT_MS,
      maxRetries: e.LLM_MAX_RETRIES,
    },
    mcp: {
      allowedEnvironments:
        e.MCP_ALLOWED_ENVIRONMENTS.length > 0 ? e.MCP_ALLOWED_ENVIRONMENTS : ['local', 'dev', 'qa'],
      toolTimeoutMs: e.MCP_TOOL_TIMEOUT_MS,
      enabledTools: e.MCP_ENABLED_TOOLS,
      httpToken: e.MCP_HTTP_TOKEN,
      httpPort: e.MCP_HTTP_PORT,
    },
  };

  validateCrossFieldRules(config);
  return Object.freeze(config);
}

function validateCrossFieldRules(config: FrameworkConfig): void {
  const issues: string[] = [];
  const { environment, security, mcp } = config;

  if (environment.name === 'prod' && !environment.readOnly) {
    issues.push('prod environment must be configured with "readOnly": true');
  }
  if (environment.name === 'prod' && environment.features.startDemoApp) {
    issues.push('prod environment cannot start the demo application');
  }
  if (security.allowProdWrites && environment.name === 'prod' && security.prodWriteAllowlist.length === 0) {
    issues.push('ALLOW_PROD_WRITES=true requires a non-empty PROD_WRITE_ALLOWLIST');
  }
  if (mcp.allowedEnvironments.includes('prod')) {
    issues.push(
      'MCP_ALLOWED_ENVIRONMENTS must not include prod (MCP tools may not execute against production)',
    );
  }
  if (issues.length > 0) {
    throw new ConfigurationError(`Invalid configuration:\n - ${issues.join('\n - ')}`, { issues });
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Resolves credentials for a role from APP_<ROLE>_USERNAME / APP_<ROLE>_PASSWORD.
 * Credentials are resolved lazily (only when a test needs them) so that suites
 * that do not authenticate can run without them. The role must be declared in
 * the environment file (least privilege: undeclared roles cannot be used).
 */
export function getCredentials(
  config: FrameworkConfig,
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): Credentials {
  if (!config.environment.roles.includes(role)) {
    throw new ConfigurationError(
      `Role "${role}" is not declared for environment "${config.environment.name}". Declared roles: ${config.environment.roles.join(', ')}`,
    );
  }
  const prefix = `APP_${role.toUpperCase()}`;
  const username = env[`${prefix}_USERNAME`]?.trim();
  const password = env[`${prefix}_PASSWORD`];
  const missing = [!username && `${prefix}_USERNAME`, !password && `${prefix}_PASSWORD`].filter(Boolean);
  if (missing.length > 0 || !username || !password) {
    throw new ConfigurationError(
      `Missing credentials for role "${role}". Set ${missing.join(' and ')} (in .env locally or as CI secrets).`,
    );
  }
  return { username, password };
}
