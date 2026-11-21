import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import * as z from 'zod';

import { loadConfig } from '../../../src/config/index.js';
import {
  buildPlaywrightArgs,
  TestExecutionService,
} from '../../../src/core/services/test-execution.service.js';
import { parseAriaSnapshot } from '../../../src/core/services/app-inspection.service.js';
import { FrameworkError } from '../../../src/core/exceptions/index.js';
import {
  exploreUserWorkflowInput,
  inspectApiEndpointInput,
  inspectApplicationInput,
  runTestsByTagInput,
  runUiTestsInput,
} from '../../../src/mcp/schemas/tool-inputs.js';
import { AuditLogger } from '../../../src/mcp/server/security/audit-logger.js';
import { registerGuardedTool } from '../../../src/mcp/server/security/guarded-tool.js';
import { ToolPolicy } from '../../../src/mcp/server/security/tool-policy.js';
import type { McpServerContext } from '../../../src/mcp/server/context.js';
import { createLogger } from '../../../src/utils/logger.js';
import { resolvePlaceholders, parseServerConfig } from '../../../src/mcp/client/mcp-config.js';

test.describe('MCP tool input validation', () => {
  test('run_ui_tests accepts valid input and applies defaults', () => {
    expect(runUiTestsInput.parse({ environment: 'qa' })).toEqual({ environment: 'qa', project: 'chromium' });
  });

  const rejected: Array<[string, z.ZodType, unknown]> = [
    ['production environment', runUiTestsInput, { environment: 'prod' }],
    ['unknown property', runUiTestsInput, { environment: 'qa', command: 'whoami' }],
    ['shell metacharacters in grep', runUiTestsInput, { environment: 'qa', grep: '@smoke; rm -rf /' }],
    ['backticks in grep', runUiTestsInput, { environment: 'qa', grep: '`id`' }],
    ['unknown browser', runUiTestsInput, { environment: 'qa', project: 'ie11' }],
    ['unknown tag', runTestsByTagInput, { environment: 'qa', tags: ['@everything'] }],
    [
      'too many tags',
      runTestsByTagInput,
      { environment: 'qa', tags: ['@smoke', '@api', '@ui', '@e2e', '@critical', '@negative'] },
    ],
    ['javascript: url', inspectApplicationInput, { url: 'javascript:alert(1)' }],
    ['file: url', inspectApplicationInput, { url: 'file:///etc/passwd' }],
    ['write method', inspectApiEndpointInput, { path: '/users', method: 'DELETE' }],
    ['path traversal characters', inspectApiEndpointInput, { path: '/users/../../admin?x=1' }],
    [
      'too many workflow steps',
      exploreUserWorkflowInput,
      {
        startUrl: '/',
        steps: Array.from({ length: 26 }, () => ({ action: 'click', target: { text: 'x' } })),
      },
    ],
  ];
  for (const [name, schema, input] of rejected) {
    test(`rejects ${name}`, () => {
      expect(schema.safeParse(input).success).toBe(false);
    });
  }

  test('tool schemas convert to JSON Schema for clients', () => {
    const json = z.toJSONSchema(runTestsByTagInput) as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(json.properties)).toEqual(['environment', 'tags', 'match', 'projects']);
    expect(json.additionalProperties).toBe(false);
  });
});

test.describe('test execution argument building', () => {
  test('builds a safe argument vector', () => {
    expect(
      buildPlaywrightArgs({
        label: 't',
        environment: 'local',
        paths: ['tests/ui'],
        projects: ['chromium'],
        grep: '@smoke|@critical',
        workers: 50,
        retries: 9,
      }),
    ).toEqual([
      'test',
      'tests/ui',
      '--project=chromium',
      '--grep',
      '@smoke|@critical',
      '--workers=8',
      '--retries=3',
    ]);
  });

  test('rejects paths outside tests/, unknown projects and unsafe grep', () => {
    expect(() => buildPlaywrightArgs({ label: 't', environment: 'local', paths: ['../secrets'] })).toThrow(
      /inside tests/,
    );
    expect(() => buildPlaywrightArgs({ label: 't', environment: 'local', paths: ['src'] })).toThrow(
      /inside tests/,
    );
    expect(() =>
      buildPlaywrightArgs({ label: 't', environment: 'local', projects: ['setup' as never] }),
    ).toThrow(/Unknown project/);
    expect(() => buildPlaywrightArgs({ label: 't', environment: 'local', grep: '$(whoami)' })).toThrow(
      /unsupported characters/,
    );
  });

  test('refuses environments outside the MCP allowlist before spawning anything', async () => {
    const service = new TestExecutionService({
      config: loadConfig({ env: { MCP_ALLOWED_ENVIRONMENTS: 'local' } }),
      logger: createLogger({ consoleLevel: 'silent', file: false }),
    });
    await expect(service.run({ label: 't', environment: 'qa' }, { timeoutMs: 1000 })).rejects.toThrow(
      /not allowed/,
    );
  });
});

