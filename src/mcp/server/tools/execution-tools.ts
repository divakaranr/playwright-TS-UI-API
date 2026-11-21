import type { McpServer } from '@modelcontextprotocol/server';

import type { RunnableProject } from '../../../core/services/test-execution.service.js';
import {
  runApiTestsInput,
  runE2eTestsInput,
  runSmokeTestsInput,
  runTestsByTagInput,
  runUiTestsInput,
} from '../../schemas/tool-inputs.js';
import type { McpServerContext } from '../context.js';
import { registerGuardedTool } from '../security/guarded-tool.js';

const RUN_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function registerExecutionTools(server: McpServer, ctx: McpServerContext): void {
  registerGuardedTool(server, ctx, {
    name: 'run_ui_tests',
    title: 'Run UI tests',
    description:
      'Execute the approved UI regression suite (tests/ui) in one browser against an allowed environment. ' +
      'Returns pass/fail totals, failures and the run id for follow-up debugging tools.',
    inputSchema: runUiTestsInput,
    annotations: RUN_ANNOTATIONS,
    handler: ({ environment, grep, project }, signal) =>
      ctx.execution.run(
        {
          label: 'run_ui_tests',
          environment,
          paths: ['tests/ui'],
          projects: [project],
          ...(grep ? { grep } : {}),
        },
        { timeoutMs: ctx.config.mcp.toolTimeoutMs, signal },
      ),
  });

  registerGuardedTool(server, ctx, {
    name: 'run_api_tests',
    title: 'Run API tests',
    description: 'Execute the API test project (tests/api) against an allowed environment.',
    inputSchema: runApiTestsInput,
    annotations: RUN_ANNOTATIONS,
    handler: ({ environment, grep }, signal) =>
      ctx.execution.run(
        { label: 'run_api_tests', environment, projects: ['api'], ...(grep ? { grep } : {}) },
        { timeoutMs: ctx.config.mcp.toolTimeoutMs, signal },
      ),
  });

  registerGuardedTool(server, ctx, {
    name: 'run_e2e_tests',
    title: 'Run end-to-end tests',
    description: 'Execute hybrid UI+API business workflows (tests/e2e and tests/integration) in one browser.',
    inputSchema: runE2eTestsInput,
    annotations: RUN_ANNOTATIONS,
    handler: ({ environment, grep, project }, signal) =>
      ctx.execution.run(
        {
          label: 'run_e2e_tests',
          environment,
          paths: ['tests/e2e', 'tests/integration'],
          projects: [project],
          ...(grep ? { grep } : {}),
        },
        { timeoutMs: ctx.config.mcp.toolTimeoutMs, signal },
      ),
  });

  registerGuardedTool(server, ctx, {
    name: 'run_smoke_tests',
    title: 'Run smoke tests',
    description:
      'Execute all @smoke tests (API, and UI in one browser unless includeUi=false). Fast health signal.',
    inputSchema: runSmokeTestsInput,
    annotations: RUN_ANNOTATIONS,
    handler: ({ environment, includeUi, project }, signal) =>
      ctx.execution.run(
        {
          label: 'run_smoke_tests',
          environment,
          grep: '@smoke',
          projects: includeUi ? ['api', project] : ['api'],
        },
        { timeoutMs: ctx.config.mcp.toolTimeoutMs, signal },
      ),
  });

  registerGuardedTool(server, ctx, {
    name: 'run_tests_by_tag',
    title: 'Run tests by tag',
    description:
      'Execute tests selected by framework tags (e.g. @critical, @negative). match="any" selects tests with any tag; ' +
      '"all" requires every tag. Defaults to the api and chromium projects.',
    inputSchema: runTestsByTagInput,
    annotations: RUN_ANNOTATIONS,
    handler: ({ environment, tags, match, projects }, signal) => {
      const grep = match === 'any' ? tags.join('|') : tags.map((t) => `(?=.*${t})`).join('');
      const selected: RunnableProject[] = projects ?? ['api', 'chromium'];
      return ctx.execution.run(
        {
          label: 'run_tests_by_tag',
          environment,
          grep: match === 'any' ? grep : `^${grep}`,
          projects: selected,
        },
        { timeoutMs: ctx.config.mcp.toolTimeoutMs, signal },
      );
    },
  });
}
