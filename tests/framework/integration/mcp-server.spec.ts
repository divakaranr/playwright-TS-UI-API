import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { killTree } from '../../../src/core/services/process.util.js';
import { ConnectionManager, McpClient, parseServerConfig } from '../../../src/mcp/client/index.js';
import { paths } from '../../../src/utils/paths.js';
import { waitUntil } from '../../../src/utils/wait.util.js';

const EXPECTED_TOOLS = [
  'run_ui_tests',
  'run_api_tests',
  'run_e2e_tests',
  'run_smoke_tests',
  'run_tests_by_tag',
  'inspect_application',
  'inspect_page_elements',
  'explore_user_workflow',
  'inspect_api_endpoint',
  'generate_ui_test',
  'generate_api_test',
  'generate_test_from_requirement',
  'get_test_results',
  'inspect_test_failure',
  'analyze_failure_logs',
  'get_execution_trace_metadata',
  'get_supported_environments',
  'get_available_test_suites',
  'get_framework_status',
];

const auditLog = path.join(mkdtempSync(path.join(tmpdir(), 'mcp-audit-')), 'audit.log');

/**
 * The suite owns its own demo-app instance on a free port, so it neither depends on whatever listens on :4000
 * nor on a developer's .env. The MCP SDK passes only a minimal environment (PATH, …) to STDIO servers, so the
 * demo app's URL and its built-in demo users (see demo-app/store.ts – public demo values, not secrets) are
 * handed to the server explicitly. Without them the server fails in CI with "Missing credentials for role".
 */
const DEMO_PORT = 4300 + (process.pid % 300);
const DEMO_URL = `http://localhost:${DEMO_PORT}`;
const DEMO_APP_ENV: Record<string, string> = {
  BASE_URL: DEMO_URL,
  API_BASE_URL: `${DEMO_URL}/api`,
  // Nested test runs (run_* tools) reuse this instance instead of starting one on the same port.
  PW_REUSE_SERVER: 'true',
  APP_ADMIN_USERNAME: 'admin@demo.local',
  APP_ADMIN_PASSWORD: 'Admin#12345',
  APP_VIEWER_USERNAME: 'viewer@demo.local',
  APP_VIEWER_PASSWORD: 'Viewer#12345',
  API_CLIENT_ID: 'demo-client',
  API_CLIENT_SECRET: 'demo-client-secret',
};

