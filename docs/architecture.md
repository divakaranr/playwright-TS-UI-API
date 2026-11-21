# Architecture

## Goals

A reusable automation platform – not a demo – that supports many applications and environments by changing
**configuration, page objects, API clients and test data**, never the framework core. Deterministic tests are
the regression safety net; AI is an optional assistant for exploration, generation and diagnosis.

## Layers

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. Orchestration   playwright.config.ts · projects · tags · retries ·     │
│                    sharding · reporters · scripts/run-tests.ts · CI       │
├──────────────────────────────────────────────────────────────────────────┤
│ 2. Specifications  tests/ui · tests/api · tests/e2e · tests/integration   │
│                    business-level steps and assertions only              │
├──────────────────────────────────────────────────────────────────────────┤
│ 3. Automation      src/ui (pages, components, helpers) · src/api          │
│    services        (clients, services, schemas, assertions) · src/auth · │
│                    src/data (factories, builders, fixtures, cleanup)      │
├──────────────────────────────────────────────────────────────────────────┤
│ 4. Infrastructure  src/config (Zod-validated) · src/core/fixtures (DI) ·  │
│                    logging (Pino) · diagnostics · reporting · policies    │
├──────────────────────────────────────────────────────────────────────────┤
│ 5. AI & MCP        src/ai (providers, services, prompts, schemas)         │
│    (optional)      src/mcp/server (custom MCP server) · src/mcp/client    │
│                    official @playwright/mcp for browser exploration        │
└──────────────────────────────────────────────────────────────────────────┘
```

Dependencies point downwards only. Layer 5 consumes layers 3–4 (e.g. MCP tools run tests through
`TestExecutionService`, AI analysis reads reports through `ResultsService`), but **nothing in layers 1–4 depends on
layer 5**: `npm run test:ui` works with no LLM, no MCP server and no API keys.

## Key components

| Component             | Location                                 | Responsibility                                                                                                                                                            |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration         | `src/config`                             | Loads `config/environments/<env>.json`, applies env-var overrides, validates everything with Zod, fails fast with all issues listed.                                      |
| Environment policy    | `src/config/environment-policy.ts`       | Blocks writes against read-only environments (prod); DELETE never allowed there; `@prod-safe` gate.                                                                       |
| Fixtures              | `src/core/fixtures/framework.fixture.ts` | Dependency injection: config, loggers, API clients, auth, page objects, test data, cleanup, diagnostics.                                                                  |
| BasePage / components | `src/ui`                                 | Thin facade over `ElementActions` and browser helpers (dialogs, frames, tabs, downloads, uploads).                                                                        |
| BaseApiClient         | `src/api/clients/base-api.client.ts`     | APIRequestContext wrapper: URL building, auth, correlation ids, timeouts, policy, logging, diagnostics.                                                                   |
| Auth                  | `src/auth`, `src/api/auth`               | `TokenManager` (expiry/refresh/dedupe), `AuthService` (password, client-credentials, basic), `StorageStateManager`.                                                       |
| Test data             | `src/data`                               | `UserFactory` (Faker, parallel-safe ids), `UserBuilder`, `TestDataService` (env → common fallback), `CleanupRegistry`.                                                    |
| Diagnostics           | `src/core/diagnostics`                   | API call recorder + browser console/page/network errors, attached on failure (sanitised).                                                                                 |
| Reporting             | `src/core/reporting/summary.reporter.ts` | `reports/summary.json` – stable contract for CI, MCP and AI.                                                                                                              |
| Services              | `src/core/services`                      | Test execution (no shell), results/trace reading, test catalogue, app inspection.                                                                                         |
| AI                    | `src/ai`                                 | Provider abstraction (OpenAI, Anthropic, OpenRouter, Ollama), structured output with validation/repair, generation, failure analysis, API exploration, maintenance audit. |
| MCP server            | `src/mcp/server`                         | 19 governed tools, 6 resources, 5 prompts over STDIO (and authenticated Streamable HTTP).                                                                                 |
| MCP client            | `src/mcp/client`                         | Typed client, schema-validated tool calls, multi-server connection manager.                                                                                               |
| Demo app              | `demo-app/`                              | Deterministic local UI + REST API used for CI validation.                                                                                                                 |

## Request flow examples

**API test**: spec → `userApi` fixture → `UserApiClient.createUser()` → `BaseApiClient.send()` (policy check →
auth headers from `TokenManager` → `APIRequestContext.fetch` → recorder/logging) → `ApiResponse` →
`expect(response).toHaveStatus(201)` / `response.parse(userSchema)`.

**MCP test run**: host → `run_ui_tests` → guarded wrapper (allowlist, Zod, timeout, audit) →
`TestExecutionService.run()` → `node playwright/cli.js test …` (argument array, isolated report dir) →
`summary.json` → structured result.

## Design decisions and trade-offs

| Decision                                                   | Rationale                                                                                                | Trade-off                                                                                                            |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| ESM + TypeScript 6.0 (`NodeNext`)                          | Faker 10 and the MCP SDK v2 are ESM-first; NodeNext keeps runtime and type resolution identical.         | Relative imports need `.js` extensions. TS 7 (native) is not yet supported by typescript-eslint, so 6.0.x is pinned. |
| Playwright Test for framework self-tests                   | One runner, one reporter stack, no extra dependency (Vitest/Jest).                                       | Unit tests share the runner's startup cost (~1–2 s).                                                                 |
| `fetch`-based LLM adapters instead of vendor SDKs          | Uniform timeout/retry/error normalisation, trivial mocking, four providers with zero extra dependencies. | Provider-specific features (streaming, tool use, vision) must be added explicitly.                                   |
| Composition in BasePage                                    | `BasePage` delegates to `ElementActions` and pure helper functions, keeping it small.                    | One extra indirection when reading the code.                                                                         |
| API client never throws on HTTP status                     | Negative tests stay simple; status is asserted explicitly.                                               | Setup code must check statuses (done in `UserService`).                                                              |
| Storage state via a `setup` project                        | Login once per role per run, traced and reported like a test; each test still gets a fresh context.      | Browser projects depend on `setup`.                                                                                  |
| Separate demo app                                          | CI never depends on an unstable public site.                                                             | Demo selectors are illustrative; real apps need their own page objects.                                              |
| MCP execution through `node cli.js` with an argument array | No shell → no command injection; projects/paths/grep allow-listed.                                       | Only predefined suites/filters can be run (by design).                                                               |
| Heuristic + LLM failure analysis                           | Useful without an LLM; LLM output validated and never acted on automatically.                            | Heuristics are coarse; marked low/medium confidence.                                                                 |

## Structure changes vs. the original blueprint

- `demo-app/` added (controlled system under test) and a `local` environment.
- `tests/framework/{unit,integration,support}` added for testing the framework itself.
- `src/core/services` (execution, results, catalog, inspection, trace reader), `src/core/diagnostics`,
  `src/core/reporting`, `src/core/tags.ts` added; empty `core/browser`, `core/interfaces`, `core/security`
  were not needed – browser lifecycle is owned by Playwright projects/fixtures, interfaces live next to their
  implementations, security lives in `utils/sanitizer.ts`, `config/environment-policy.ts` and `mcp/server/security`.
- `src/mcp/server/tools` adds `generation-tools.ts` and `framework-tools.ts`; `src/mcp/server/{prompts,context.ts,bootstrap.ts,http.ts}`.
- `docs/test-execution-guidelines.md` added (served as an MCP resource).

## Extending to a new application

1. Add/adjust `config/environments/*.json` (URLs, roles, auth paths, thresholds).
2. Replace the demo page objects in `src/ui/pages` (keep the public method style) and components.
3. Add domain API clients in `src/api/clients`, schemas in `src/api/schemas`, services in `src/api/services`.
4. Add factories/builders for your entities and register cleanup in services.
5. Point `OPENAPI_SPEC_PATH` at your approved API spec for AI/MCP API features.
6. Set `features.startDemoApp` to `false` everywhere except where you run the demo.
