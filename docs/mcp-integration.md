# MCP integration

Two MCP servers, both optional for normal test execution:

| Server                                                             | Purpose                                                                                                                                             | Transport                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Official Playwright MCP** (`@playwright/mcp`, pinned **0.0.85**) | Free-form browser exploration by an LLM: navigate, accessibility snapshots, click/fill, screenshots, console/network.                               | STDIO                                            |
| **Framework MCP server** (`src/mcp/server`)                        | Governed access to framework capabilities: run approved suites, inspect results/traces, analyse failures, inspect pages/APIs, generate test drafts. | STDIO (default), Streamable HTTP (authenticated) |

Built on the official TypeScript SDK **v2** (`@modelcontextprotocol/server` / `@modelcontextprotocol/client` 2.4.0,
Zod v4 schemas, `serveStdio`, `createMcpHandler`).

## Start the servers

```bash
npm run build                 # compiles dist/ (MCP hosts run the compiled server)
npm run mcp:server            # node dist/mcp/server/index.js (STDIO – normally launched by the host)
npm run mcp:server:dev        # from source via tsx
npm run mcp:playwright        # official Playwright MCP, headless + isolated
MCP_HTTP_TOKEN=$(openssl rand -hex 32) npm run mcp:http   # Streamable HTTP on 127.0.0.1:3333/mcp
npm run mcp:example -- --with-playwright-mcp               # executable client example (both servers)
```

## Host configuration

The server reads `.env`/environment variables from the project root regardless of the host's working directory.
Use absolute paths if your host does not start servers in the project folder.

**Claude Code** – project-scoped `.mcp.json` (committed; Claude Code asks each user to approve it):

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.85", "--isolated"] },
    "automation-framework": {
      "command": "node",
      "args": ["./dist/mcp/server/index.js"],
      "env": { "TEST_ENV": "local" }
    }
  }
}
```

or via CLI: `claude mcp add playwright -- npx -y @playwright/mcp@0.0.85 --isolated` and
`claude mcp add automation-framework -e TEST_ENV=local -- node ./dist/mcp/server/index.js`.

**Cursor** – `.cursor/mcp.json` with the same `mcpServers` object as above.

**VS Code / GitHub Copilot (agent mode)** – `.vscode/mcp.json`:

```json
{
  "servers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.85", "--isolated"]
    },
    "automation-framework": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/mcp/server/index.js"],
      "env": { "TEST_ENV": "local" }
    }
  }
}
```

**Other hosts** – any client supporting STDIO servers: command `node`, args `dist/mcp/server/index.js`. For remote
team access use the HTTP server behind TLS with `Authorization: Bearer <MCP_HTTP_TOKEN>`
(see `mcp/mcp-config.example.json`, `mcp/mcp-servers.json`).

Pin `@playwright/mcp` (it is also a dependency, so `node node_modules/@playwright/mcp/cli.js` uses the lockfile
version). Upgrade deliberately and review its tool list – recent versions expose `browser_run_code_unsafe`; use
`--isolated`, run against non-production environments only, and consider host-side tool approval.

## Tools (framework server)

| Group          | Tools                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Execution      | `run_ui_tests`, `run_api_tests`, `run_e2e_tests`, `run_smoke_tests`, `run_tests_by_tag`            |
| Exploration    | `inspect_application`, `inspect_page_elements`, `explore_user_workflow`, `inspect_api_endpoint`    |
| Generation     | `generate_ui_test`, `generate_api_test`, `generate_test_from_requirement`                          |
| Debugging      | `get_test_results`, `inspect_test_failure`, `analyze_failure_logs`, `get_execution_trace_metadata` |
| Framework info | `get_supported_environments`, `get_available_test_suites`, `get_framework_status`                  |

Resources: `framework://docs/architecture`, `framework://environments`, `framework://test-suites`,
`framework://docs/application`, `framework://api/openapi`, `framework://docs/execution-guidelines`.

Prompts: `generate_ui_tests_from_requirements`, `generate_api_test_scenarios`, `analyze_failed_tests`,
`explore_business_workflow`, `identify_regression_gaps`.

## Security controls

| Control                   | Implementation                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Strict input validation   | Zod schemas (`src/mcp/schemas/tool-inputs.ts`), `.strict()`, bounded/pattern-restricted strings.                                        |
| No shell / arbitrary code | Test runs spawn `node <playwright cli>` with an argument array; projects, paths and tags are allow-listed; grep is pattern-restricted.  |
| Environment restrictions  | `prod` is not representable in tool schemas; `MCP_ALLOWED_ENVIRONMENTS` (default `local,dev,qa`); config rejects prod in the allowlist. |
| URL / origin restrictions | Inspection tools only reach the environment's own origins. API inspection is GET/HEAD/OPTIONS only.                                     |
| Tool allowlisting         | `MCP_ENABLED_TOOLS` – disabled tools are not registered (not discoverable).                                                             |
| Timeouts                  | Per-tool timeout (≤ `MCP_TOOL_TIMEOUT_MS`) with cancellation and process-tree kill.                                                     |
| Concurrency               | One test run at a time per server.                                                                                                      |
| Output redaction          | Every result is deep-sanitised and size-limited; internal errors are hidden (`INTERNAL_ERROR`).                                         |
| Prompt-injection defence  | Page/API content is marked untrusted; server instructions and prompts tell the model never to follow embedded instructions.             |
| Audit                     | `logs/mcp-audit.log` (JSONL): tool, redacted args, outcome (`success/error/denied/timeout`), duration, transport.                       |
| HTTP transport            | Mandatory 32+ char bearer token (constant-time compare), localhost bind by default, Origin allowlist, body size limit.                  |
| Drafts                    | Generated code is written only to `generated-tests/` (git-ignored, outside `testDir`).                                                  |

## Programmatic client

```typescript
const manager = new ConnectionManager(loadMcpClientConfig(), { autoReconnect: true });
await manager.connectAll(); // per-server status, failures isolated
const framework = await manager.get('automation-framework');
const tools = await framework.listTools(); // dynamic discovery
const run = await framework.callToolJson('run_ui_tests', { environment: 'local', grep: '@smoke' });
const results = await framework.callToolJson('get_test_results', { runId: run.runId });
await manager.disconnectAll();
```

`McpClient.callTool` validates the tool name against discovered tools and the arguments against the tool's
advertised JSON Schema (`z.fromJSONSchema`) **before** sending. Connection timeouts, request timeouts and
server disconnects (state + `onDisconnect` listeners; lazy reconnect in the manager) are handled.