async function startDemoApp(): Promise<ChildProcess> {
  const app = spawn(process.execPath, ['--import', 'tsx', 'demo-app/server.ts'], {
    cwd: paths.root,
    env: { ...process.env, DEMO_APP_PORT: String(DEMO_PORT) },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitUntil(
    () =>
      fetch(`${DEMO_URL}/api/health`).then(
        (r) => r.ok,
        () => false,
      ),
    Boolean,
    { timeoutMs: 30_000, description: 'demo app start' },
  );
  return app;
}

/** Server started from source through tsx, exactly like `npm run mcp:server:dev`. */
const stdioConfig = (env: Record<string, string> = {}) =>
  parseServerConfig({
    name: 'framework-under-test',
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server/index.ts'],
    env: { TEST_ENV: 'local', MCP_AUDIT_LOG: auditLog, LLM_PROVIDER: 'none', ...DEMO_APP_ENV, ...env },
    connectTimeoutMs: 60_000,
    requestTimeoutMs: 300_000,
  });

test.describe('custom MCP server over STDIO', () => {
  test.describe.configure({ mode: 'default', timeout: 300_000 });
  const client = new McpClient(stdioConfig());
  let demoApp: ChildProcess | undefined;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    demoApp = await startDemoApp();
    await client.connect();
  });
  test.afterAll(async () => {
    await client.close();
    if (demoApp) killTree(demoApp);
  });

  test('discovers all tools, resources and prompts', async () => {
    expect(client.serverInfo?.name).toBe('enterprise-automation-framework');
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description, `${tool.name} has a description`).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    expect((await client.listResources()).map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        'framework://environments',
        'framework://api/openapi',
        'framework://docs/architecture',
        'framework://test-suites',
      ]),
    );
    expect((await client.listPrompts()).map((p) => p.name).sort()).toEqual([
      'analyze_failed_tests',
      'explore_business_workflow',
      'generate_api_test_scenarios',
      'generate_ui_tests_from_requirements',
      'identify_regression_gaps',
    ]);
  });

  test('reads resources and prompts', async () => {
    const environments = JSON.parse(await client.readResource('framework://environments')) as Array<{
      name: string;
      allowedForMcp: boolean;
    }>;
    expect(environments.find((e) => e.name === 'prod')).toMatchObject({ allowedForMcp: false });
    expect(await client.readResource('framework://api/openapi')).toContain('"openapi": "3.1.0"');

    const prompt = await client.getPrompt('analyze_failed_tests', { runId: 'abc-123' });
    const text = prompt.messages[0]?.content;
    expect(text && 'text' in text ? text.text : '').toContain('get_test_results');
  });

  test('framework information tools return structured data', async () => {
    const envs = await client.callToolJson<{ environments: Array<{ name: string }> }>(
      'get_supported_environments',
    );
    expect(envs.environments.map((e) => e.name)).toEqual(['local', 'dev', 'qa', 'uat', 'staging', 'prod']);

    const status = await client.callToolJson<{ environment: { name: string }; llm: { configured: boolean } }>(
      'get_framework_status',
    );
    expect(status.environment.name).toBe('local');
    expect(status.llm.configured).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/password|apiKey/i);
  });

  test('invalid tool requests are rejected on the client and on the server', async () => {
    await expect(client.callTool('run_ui_tests', { environment: 'prod' })).rejects.toThrow(
      /Invalid arguments/,
    );
    await expect(client.callTool('delete_everything', {})).rejects.toThrow(/does not expose tool/);

    // Bypass client validation: the server must still reject (prod is not representable, extra keys are refused).
    const server = await client
      .callTool('run_ui_tests', { environment: 'prod', shell: 'rm -rf /' }, { skipValidation: true })
      .then((r) => ({ isError: r.isError === true, text: JSON.stringify(r.content) }))
      .catch((error: unknown) => ({ isError: true, text: String(error) }));
    expect(server.isError).toBe(true);
  });

  test('environment policy denies non-allowed environments and is audited', async () => {
    const result = await client.callTool('run_api_tests', { environment: 'uat' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('ENVIRONMENT_POLICY_VIOLATION');
    await waitUntil(
      async () => readFileSync(auditLog, 'utf8'),
      (log) => log.includes('"outcome":"denied"'),
      { timeoutMs: 5000 },
    );
  });

  test('executes a real test run and returns its results', async () => {
    const run = await client.callToolJson<{
      runId: string;
      status: string;
      summary: { totals: { total: number; passed: number } };
    }>('run_tests_by_tag', { environment: 'local', tags: ['@prod-safe'], projects: ['api'] });
    expect(run.status).toBe('passed');
    expect(run.summary.totals).toMatchObject({ total: 1, passed: 1 });

    const results = await client.callToolJson<{ summary: { status: string } }>('get_test_results', {
      runId: run.runId,
    });
    expect(results.summary.status).toBe('passed');
    const failures = await client.callToolJson<{ failures: unknown[] }>('inspect_test_failure', {
      runId: run.runId,
    });
    expect(failures.failures).toEqual([]);
  });

  test('inspects the application and API read-only', async () => {
    const elements = await client.callToolJson<{
      interactiveElements: Array<{ role: string; name: string; suggestedLocator: string }>;
    }>('inspect_page_elements', { url: '/login' });
    expect(elements.interactiveElements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'button',
          name: 'Sign in',
          suggestedLocator: "page.getByRole('button', { name: 'Sign in' })",
        }),
      ]),
    );

    const api = await client.callToolJson<{ status: number; topLevelShape: Record<string, string> }>(
      'inspect_api_endpoint',
      { path: '/users', role: 'viewer', query: { pageSize: '1' } },
    );
    expect(api.status).toBe(200);
    expect(api.topLevelShape).toMatchObject({ data: 'array(1)', total: 'number' });

    const offOrigin = await client.callTool('inspect_application', { url: 'https://example.org/' });
    expect(offOrigin.isError).toBe(true);
  });

  test('generates reviewable drafts without an LLM', async () => {
    const ui = await client.callToolJson<{ code: string; reviewRequired: boolean }>('generate_ui_test', {
      feature: 'Password reset',
      requirementId: 'REQ-42',
      scenarios: [
        {
          title: 'user requests a reset link',
          steps: ['open login', 'click forgot password'],
          expectedResults: ['confirmation shown'],
        },
      ],
    });
    expect(ui.reviewRequired).toBe(true);
    expect(ui.code).toContain('GENERATED DRAFT');
    expect(ui.code).toContain('test.fixme(true');

    const api = await client.callToolJson<{ source: string; scenarios: Array<{ expectedStatus: number }> }>(
      'generate_api_test',
      { method: 'POST', path: '/users' },
    );
    expect(api.source).toBe('baseline');
    expect(api.scenarios.map((s) => s.expectedStatus)).toEqual(
      expect.arrayContaining([201, 400, 401, 403, 409]),
    );

    const llmOnly = await client.callTool('generate_test_from_requirement', {
      title: 'Login',
      userStory: 'As a user I want to log in securely',
      acceptanceCriteria: [{ id: 'AC-1', text: 'valid login works' }],
    });
    expect(llmOnly.isError).toBe(true);
    expect(JSON.stringify(llmOnly.content)).toContain('LLM_NOT_CONFIGURED');
  });
});

