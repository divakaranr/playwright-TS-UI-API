# Setup

## Prerequisites

| Tool    | Version      | Notes                                                                 |
| ------- | ------------ | --------------------------------------------------------------------- |
| Node.js | 22.13+ (LTS) | `.nvmrc` pins 22.                                                     |
| npm     | 10+          | Lockfile is committed – always use `npm ci` in CI.                    |
| Java    | 17+          | Only for generating the Allure HTML report (`npm run report:allure`). |
| Ollama  | optional     | Local LLM for data-sensitive environments.                            |

## Install

```bash
git clone <repo> && cd playwright-TS-UI-API
npm ci
npx playwright install --with-deps chromium firefox webkit   # --with-deps on Linux CI images
cp .env.example .env                                           # adjust values; never commit .env
npm run typecheck && npm run lint
```

## Verify the installation

```bash
npm run test:framework      # framework unit + integration tests (starts the demo app automatically)
npm run test:smoke          # smoke tests across API and browsers against the demo app
npm run report              # open the HTML report
```

## Environment selection

`TEST_ENV` selects `config/environments/<env>.json` (`local`, `dev`, `qa`, `uat`, `staging`, `prod`).
Precedence: **real environment variables > `.env.<TEST_ENV>` > `.env` > JSON defaults**.

```bash
npm run test:qa                                   # TEST_ENV=qa
npm run test:uat -- --project=api                 # extra arguments are passed to Playwright
TEST_ENV=staging npx playwright test --project=api
```

Invalid configuration fails before any browser starts, listing every problem:

```text
ConfigurationError: Invalid environment variables:
 - BASE_URL: Invalid URL
 - WORKERS: Invalid input: expected number, received NaN
```

## Credentials

Per role: `APP_<ROLE>_USERNAME` / `APP_<ROLE>_PASSWORD` (roles are declared per environment; `prod` only declares
`viewer` – least privilege). Plain `USERNAME` is deliberately not used because it is a reserved variable on Windows.
Quote values containing `#` in `.env` files – dotenv treats an unquoted `#` as a comment.

In CI use secret stores: GitHub **environment secrets** (environments `dev`, `qa`, …) or Azure DevOps
**variable groups** `playwright-<env>` with secret variables.

## Docker

```bash
docker build -t pw-framework .
docker run --rm pw-framework                                  # full suite against the bundled demo app
docker run --rm --env-file .env.qa -e TEST_ENV=qa pw-framework npm run test:api
```
