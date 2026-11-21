# Test Console (prompt-driven testing UI)

A local web page where you enter a website URL and a plain-language prompt; an LLM (OpenRouter, OpenAI,
Anthropic or a local Ollama model) then tests the site in a real browser using the official Playwright MCP,
streaming every step live.

```bash
npm run console          # → http://localhost:4100
```

## Setup – Model settings (in the UI)

Open **⚙ Model settings** (it opens automatically while nothing is configured):

| Field    | What it does                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider | Dropdown: OpenRouter, OpenAI, Anthropic, Ollama (local).                                                                                                                                |
| API key  | Password field, never pre-filled. Shows only a hint such as `Saved (••••1a2b)` once stored – leave it empty to keep the saved key. One key is kept per provider. Not needed for Ollama. |
| Model    | Dropdown filled **live from the provider** with the models that support tool calling (filter box for long lists). OpenRouter lists without a key; OpenAI/Anthropic need the key first.  |

**Verify & save** checks the key with the provider (a rejected key is never stored) and that the model is
offered for tool calling, then stores provider, model and key **encrypted**. The header pill shows
`<Provider> · <model> 🔒`. **Forget saved settings** deletes the encrypted file.

### How the secrets are stored

| Item           | Location / mechanism                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Encrypted file | `.secrets/llm-settings.enc.json` (git- and docker-ignored) – AES-256-GCM, random IV per write, authenticated (tampering is detected). |
| Master key     | `~/.playwright-test-console/master.key` – 256-bit random key created on first save, **outside the project**, file mode 0600.          |
| In the browser | Nothing: the API never returns a key, only `••••` + last 4 characters. Settings requests must be same-origin JSON (CSRF-protected).   |
| In logs        | Provider/model and "key updated: yes/no" only.                                                                                        |

A copied, zipped or accidentally committed project folder therefore contains only ciphertext. Losing the
master key makes the file unreadable – the console reports it and you simply re-enter the settings.
On Windows the key file is protected by your user-profile permissions; for stronger protection keep the
project on a BitLocker-encrypted drive.

Optional overrides (`.env` or environment):

```env
CONSOLE_PORT=4100
CONSOLE_ALLOWED_HOSTS=demo-qa-app.azurewebsites.net    # restrict which sites may be tested
CONSOLE_RUN_TIMEOUT_MS=1200000                          # hard stop per run (default 20 min)
CONSOLE_ALLOW_PRIVATE_NETWORK=false                     # true = allow localhost/intranet targets
CONSOLE_SECRETS_FILE=.secrets/llm-settings.enc.json     # encrypted settings file
CONSOLE_MASTER_KEY_FILE=~/.playwright-test-console/master.key
CONSOLE_MASTER_KEY=                                     # passphrase instead of a key file (containers/CI, ≥16 chars, scrypt)
```

**Fallback:** until settings are saved in the UI, `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` from `.env`
are used (pill shows `(.env)`). After saving once in the UI you can remove `LLM_API_KEY` from `.env`.

## Using it

1. **Website URL** – the site under test (e.g. `https://demo-qa-app.azurewebsites.net/`).
2. **Prompt** – what to test, e.g. _"Test the login form with empty, invalid and valid input and check the
   error messages"_. The example buttons insert ready-made prompts.
3. **Mode**
   - **Explore & report** – the AI performs the checks live and writes a report (PASS/FAIL table, defects with
     reproduction steps, follow-up ideas).
   - **Generate & run tests** – the AI explores, writes Playwright tests, saves them to
     `generated-tests/console/<run-id>/`, runs them (unless "Run generated tests" is unticked) and fixes genuine
     test-code mistakes (application defects are reported, not hidden).
4. **Max steps** bounds cost; **Show browser** opens a visible browser window.
5. **Start testing** – the right panel streams tool calls, results, a screenshot after every action, test runs
   and finally the report. **Cancel** stops the run.

## Outputs