test.describe('MCP client resilience', () => {
  test.describe.configure({ timeout: 120_000 });

  test('detects a server crash and reconnects on next use', async () => {
    const manager = new ConnectionManager([stdioConfig()], { autoReconnect: true });
    try {
      await manager.connectAll();
      const first = await manager.get('framework-under-test');
      const disconnected = new Promise<string>((resolve) => first.onDisconnect(resolve));

      process.kill(first.processId!);

      expect(await disconnected).toBeTruthy();
      expect(first.state).toBe('disconnected');
      await expect(first.callTool('get_framework_status')).rejects.toThrow(/not connected/);

      const again = await manager.get('framework-under-test');
      expect(again.isConnected).toBe(true);
      expect((await again.listTools()).length).toBe(EXPECTED_TOOLS.length);
    } finally {
      await manager.disconnectAll();
    }
  });

  test('connection failures surface as typed errors within the timeout', async () => {
    const client = new McpClient(
      parseServerConfig({
        name: 'broken',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        connectTimeoutMs: 2000,
      }),
    );
    const started = Date.now();
    await expect(client.connect()).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
    expect(Date.now() - started).toBeLessThan(15_000);
    await client.close();
  });
});

test.describe('custom MCP server over Streamable HTTP', () => {
  test.describe.configure({ timeout: 120_000 });
  const token = 'test-token-0123456789abcdef0123456789abcdef';
  const port = 3400 + (process.pid % 500);
  let server: ChildProcess;

  test.beforeAll(async () => {
    server = spawn(process.execPath, ['--import', 'tsx', 'src/mcp/server/http.ts'], {
      cwd: paths.root,
      env: {
        ...process.env,
        MCP_HTTP_TOKEN: token,
        MCP_HTTP_PORT: String(port),
        MCP_AUDIT_LOG: auditLog,
        LOG_CONSOLE_LEVEL: 'silent',
      },
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    await waitUntil(
      () =>
        fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }).then(
          (r) => r.status,
          () => 0,
        ),
      (status) => status === 401,
      { timeoutMs: 60_000, description: 'HTTP MCP server start' },
    );
  });
  test.afterAll(() => killTree(server));

  test('requires a bearer token', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(response.status).toBe(401);
    const client = new McpClient(
      parseServerConfig({
        name: 'http-anon',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        connectTimeoutMs: 5000,
      }),
    );
    await expect(client.connect()).rejects.toMatchObject({ code: 'MCP_CONNECT_FAILED' });
  });

  test('authorised clients can discover and call tools', async () => {
    const client = new McpClient(
      parseServerConfig({
        name: 'http-auth',
        transport: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    try {
      await client.connect();
      expect((await client.listTools()).length).toBe(EXPECTED_TOOLS.length);
      const envs = await client.callToolJson<{ environments: unknown[] }>('get_supported_environments');
      expect(envs.environments).toHaveLength(6);
    } finally {
      await client.close();
    }
  });
});
