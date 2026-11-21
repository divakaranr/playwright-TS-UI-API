# Framework guide

## Writing a test

```typescript
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('User management', { tag: [Tags.ui] }, () => {
  test.use({ role: 'admin' }); // start with the stored admin session

  test(
    'filter finds a user created through the API',
    { tag: [Tags.smoke] },
    async ({ userService, testData, userManagementPage }) => {
      const user = await userService.create(testData.users.build()); // API setup + automatic cleanup

      await userManagementPage.navigate();
      await userManagementPage.filter(user.email);

      await userManagementPage.expectUserListed(user.email);
    },
  );
});
```

Rules of thumb:

- Specs contain **business steps and assertions**; locators and HTTP details live in page objects/clients.
- Never read `process.env` in specs – use fixtures (`config`, `credentials(role)`).
- Generate data per test; never depend on records created by another test.
- Register cleanup at creation time (`userService.create`, `userService.trackByEmail`).
- No fixed sleeps (`waitForTimeout` is a lint error). Use web-first assertions or `expect.poll`.

## Fixtures

| Fixture                                                                                                | Scope         | Purpose                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------- |
| `config`                                                                                               | worker        | Validated `FrameworkConfig`.                                         |
| `workerLogger` / `logger`                                                                              | worker / test | Pino loggers; `logger` carries test id + correlation id.             |
| `storageStates`                                                                                        | worker        | Paths of stored sessions per role.                                   |
| `role` (option)                                                                                        | test          | `test.use({ role: 'admin' })` → context starts authenticated.        |
| `page`, `context`, `browser`                                                                           | Playwright    | Built-ins; `context` is instrumented for diagnostics.                |
| `testContext`                                                                                          | test          | Test id, title, project, retry, tags, correlation id.                |
| `credentials(role)`                                                                                    | test          | Resolves `APP_<ROLE>_*` lazily.                                      |
| `apiRequest`                                                                                           | test          | Fresh `APIRequestContext`, disposed after the test.                  |
| `apiClient`                                                                                            | test          | Anonymous `BaseApiClient`.                                           |
| `authenticatedApiClient`                                                                               | test          | `BaseApiClient` with admin bearer token.                             |
| `userApi`, `apiAs(role)`                                                                               | test          | `UserApiClient` as admin / any role.                                 |
| `authApi`, `authService`, `tokenManager`                                                               | test          | Raw auth endpoints, auth providers, token cache.                     |
| `testData`                                                                                             | test          | Factories, builders, JSON data loader.                               |
| `cleanup`                                                                                              | test          | LIFO cleanup registry (runs even on failure; failures are reported). |
| `userService`                                                                                          | test          | Create/find users via API with cleanup.                              |
| `loginPage`, `dashboardPage`, `userManagementPage`, `userDetailPage`, `searchPage`, `registrationPage` | test          | Page objects.                                                        |
| `environmentGuard`, `failureDiagnostics`                                                               | test (auto)   | Read-only env gate; lifecycle logging + diagnostics attachment.      |

## Tags

`@smoke @regression @sanity @ui @api @e2e @critical @negative @integration @mobile @prod-safe @destructive`
(see `src/core/tags.ts`). Use `{ tag: [...] }` on `test`/`describe`; filter with `--grep`/`--grep-invert`.

## Logging

Pino JSON logs go to `logs/framework.log` (`LOG_LEVEL`), console output at `LOG_CONSOLE_LEVEL` (default `warn`).
Every record is sanitised: password/token/secret/cookie/authorization keys are redacted at any depth, bearer
tokens/JWTs/API keys are masked in free text, e-mails are masked (`j***@example.com`).

Each test logs `test started` / `test finished|failed` with test id, title, project, environment, retry,
duration, status and correlation id. API calls log method, URL, status, duration and correlation id.

## Failure artifacts

On failure each test gets: screenshot, trace (`retain-on-failure`), video, `error-context.md` (Playwright) and
`failure-diagnostics.json` (framework): sanitised API calls (request/response metadata and body excerpts), browser
console errors, page errors, failed network requests, test context. Use `npx playwright show-trace <trace.zip>`.

## Reports

| Report       | Location                                           | Command                                                                    |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| HTML         | `reports/html`                                     | `npm run report`                                                           |
| Allure       | `reports/allure-results` → `reports/allure-report` | `npm run report:allure && npm run report:allure:open`                      |
| JSON         | `reports/results.json`                             | –                                                                          |
| JUnit        | `reports/junit.xml`                                | consumed by Azure DevOps / CI                                              |
| Summary      | `reports/summary.json`                             | totals, per-project (browser distribution), failures, flaky, slowest tests |
| Run metadata | `reports/run-metadata.json`                        | environment, projects, versions, shard                                     |

Sharded CI runs set `PW_BLOB_REPORT=true`; `npm run reports:merge` merges blob reports into `reports/merged`.

## Production safety

- `prod` is `readOnly: true` (enforced by config validation).
- Only tests tagged `@prod-safe` (and not `@destructive`) run there (`environmentGuard` fixture).
- `BaseApiClient` blocks POST/PUT/PATCH unless `ALLOW_PROD_WRITES=true` **and** the operation is allow-listed
  (`allowedWriteOperations` / `PROD_WRITE_ALLOWLIST`, e.g. `POST /feedback`); DELETE is always blocked.
- MCP tools cannot target prod at all.
