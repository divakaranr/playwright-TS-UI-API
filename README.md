# Playwright Enterprise Framework (TypeScript · UI · API · MCP · LLM)

A reusable automation platform for UI, API and hybrid testing built on **Playwright Test** and **strict
TypeScript**, with a governed **MCP server/client**, the official **Playwright MCP**, and optional **LLM**
assistance (OpenAI, Anthropic, OpenRouter, Ollama) for test generation, exploration and failure analysis.

Deterministic tests never depend on AI or MCP: `npm run test:ui` runs with no LLM, no MCP server and no API keys.

## Quick start

```bash
npm ci
npx playwright install chromium firefox webkit
cp .env.example .env          # demo credentials for the bundled app are pre-filled
npm run test:smoke            # starts the local demo app automatically
npm run report
```

Requires Node.js 22.13+. See [docs/setup.md](docs/setup.md).

## Prompt-driven testing (Test Console)

A standalone local web app: enter a website URL and a plain-language prompt, and an LLM tests the site in a real
browser through the official Playwright MCP, streaming every step with screenshots.

```bash
npm run console   # → http://localhost:4100
```

1. **⚙ Model settings** (opens automatically on first start)
   - **Provider** dropdown – OpenRouter, OpenAI, Anthropic, Ollama (local).
   - **API key** – password field; verified with the provider before saving, afterwards shown only as `••••1a2b`.
   - **Model** dropdown – loaded live from the provider, only models that support tool calling, with a filter box.
   - **Verify & save** stores provider, model and key **AES-256-GCM encrypted** in `.secrets/llm-settings.enc.json`;
     the master key lives outside the project in `~/.playwright-test-console/master.key`. Until you save,
     `LLM_*` from `.env` is used as a fallback (the header shows `(.env)` instead of 🔒).
2. **Website URL** + **What should be tested?** → **Start testing**.
3. Choose a mode:
   - **Explore & report** – the AI tests the site live and writes a Markdown report.
   - **Generate & run tests** – Playwright tests are written to `generated-tests/console/<run-id>/` for review and
     executed; HTML results are linked in the UI.

**Guard rails:** URL validation with SSRF protection (private/metadata addresses blocked, optional host allowlist),
prompt sanitisation (markup, scripts, shell commands, prompt-injection phrases and off-topic requests are rejected
before anything reaches the model), a Playwright-testing-only system prompt with refusal, a restricted browser tool
set locked to the target origin, validation of generated test code, secret redaction and audit logging. The server
binds to `127.0.0.1` and rejects foreign Host/Origin headers.

Optional settings (`.env`): `CONSOLE_PORT`, `CONSOLE_ALLOWED_HOSTS`, `CONSOLE_RUN_TIMEOUT_MS`,
`CONSOLE_ALLOW_PRIVATE_NETWORK`, `CONSOLE_SECRETS_FILE`, `CONSOLE_MASTER_KEY_FILE`, `CONSOLE_MASTER_KEY`
(passphrase for containers/CI). Details: [docs/test-console.md](docs/test-console.md).

## What is inside

| Area          | Highlights                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config        | Zod-validated env JSON + env-var overrides, fail-fast, 6 environments, read-only prod with write allowlist                                                |
| UI            | Page Object Model, thin `BasePage`, components, role/label/test-id locators, dialogs/frames/tabs/downloads/uploads                                        |
| API           | `BaseApiClient` on `APIRequestContext`, domain clients, Zod schemas, custom matchers (`toHaveStatus`, `toMatchSchema`, `toRespondWithin`, `toHaveHeader`) |
| Auth          | Password grant, refresh rotation, OAuth2 client credentials, Basic, role-based storage state                                                              |
| Data          | Faker factories, builders, env-specific JSON with fallback, parallel-safe ids, cleanup registry                                                           |
| Observability | Pino structured logs with secret/PII redaction, failure diagnostics, HTML/Allure/JSON/JUnit + `summary.json`                                              |
| MCP           | 19 tools, 6 resources, 5 prompts; allowlists, timeouts, audit log, STDIO + authenticated Streamable HTTP; typed client                                    |
| AI            | 4 providers behind one interface, validated structured output, traceable test plans, failure classification                                               |
| Test Console  | Prompt → live browser testing via Playwright MCP; tool calling on all 4 providers; encrypted model settings; input guard rails                            |
| CI/CD         | GitHub Actions (SHA-pinned, matrix + shards, merged reports), Azure DevOps (variable groups, JUnit publishing), Docker                                    |
| Demo app      | Local UI + REST API (sessions, bearer/basic/OAuth2, RBAC, validation, idempotency) for deterministic CI                                                   |

## Commands

