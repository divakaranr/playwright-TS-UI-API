# Test execution guidelines

## Strategy per stage

| Stage                 | Scope                                                                                                  | How                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Pull request          | typecheck, lint, format, audit, build, framework tests, API smoke, critical UI smoke (Chromium)        | GitHub `pull_request`, Azure `pr` (`suite=smoke`)                            |
| Push to main/develop  | quality gates + API & UI regression (Chromium, 2 shards)                                               | `suite=regression`                                                           |
| Daily                 | full regression, Chromium + Firefox + WebKit, sharded                                                  | scheduled, `suite=full`                                                      |
| Release               | full cross-browser regression against staging                                                          | `workflow_dispatch` / Azure parameters (`environment=staging`, `suite=full`) |
| Scheduled exploration | AI-assisted exploratory sessions (MCP prompts `explore_business_workflow`, `identify_regression_gaps`) | MCP host, non-production only                                                |
| Production            | read-only health checks (`@prod-safe`)                                                                 | `npm run test:prod-health`                                                   |

## Commands

```bash
npm test                       # typecheck + all projects
npm run test:ui                # tests/ui on chromium, firefox, webkit
npm run test:api               # api project
npm run test:e2e               # hybrid e2e + integration
npm run test:smoke | test:regression | test:critical
npm run test:chromium | test:firefox | test:webkit | test:mobile
npm run test:qa | test:uat | test:staging | test:dev | test:local
npm run test:headed | test:debug
npm run test:framework         # framework self-tests
npx playwright test tests/api/users/users-crud.spec.ts          # single file
npx playwright test --grep "@critical" --grep-invert "@slow"    # tag expressions
npx playwright test --shard=1/4                                 # sharding
```

`npm run test*` scripts go through `scripts/run-tests.ts`: it sets `TEST_ENV` (`--env`), runs the TypeScript
compiler first (Playwright never type-checks), then calls Playwright. Pass Playwright options after `--`.

## Tags

| Tag                                | Meaning                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `@smoke`                           | Fast, high-value health signal; runs on every PR.              |
| `@critical`                        | Business-critical journeys; failure blocks release.            |
| `@regression`                      | Full functional coverage.                                      |
| `@sanity`                          | Narrow post-deployment checks.                                 |
| `@ui` `@api` `@e2e` `@integration` | Layer.                                                         |
| `@negative`                        | Invalid input / unauthorised paths.                            |
| `@mobile`                          | Runs on mobile projects (`MOBILE=true`).                       |
| `@prod-safe`                       | Read-only; the only tests allowed in prod.                     |
| `@destructive`                     | Deletes/mutates shared state; never in read-only environments. |

## Retries & flakiness

- CI retries = 2, local = 0 (`RETRIES` overrides). Retries exist for **transient infrastructure failures**.
- A test that passes on retry is reported as **flaky** in `summary.json`/HTML/Allure and must be fixed – not
  ignored. Track flaky tests and quarantine with an issue reference only as a temporary measure.
- Never add sleeps or increase timeouts to hide flakiness; fix synchronisation with web-first assertions.

## Parallelism & isolation

- `fullyParallel: true`; workers default to CPU-based locally and 2 in CI (`WORKERS` overrides).
- Every test gets a fresh browser context and API request context; data is generated per test with unique ids
  (worker index + time + randomness) and cleaned up via the cleanup registry, even on failure.

## Environment rules

- `prod`: only `@prod-safe`; writes blocked by the API client; MCP cannot target it.
- `uat`/`staging`: not allowed for MCP tools unless added to `MCP_ALLOWED_ENVIRONMENTS`.
- Credentials are least-privilege per role and come from secret stores.