| What                                  | Where                                                 |
| ------------------------------------- | ----------------------------------------------------- |
| Generated tests (for review)          | `generated-tests/console/<run-id>/*.spec.ts`          |
| Run report (Markdown)                 | `reports/console-runs/<run-id>/report.md`             |
| Screenshots                           | `reports/console-runs/<run-id>/screenshots/`          |
| HTML report of generated-test runs    | `reports/console-runs/<run-id>/test-runs/run-N/html/` |
| Browser snapshots/logs from the agent | `reports/console-runs/<run-id>/browser/`              |

All of them are linked from the **Files** panel. Both folders are git-ignored.

## Reviewing generated tests

Generated tests use plain `@playwright/test` with relative URLs, so they run against any site via the
dedicated config:

```bash
CONSOLE_BASE_URL=https://demo-qa-app.azurewebsites.net npm run test:generated -- generated-tests/console/<run-id>
```

(PowerShell: `$env:CONSOLE_BASE_URL="https://…"; npm run test:generated -- generated-tests/console/<run-id>`)

After review, move a test into `tests/`, replace raw locators with page objects and use the framework fixtures
(`import { test, expect } from '../fixtures/framework.fixture.js'`).

## How it works

```text
Browser UI ──POST /api/runs──▶ console server (127.0.0.1) ──▶ TestAgent loop
                 ◀──SSE events──          │                    │  ▲
                                          │      tool calls    ▼  │ results
                                          │   ┌──────────────────────────────────────┐
                                          │   │ Playwright MCP (allow-listed tools)  │
                                          │   │ save_test_file / run_test_file       │
                                          │   └──────────────────────────────────────┘
                                          └──▶ OpenRouter chat completions with tools
```

- `src/ai/providers/tool-chat.ts` – tool-calling client (OpenAI-compatible wire format).
- `src/agent/test-agent.ts` – the loop: step budget, cancellation, bounded/compacted tool output.
- `src/agent/browser-tools.ts` – Playwright MCP tools + origin guard. `src/agent/draft-tools.ts` – save/run tests.
- `src/console/` – HTTP server, run orchestration and the single-page UI.

## Guard rails

Prompt injection cannot be prevented by one filter, so the console layers independent controls. Inputs are
validated **on the server** (`src/console/input-guard.ts`); the UI only mirrors a subset for quick feedback.

### 1. Website URL validation

