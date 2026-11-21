import * as z from 'zod';

export const ENVIRONMENTS = ['local', 'dev', 'qa', 'uat', 'staging', 'prod'] as const;
export const environmentNameSchema = z.enum(ENVIRONMENTS);
export type EnvironmentName = z.infer<typeof environmentNameSchema>;

export const LLM_PROVIDERS = ['none', 'openai', 'anthropic', 'openrouter', 'ollama'] as const;
export const llmProviderNameSchema = z.enum(LLM_PROVIDERS);
export type LlmProviderName = z.infer<typeof llmProviderNameSchema>;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;

const roleName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'role names must be lower_snake_case');

/** Write operations are expressed as "METHOD /path" with optional `*` wildcards, e.g. "POST /users". */
const writeOperation = z
  .string()
  .regex(/^(POST|PUT|PATCH) \/[A-Za-z0-9/_*{}.-]*$/, 'expected "METHOD /path" (POST|PUT|PATCH only)');

/** Schema of config/environments/<env>.json */
export const environmentFileSchema = z
  .object({
    name: environmentNameSchema,
    description: z.string().optional(),
    baseUrl: z.url(),
    apiBaseUrl: z.url(),
    readOnly: z.boolean().default(false),
    allowedWriteOperations: z.array(writeOperation).default([]),
    roles: z.array(roleName).min(1),
    auth: z
      .object({
        loginPath: z.string().startsWith('/'),
        refreshPath: z.string().startsWith('/'),
        tokenPath: z.string().startsWith('/'),
      })
      .strict(),
    timeouts: z
      .object({
        testMs: z.number().int().positive(),
        expectMs: z.number().int().positive(),
        actionMs: z.number().int().positive(),
        navigationMs: z.number().int().positive(),
        apiMs: z.number().int().positive(),
      })
      .strict(),
    api: z.object({ responseTimeThresholdMs: z.number().int().positive() }).strict(),
    features: z.object({ startDemoApp: z.boolean().default(false) }).strict(),
  })
  .strict();
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== '' ? value.trim() : undefined));

const optionalUrl = optionalString.pipe(z.url().optional());

const optionalInt = (min: number, max: number) =>
  optionalString
    .transform((value) => (value === undefined ? undefined : Number(value)))
    .pipe(z.number().int().min(min).max(max).optional());

const bool = (defaultValue: boolean) =>
  optionalString.pipe(z.stringbool().optional()).transform((value) => value ?? defaultValue);

/** Schema of the process environment variables the framework reads. */
export const processEnvSchema = z.object({
  TEST_ENV: optionalString.pipe(environmentNameSchema.optional()).transform((v) => v ?? 'local'),
  BASE_URL: optionalUrl,
  API_BASE_URL: optionalUrl,
  CI: bool(false),
  WORKERS: optionalInt(1, 64),
  RETRIES: optionalInt(0, 5),
  HEADLESS: bool(true),
  MOBILE: bool(false),
  ALLOW_PROD_WRITES: bool(false),
  PROD_WRITE_ALLOWLIST: csv,
  API_CLIENT_ID: optionalString,
  API_CLIENT_SECRET: optionalString,
  LOG_LEVEL: optionalString.pipe(logLevelSchema.optional()).transform((v) => v ?? 'info'),
  LOG_CONSOLE_LEVEL: optionalString.pipe(logLevelSchema.optional()).transform((v) => v ?? 'warn'),
  LOG_DESTINATION: optionalString
    .pipe(z.enum(['stdout', 'stderr']).optional())
    .transform((v) => v ?? 'stdout'),
  LOG_FILE: optionalString,
  LLM_PROVIDER: optionalString.pipe(llmProviderNameSchema.optional()).transform((v) => v ?? 'none'),
  LLM_MODEL: optionalString,
  LLM_API_KEY: optionalString,
  LLM_BASE_URL: optionalUrl,
  LLM_TIMEOUT_MS: optionalInt(1000, 600_000).transform((v) => v ?? 60_000),
  LLM_MAX_RETRIES: optionalInt(0, 10).transform((v) => v ?? 2),
  MCP_ALLOWED_ENVIRONMENTS: csv.pipe(z.array(environmentNameSchema)),
  MCP_TOOL_TIMEOUT_MS: optionalInt(1000, 3_600_000).transform((v) => v ?? 600_000),
  MCP_ENABLED_TOOLS: csv,
  MCP_HTTP_TOKEN: optionalString,
  MCP_HTTP_PORT: optionalInt(1, 65535).transform((v) => v ?? 3333),
});
export type ProcessEnv = z.infer<typeof processEnvSchema>;

/** The fully resolved, validated framework configuration. */
export interface FrameworkConfig {
  readonly environment: EnvironmentFile;
  readonly execution: {
    readonly ci: boolean;
    readonly workers: number | undefined;
    readonly retries: number;
    readonly headless: boolean;
    readonly mobile: boolean;
  };
  readonly security: {
    readonly allowProdWrites: boolean;
    readonly prodWriteAllowlist: readonly string[];
  };
  readonly apiClient: {
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
  };
  readonly logging: {
    readonly level: LogLevel;
    readonly consoleLevel: LogLevel;
    readonly destination: 'stdout' | 'stderr';
    readonly file: string | undefined;
  };
  readonly llm: {
    readonly provider: LlmProviderName;
    readonly model: string | undefined;
    readonly apiKey: string | undefined;
    readonly baseUrl: string | undefined;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };
  readonly mcp: {
    readonly allowedEnvironments: readonly EnvironmentName[];
    readonly toolTimeoutMs: number;
    readonly enabledTools: readonly string[];
    readonly httpToken: string | undefined;
    readonly httpPort: number;
  };
}

/** Formats Zod issues into human-friendly lines for fail-fast error messages. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}
