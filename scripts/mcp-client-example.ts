/**
 * Executable MCP client example.
 *
 *   npm run build && npm run mcp:example                 # framework server only
 *   npm run mcp:example -- --with-playwright-mcp         # also drive the official Playwright MCP
 *
 * Demonstrates: connecting to the custom automation server (STDIO), listing tools,
 * calling run_ui_tests, retrieving results, using the official Playwright MCP
 * server, and disconnecting cleanly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { killTree } from '../src/core/services/process.util.js';
import { ConnectionManager, loadMcpClientConfig, type McpServerConfig } from '../src/mcp/client/index.js';
import { paths } from '../src/utils/paths.js';
import { waitUntil } from '../src/utils/wait.util.js';

const withPlaywrightMcp = process.argv.includes('--with-playwright-mcp');

function frameworkServerConfig(base: McpServerConfig): McpServerConfig {
  // Prefer the compiled server (what MCP hosts use); fall back to tsx for development.
  if (existsSync(path.join(paths.root, 'dist', 'mcp', 'server', 'index.js'))) return base;
  console.log(
    'dist/ not found – starting the server from source via tsx (run "npm run build" for the compiled server)',
  );
  return { ...base, command: process.execPath, args: ['--import', 'tsx', 'src/mcp/server/index.ts'] };
}

async function main(): Promise<void> {
  const configs = loadMcpClientConfig().map((c) => {
    if (c.name === 'automation-framework') return frameworkServerConfig(c);
    if (c.name === 'playwright') return { ...c, enabled: withPlaywrightMcp };
    return c;
  });
  const manager = new ConnectionManager(configs);

  try {
    console.log('\n== Connecting ==');
    console.table(await manager.connectAll());

    const framework = await manager.get('automation-framework');
    console.log('server:', framework.serverInfo);

    console.log('\n== Tools ==');
    for (const tool of await framework.listTools())
      console.log(`- ${tool.name}: ${tool.description?.slice(0, 90)}…`);

    console.log('\n== get_framework_status ==');
    console.log(JSON.stringify(await framework.callToolJson('get_framework_status'), null, 2));

    console.log('\n== Invalid request is rejected client-side ==');
    try {
      await framework.callTool('run_ui_tests', { environment: 'prod' });
    } catch (error) {
      console.log('rejected:', (error as Error).message);
    }

    console.log('\n== run_ui_tests (smoke, chromium, local) ==');
    const run = await framework.callToolJson<{
      runId: string;
      status: string;
      summary?: { totals: unknown };
    }>('run_ui_tests', {
      environment: 'local',
      grep: '@smoke',
      project: 'chromium',
    });
    console.log({ runId: run.runId, status: run.status, totals: run.summary?.totals });

    console.log('\n== get_test_results ==');
    console.log(
      JSON.stringify(await framework.callToolJson('get_test_results', { runId: run.runId }), null, 2),
    );

    if (withPlaywrightMcp) {
      console.log('\n== Official Playwright MCP ==');
      demoApp = await ensureDemoApp();
      const playwright = await manager.get('playwright');
      console.log('tools:', (await playwright.listTools()).map((t) => t.name).join(', '));
      const nav = await playwright.callTool('browser_navigate', { url: 'http://localhost:4000/login' });
      const text = nav.content.find((c) => c.type === 'text');
      console.log(text && 'text' in text ? text.text.slice(0, 600) : nav);
      await playwright.callTool('browser_close', {});
    }
  } finally {
    console.log('\n== Disconnecting ==');
    await manager.disconnectAll();
    console.table(manager.status());
    if (demoApp) killTree(demoApp);
  }
}

let demoApp: ChildProcess | undefined;

/** Starts the bundled demo app when it is not already running (the official MCP browses it). */
async function ensureDemoApp(): Promise<ChildProcess | undefined> {
  const healthy = () =>
    fetch('http://localhost:4000/api/health', { signal: AbortSignal.timeout(1000) }).then(
      (r) => r.ok,
      () => false,
    );
  if (await healthy()) return undefined;
  const child = spawn(process.execPath, ['--import', 'tsx', 'demo-app/server.ts'], {
    cwd: paths.root,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitUntil(healthy, Boolean, { timeoutMs: 20_000, description: 'demo app start' });
  return child;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