| Check            | Rule                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format (regex)   | `http(s)://host[:port][/path][?query]` – ASCII host labels, no spaces, no `user:password@`, no IPv6 literals, max 2048 chars      |
| Parsing          | Must parse as a WHATWG URL; fragment is dropped; port 1–65535                                                                     |
| Schemes          | Only `http`/`https` (`javascript:`, `data:`, `file:`, `ftp:` … are rejected)                                                      |
| Always blocked   | Link-local/cloud metadata (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`), `0.0.0.0/8`, multicast/reserved            |
| Private networks | `localhost`, `10/8`, `172.16/12`, `192.168/16`, `127/8`, single-label hosts – blocked unless `CONSOLE_ALLOW_PRIVATE_NETWORK=true` |
| DNS check        | The host is resolved; names pointing to blocked/private addresses are rejected (SSRF / DNS tricks)                                |
| Allowlist        | Optional `CONSOLE_ALLOWED_HOSTS` (exact or `*.example.com`)                                                                       |

### 2. Prompt sanitisation

1. Unicode **NFKC normalisation** (full-width `＜script＞` becomes `<script>` before checks).
2. **Removal** of invisible characters (zero-width, bidi overrides, tag characters, BOM) and control characters;
   whitespace collapsed. Length 10–2000 characters, max 40 lines.
3. **Rejection** (with a clear message – nothing is silently rewritten) of:
   - HTML/script markup, `javascript:`/`data:` URLs, inline event handlers, encoded markup, template expressions;
   - prompt-injection phrases ("ignore previous instructions", "reveal your system prompt / API key"), persona
     changes ("you are now…", "developer mode"), chat-role markers (`system:`, `<|im_start|>`, `[INST]`) and the
     console's own delimiter tags;
   - shell commands, code-execution constructs (`require(`, `process.env`, `eval(`, `child_process`), local file paths;
   - attacks and abuse (brute force, load/stress tests, scanning, injection payloads);
   - credentials, tokens or API keys typed into the prompt;
   - URLs that point outside the target site;
   - requests that are not about testing the site (no testing vocabulary).
4. Rejected inputs are logged with the rule categories and a hash – never the raw text.

### 3. Hardened system prompt (`src/agent/prompts.ts`)

- The agent's **only** function is functional/UI testing of the target origin with Playwright, plus writing
  Playwright tests for it. General questions, other code, other hosts, revealing instructions/config/secrets,
  security attacks and irreversible real-world actions are explicitly out of scope.
- Instructions come only from the system message. The user's text is placed between `<test_request>` delimiters
  and is defined as a description of _what_ to test – it cannot change rules, role or scope.
- All tool output (page text, snapshots, console, network, test output) is untrusted data; instructions found
  there are reported as findings, never followed.
- Out-of-scope requests must be answered with `OUT_OF_SCOPE: <reason>` and no tool calls; the agent then stops
  with status **refused** (tool calls in such a response are not executed).

### 4. Runtime enforcement (independent of the model's behaviour)

| Risk                                | Control                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Others using your console / API key | Binds to `127.0.0.1`; rejects foreign `Host` headers (DNS rebinding) and cross-site `Origin` (CSRF); strict request schema (unknown fields rejected).                                                                                                                                      |
| Agent leaving the site              | Every URL-like tool argument is checked against the target origin.                                                                                                                                                                                                                         |
| Script payloads typed into pages    | Every string argument (incl. nested form fields) is checked for markup/script before it reaches the browser.                                                                                                                                                                               |
| Dangerous browser capabilities      | `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload` are never offered to the model.                                                                                                                                                                                       |
| Model-written test code             | Only `@playwright/test` imports; no `require`/dynamic import/`process`/`eval`, no `fetch`/WebSocket, no `page.evaluate`/`addInitScript`, no routing/credential changes, no extra browsers/API contexts, no file-system paths, no other hosts, no invisible Unicode, no configured secrets. |
| Secret leakage                      | Every event, report and saved file passes a redactor that removes the actual values of `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD` environment variables, plus generic token/password masking.                                                                                            |
| Runaway cost                        | Step budget, per-run timeout, run limit for generated tests, one run at a time.                                                                                                                                                                                                            |

These controls are guard rails, not a sandbox: regex deny-lists can be bypassed by sufficiently creative
phrasing, which is why model-independent runtime checks exist. Only test sites you are allowed to test, and
prefer non-production environments.

## Troubleshooting

| Symptom                                            | Fix                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Red pill "Choose a provider and model…"            | Open ⚙ Model settings, pick provider + model, enter the key, Verify & save.                    |
| Run fails with `LLM_BAD_REQUEST` mentioning tools  | The model does not support tool calling – pick another model in Model settings.                |
| `LLM_RATE_LIMIT` / `LLM_AUTHENTICATION`            | Check the key, credits and model limits; re-enter the key in Model settings.                   |
| Start rejected with "Prompt: …" / "Website URL: …" | The input guard explains which rule triggered; rephrase as a testing task for the target site. |
| Run ends with status **refused**                   | The model judged the request out of scope (see the report); rephrase as website testing.       |
| "A run is already in progress"                     | Wait or press Cancel (one run at a time).                                                      |
| Agent loops without finishing                      | Lower the scope of the prompt or raise Max steps; a partial report is produced at the limit.   |
| "Saved settings could not be loaded"               | Master key changed/missing or file modified – re-enter the settings (the file is overwritten). |
| "Ollama (local) is not reachable"                  | Start Ollama (`ollama serve`) and pull a tool-calling model, e.g. `ollama pull qwen3`.         |
