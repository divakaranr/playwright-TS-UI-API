import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';

import { ENVIRONMENTS, loadConfig } from '../../../config/index.js';
import { paths } from '../../../utils/paths.js';
import { emptyInput, getAvailableTestSuitesInput } from '../../schemas/tool-inputs.js';
import type { McpServerContext } from '../context.js';
import { registerGuardedTool } from '../security/guarded-tool.js';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

/** Environment overview without secrets (credentials are never part of it). */
export function describeEnvironments(ctx: McpServerContext) {
  return ENVIRONMENTS.map((name) => {
    const { BASE_URL: _b, API_BASE_URL: _a, ...env } = process.env;
    const config =
      name === ctx.config.environment.name ? ctx.config : loadConfig({ env: { ...env, TEST_ENV: name } });
    return {
      name,
      description: config.environment.description,
      baseUrl: config.environment.baseUrl,
      apiBaseUrl: config.environment.apiBaseUrl,
      readOnly: config.environment.readOnly,
      roles: config.environment.roles,
      allowedForMcp: ctx.config.mcp.allowedEnvironments.includes(name),
      isServerDefault: name === ctx.config.environment.name,
    };
  });
}

export function registerFrameworkTools(server: McpServer, ctx: McpServerContext): void {
  registerGuardedTool(server, ctx, {
    name: 'get_supported_environments',
    title: 'List environments',
    description:
      'List configured environments with URLs, read-only status, roles and whether MCP tools may target them.',
    inputSchema: emptyInput,
    annotations: READ_ONLY,
    timeoutMs: 10_000,
    handler: () => Promise.resolve({ environments: describeEnvironments(ctx) }),
  });

  registerGuardedTool(server, ctx, {
    name: 'get_available_test_suites',
    title: 'List test suites',
    description:
      'Discover the test catalogue (tests per project, per tag and per file) without executing tests.',
    inputSchema: getAvailableTestSuitesInput,
    annotations: READ_ONLY,
    timeoutMs: 150_000,
    handler: ({ refresh }) => ctx.catalog.getCatalog({ refresh }),
  });

  registerGuardedTool(server, ctx, {
    name: 'get_framework_status',
    title: 'Framework status',
    description:
      'Report framework health: versions, active environment, application reachability, LLM configuration ' +
      '(never the key), MCP policy, active test run and the latest results summary.',
    inputSchema: emptyInput,
    annotations: READ_ONLY,
    timeoutMs: 20_000,
    handler: async () => {
      const pkg = JSON.parse(readFileSync(path.join(paths.root, 'package.json'), 'utf8')) as {
        version: string;
        dependencies: Record<string, string>;
      };
      const health = await fetch(`${ctx.config.environment.apiBaseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => ({ reachable: r.ok, status: r.status }))
        .catch((e: unknown) => ({ reachable: false, error: e instanceof Error ? e.message : String(e) }));
      let lastRun: unknown;
      try {
        const summary = ctx.results.getSummary();
        lastRun = { status: summary.status, totals: summary.totals, startedAt: summary.startedAt };
      } catch {
        lastRun = 'no local results yet';
      }
      return {
        framework: {
          version: pkg.version,
          node: process.version,
          playwright: pkg.dependencies['@playwright/test'],
          mcpSdk: pkg.dependencies['@modelcontextprotocol/server'],
        },
        environment: {
          name: ctx.config.environment.name,
          baseUrl: ctx.config.environment.baseUrl,
          readOnly: ctx.config.environment.readOnly,
        },
        application: health,
        llm: {
          provider: ctx.config.llm.provider,
          model: ctx.config.llm.model ?? null,
          configured: ctx.llm() !== undefined,
        },
        mcp: {
          transport: ctx.transport,
          allowedEnvironments: ctx.config.mcp.allowedEnvironments,
          toolTimeoutMs: ctx.config.mcp.toolTimeoutMs,
          toolAllowlist: ctx.config.mcp.enabledTools.length ? ctx.config.mcp.enabledTools : 'all',
        },
        activeRun: ctx.execution.activeRun ?? null,
        lastRun,
      };
    },
  });
}