| Command                                                                                 | Description                                           |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `npm test`                                                                              | Typecheck, then all projects                          |
| `npm run test:ui` / `test:api` / `test:e2e`                                             | By layer                                              |
| `npm run test:smoke` / `test:regression` / `test:critical`                              | By tag                                                |
| `npm run test:chromium` / `test:firefox` / `test:webkit` / `test:mobile`                | By browser                                            |
| `npm run test:qa` / `test:uat` / `test:staging` / `test:dev` / `test:local`             | By environment                                        |
| `npm run test:prod-health`                                                              | Read-only production health checks                    |
| `npm run test:headed` / `test:debug`                                                    | Debugging                                             |
| `npm run test:framework`                                                                | Framework unit + integration tests                    |
| `npm run report` / `report:allure`                                                      | Open HTML report / generate Allure                    |
| `npm run report:allure:open`                                                            | Open the generated Allure report                      |
| `npm run typecheck` / `lint` / `format:check` / `build`                                 | Quality gates                                         |
| `npm run lint:fix` / `format`                                                           | Auto-fix lint and formatting                          |
| `npm run audit:deps`                                                                    | Dependency vulnerability audit                        |
| `npm run demo:start`                                                                    | Start the bundled demo app manually                   |
| `npm run validate`                                                                      | Everything CI runs, locally                           |
| `npm run mcp:server` / `mcp:server:dev` / `mcp:http` / `mcp:playwright` / `mcp:example` | MCP                                                   |
| `npm run ai:check`                                                                      | LLM connectivity check                                |
| `npm run console`                                                                       | Prompt-driven Test Console UI (http://localhost:4100) |
| `npm run test:generated`                                                                | Run generated drafts (`CONSOLE_BASE_URL` required)    |
| `npm run data:generate -- 20 editor`                                                    | Generate test users (JSON + CSV)                      |
| `npm run reports:merge`                                                                 | Merge sharded blob reports                            |
| `npm run clean`                                                                         | Remove artifacts                                      |

Run a single file or pass Playwright flags: `npx playwright test tests/api/users --project=api --workers=2`.

## Project structure

```text
config/environments/     local, dev, qa, uat, staging, prod (JSON, Zod-validated)
demo-app/                controlled system under test (UI + REST API + OpenAPI spec)
src/config/              configuration loading, schema, environment policy, browser projects
src/core/                fixtures (DI), assertions, exceptions, diagnostics, reporting, services, tags
src/ui/                  pages, components, helpers
src/api/                 clients, services, models, schemas, auth providers, matchers
src/auth/                AuthService, TokenManager, StorageStateManager
src/data/                factories, builders, fixtures loader, schemas, cleanup registry
src/utils/               logger, sanitizer, retry, wait, random, date, file, paths
src/ai/                  providers, services, prompts, schemas
src/mcp/server/          MCP server: tools, resources, prompts, security, stdio + http entry points
src/mcp/client/          MCP client, config, connection manager
src/agent/               Test Console agent loop, browser/draft tools, system prompt
src/console/             Test Console server, UI, input guard, model settings, encrypted secret store
generated-tests/         AI-generated test drafts for review (git-ignored)
.secrets/                encrypted Test Console settings (git-ignored)
tests/ui|api|e2e|integration/   specifications
tests/fixtures/          test entry point, tags, auth setup project
tests/framework/         unit + integration tests of the framework itself
test-data/               common + per-environment data-driven scenarios
scripts/                 run-tests, clean, generate-test-data, merge-reports, mcp-client-example, llm-check
mcp/                     MCP host example config + client server list
docs/                    architecture, setup, guides, MCP, AI, execution guidelines, troubleshooting
```

## Documentation

[Architecture](docs/architecture.md) · [Setup](docs/setup.md) · [Framework guide](docs/framework-guide.md) ·
[UI automation](docs/ui-automation.md) · [API automation](docs/api-automation.md) ·
[MCP integration](docs/mcp-integration.md) · [AI integration](docs/ai-integration.md) ·
[Test Console](docs/test-console.md) ·
[Execution guidelines](docs/test-execution-guidelines.md) · [Troubleshooting](docs/troubleshooting.md)

## Dependencies (pinned in `package.json` + lockfile)

Runtime: `@playwright/test` 1.65.1, `zod` 4.6.7, `pino` 10.4.0, `pino-pretty` 13.2.0, `dotenv` 18.0.10,
`@faker-js/faker` 10.6.0, `@modelcontextprotocol/server` + `client` 2.4.0, `@playwright/mcp` 0.0.85.
Dev: `typescript` 6.0.3, `eslint` 10 + `typescript-eslint` 8.72 (type-aware), `prettier` 3.10, `tsx`,
`allure-playwright` 3.14 + `allure-commandline`, `rimraf`, `@types/node` 22.
No vendor LLM SDKs (providers use `fetch`) and no Axios (APIRequestContext is the API client).

## Known limitations

- Page objects, API clients and schemas target the bundled demo app; real applications need their own (see
  "Extending to a new application" in [architecture](docs/architecture.md)).
- Live LLM connectivity was verified only against mocked endpoints in this repository; run `npm run ai:check`
  with real credentials or a local Ollama to verify a provider.
- The deterministic AI services use a text-only interface (no streaming or images); tool calling is used only by the
  Test Console. Its model must support tool calling (the model dropdown lists only such models; for Ollama, pick a
  tool-capable model such as `qwen3`).
- The Test Console runs one test run at a time and is meant for local use (bound to `127.0.0.1`). Prompt guard rails
  reduce, but cannot fully eliminate, prompt-injection risk – review generated tests before adopting them.
- On Windows the console's master key file is protected by user-profile permissions (no DPAPI); use a
  BitLocker-encrypted drive or `CONSOLE_MASTER_KEY` for stronger protection.
- MCP execution runs one test run at a time per server and only predefined suites/filters.
- The custom MCP HTTP transport is stateless and token-authenticated; for multi-user production use put it behind
  TLS and an identity-aware proxy (OAuth is supported by the SDK but not wired in).
- TypeScript is pinned to 6.0.x until typescript-eslint supports TypeScript 7.
- `explore_user_workflow` can submit forms; it is restricted to non-production environments by design.

## Future enhancements

- Visual regression (Playwright snapshots) and accessibility scans (axe) as opt-in projects.
- Contract testing against the OpenAPI spec (request/response validation for every call).
- OAuth-based authorisation for the MCP HTTP server and per-user audit identities.
- Flaky-test history (trend across runs) feeding failure analysis.
- Streaming in LLM providers; vision models for screenshot-based diagnosis.
- Test Console: OS keychain (Windows DPAPI / macOS Keychain) for the master key, run history persistence,
  one-click promotion of reviewed drafts into `tests/`.
- Test-data service backed by an API/DB seeding layer for complex domain objects.
