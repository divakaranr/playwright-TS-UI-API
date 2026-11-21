import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import * as z from 'zod';

import { formatZodIssues } from '../../config/config.schema.js';
import { loadDotenvFiles } from '../../config/index.js';
import { ConfigurationError } from '../../core/exceptions/index.js';
import { paths } from '../../utils/paths.js';

export const mcpServerConfigSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    transport: z.enum(['stdio', 'http']),
    enabled: z.boolean().default(true),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.url().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    connectTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
    requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.transport === 'stdio' && !cfg.command)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'required for stdio' });
    if (cfg.transport === 'http' && !cfg.url)
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'required for http' });
  });

export type McpServerConfig = z.output<typeof mcpServerConfigSchema>;
export type McpServerConfigInput = z.input<typeof mcpServerConfigSchema>;

export const mcpClientConfigSchema = z.object({ servers: z.array(mcpServerConfigSchema).min(1) }).strict();

/**
 * Resolves `${VAR}` placeholders from the environment so secrets (tokens) stay
 * out of config files. Only enabled servers are resolved: a disabled server
 * never requires its variables.
 */
export function resolvePlaceholders(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  if (!config.enabled) return config;
  const missing = new Set<string>();
  const resolve = (value: string) =>
    value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const resolved = env[name];
      if (resolved === undefined || resolved === '') missing.add(name);
      return resolved ?? '';
    });
  const mapValues = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, resolve(v)]));
  const resolved = {
    ...config,
    args: config.args.map(resolve),
    env: mapValues(config.env),
    headers: mapValues(config.headers),
  };
  if (missing.size > 0) {
    throw new ConfigurationError(
      `MCP server "${config.name}" requires environment variable(s): ${[...missing].join(', ')}`,
    );
  }
  return resolved;
}

export function parseServerConfig(input: McpServerConfigInput): McpServerConfig {
  const result = mcpServerConfigSchema.safeParse(input);
  if (!result.success)
    throw new ConfigurationError(
      `Invalid MCP server config:\n - ${formatZodIssues(result.error).join('\n - ')}`,
    );
  return resolvePlaceholders(result.data);
}

/** Loads mcp/mcp-servers.json (or a given file) for the programmatic client. */
export function loadMcpClientConfig(
  file: string = path.join(paths.root, 'mcp', 'mcp-servers.json'),
): McpServerConfig[] {
  loadDotenvFiles();
  if (!existsSync(file)) throw new ConfigurationError(`MCP client config not found: ${file}`);
  const result = mcpClientConfigSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success)
    throw new ConfigurationError(
      `Invalid MCP client config ${file}:\n - ${formatZodIssues(result.error).join('\n - ')}`,
    );
  return result.data.servers.map((server) => resolvePlaceholders(server));
}