test.describe('tool policy', () => {
  test('tool allowlist and environment allowlist', () => {
    const policy = new ToolPolicy(
      loadConfig({
        env: { MCP_ENABLED_TOOLS: 'get_test_results,run_api_tests', MCP_ALLOWED_ENVIRONMENTS: 'local,qa' },
      }),
    );
    expect(policy.isToolEnabled('run_api_tests')).toBe(true);
    expect(policy.isToolEnabled('explore_user_workflow')).toBe(false);
    expect(() => policy.assertEnvironmentAllowed('uat')).toThrow(/not permitted/);
    expect(policy.configFor('qa').environment.name).toBe('qa');
    expect(() => policy.configFor('staging')).toThrow(/not permitted/);
  });
});

test.describe('guarded tool wrapper', () => {
  type Callback = (
    args: unknown,
  ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

  function harness(env: NodeJS.ProcessEnv = {}) {
    const auditFile = path.join(mkdtempSync(path.join(tmpdir(), 'audit-')), 'audit.log');
    const config = loadConfig({ env: { MCP_TOOL_TIMEOUT_MS: '1000', ...env } });
    const registered = new Map<string, Callback>();
    const server = {
      registerTool: (name: string, _config: unknown, cb: Callback) => registered.set(name, cb),
    };
    const ctx = {
      config,
      policy: new ToolPolicy(config),
      audit: new AuditLogger(auditFile),
      logger: createLogger({ consoleLevel: 'silent', file: false }),
      transport: 'stdio',
    } as unknown as McpServerContext;
    const register = (name: string, handler: () => Promise<unknown>) =>
      registerGuardedTool(server as never, ctx, {
        name,
        title: name,
        description: name,
        inputSchema: z.object({}),
        handler,
      });
    const audit = () =>
      readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { registered, register, audit };
  }

  test('redacts secrets in results and audits success', async () => {
    const h = harness();
    h.register('t_ok', async () => ({ token: 'abc', note: 'Bearer secret-value-here' }));

    const result = await h.registered.get('t_ok')!({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).not.toContain('secret-value-here');
    expect(result.content[0]!.text).toContain('[REDACTED]');
    expect(h.audit()[0]).toMatchObject({ tool: 't_ok', outcome: 'success' });
  });

  test('times out long-running tools', async () => {
    const h = harness();
    h.register('t_slow', () => new Promise(() => undefined));

    const result = await h.registered.get('t_slow')!({});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('OPERATION_TIMEOUT');
    expect(h.audit()[0]).toMatchObject({ outcome: 'timeout' });
  });

  test('exposes framework errors but hides unexpected internals', async () => {
    const h = harness();
    h.register('t_known', () => Promise.reject(new FrameworkError('RUN_IN_PROGRESS', 'busy')));
    h.register('t_bug', () => Promise.reject(new Error('stack trace with C:\\internal\\path')));

    expect((await h.registered.get('t_known')!({})).content[0]!.text).toContain('RUN_IN_PROGRESS');
    const hidden = (await h.registered.get('t_bug')!({})).content[0]!.text;
    expect(hidden).toContain('INTERNAL_ERROR');
    expect(hidden).not.toContain('internal\\\\path');
  });

  test('disabled tools are never registered', () => {
    const h = harness({ MCP_ENABLED_TOOLS: 'other_tool' });
    expect(h.register('t_hidden', async () => 1)).toBe(false);
    expect(h.registered.has('t_hidden')).toBe(false);
  });
});

test.describe('MCP client configuration', () => {
  test('resolves ${VAR} placeholders only for enabled servers', () => {
    const http = parseServerConfig({
      name: 'http-x',
      transport: 'http',
      url: 'http://localhost/mcp',
      enabled: false,
      headers: { Authorization: 'Bearer ${NOPE_TOKEN}' },
    });
    expect(http.headers.Authorization).toBe('Bearer ${NOPE_TOKEN}');
    expect(resolvePlaceholders({ ...http, enabled: true }, { NOPE_TOKEN: 't0k' }).headers.Authorization).toBe(
      'Bearer t0k',
    );
    expect(() => resolvePlaceholders({ ...http, enabled: true }, {})).toThrow(/NOPE_TOKEN/);
    expect(() => parseServerConfig({ name: 'stdio-x', transport: 'stdio' })).toThrow(
      /command: required for stdio/,
    );
  });
});

test.describe('accessibility snapshot parsing', () => {
  test('extracts interactive elements with resilient locator suggestions', () => {
    const snapshot = [
      '- heading "Sign in" [level=1]',
      '- textbox "Username"',
      '- button "Sign in"',
      '- link "Create an account":',
      '  - /url: /register',
      '- button',
      '- button "Sign in"',
    ].join('\n');
    expect(parseAriaSnapshot(snapshot)).toEqual([
      { role: 'textbox', name: 'Username', suggestedLocator: "page.getByLabel('Username')" },
      { role: 'button', name: 'Sign in', suggestedLocator: "page.getByRole('button', { name: 'Sign in' })" },
      {
        role: 'link',
        name: 'Create an account',
        suggestedLocator: "page.getByRole('link', { name: 'Create an account' })",
      },
      {
        role: 'button',
        name: '',
        suggestedLocator: "page.getByRole('button') /* no accessible name – add a label or data-testid */",
      },
    ]);
  });
});
