# AI integration

AI is **optional**. With `LLM_PROVIDER=none` (default) every deterministic suite runs unchanged and AI-backed
features degrade to deterministic fallbacks (heuristic failure analysis, spec-derived API scenarios,
template-based drafts) or return a clear `LLM_NOT_CONFIGURED` error.

## Providers

| Provider                  | `LLM_PROVIDER` | Required                                       | Default base URL               |
| ------------------------- | -------------- | ---------------------------------------------- | ------------------------------ |
| OpenAI (Chat Completions) | `openai`       | `LLM_MODEL`, `LLM_API_KEY`                     | `https://api.openai.com/v1`    |
| Anthropic (Messages API)  | `anthropic`    | `LLM_MODEL`, `LLM_API_KEY`                     | `https://api.anthropic.com`    |
| OpenRouter                | `openrouter`   | `LLM_MODEL` (vendor/model slug), `LLM_API_KEY` | `https://openrouter.ai/api/v1` |
| Ollama (local)            | `ollama`       | `LLM_MODEL`                                    | `http://localhost:11434`       |

`LLM_BASE_URL` overrides the endpoint (gateways, proxies, Azure-hosted OpenAI-compatible endpoints).
`LLM_TIMEOUT_MS` (default 60000) and `LLM_MAX_RETRIES` (default 2) apply to all providers.

```bash
LLM_PROVIDER=ollama LLM_MODEL=llama3.1 npm run ai:check
LLM_PROVIDER=anthropic LLM_MODEL=<model-id> LLM_API_KEY=... npm run ai:check
```

All adapters implement `LLMProvider.generate(LLMRequest) → LLMResponse` (content, model, provider, input/output
tokens, latency, finish reason). The shared transport adds timeouts, exponential backoff with jitter for 429/5xx/
network/timeout errors, `Retry-After` support and normalised `LlmError` kinds (`authentication`, `rate_limit`,
`timeout`, `bad_request`, `server`, `network`, `invalid_response`, `configuration`). `TrackedLlmProvider` records
token usage and latency and logs metadata only – never prompts, completions or keys.

Adapters use the platform `fetch` rather than vendor SDKs: one retry/error model for all providers, no extra
dependencies, deterministic tests against a mock server. Provider-specific capabilities (streaming, tool use,
vision, very large contexts) are intentionally not assumed.

## Capabilities

| Capability                   | Entry point                                                                                 | Output                                                                                                                                | Without LLM           |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Requirement → tests          | `TestGenerationService.generateFromRequirement`, MCP `generate_test_from_requirement`       | `GeneratedTestPlan` (scenarios with type, layer, priority, steps, expected results, tags, **traceability to AC/BR ids**) + spec draft | error                 |
| UI test draft                | MCP `generate_ui_test`                                                                      | Spec draft from explicit scenarios or a requirement                                                                                   | template mode         |
| API test draft / exploration | `ApiExplorationService`, MCP `generate_api_test`                                            | Scenarios per operation (positive/negative/boundary/authorization/schema/performance)                                                 | spec-derived baseline |
| Failure analysis             | `FailureAnalysisService`, MCP `analyze_failure_logs`                                        | root cause, classification (application/automation/environment/data/unknown), evidence, fix, confidence, flaky flag                   | heuristic rules       |
| Test maintenance             | `TestMaintenanceService.audit()` / `.suggest()`                                             | brittle-locator findings / replacement suggestions                                                                                    | audit only            |
| Exploratory testing          | official Playwright MCP + `explore_business_workflow` prompt + `explore_user_workflow` tool | charter report by the LLM host                                                                                                        | tools still usable    |

## Validation & governance

- Every LLM answer is parsed from JSON and validated with Zod (`generateStructured`); invalid output triggers one
  repair round with the validation errors, then fails – unvalidated data is never returned.
- Generated plans must reference real acceptance-criterion/business-rule ids and cover every acceptance criterion.
- Generated code is a **draft**: banner, `test.fixme` markers, written only to `generated-tests/`. It enters the
  suite only through normal review, implementation and a green CI run.
- The framework never edits tests, self-heals locators or changes test outcomes.

## Data protection & prompt injection

- Diagnostic packages are deep-sanitised (credentials, tokens, JWTs, API keys, e-mails) and truncated before
  sending; source snippets are masked at collection time as well.
- Application content (page text, API bodies, logs, requirements) is wrapped in `<untrusted source="…">` blocks;
  system prompts instruct the model to treat them as data and never follow embedded instructions. Attempts to close
  the wrapper from inside are neutralised.
- Screenshots are referenced by path, not uploaded (the common interface is text-only).
- For environments where data must not leave the organisation, use `LLM_PROVIDER=ollama` (local inference) or an
  internal OpenAI-compatible gateway via `LLM_BASE_URL`.
