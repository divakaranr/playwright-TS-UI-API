# API automation

## Client hierarchy

```text
BaseApiClient (get/post/put/patch/delete/send, buildUrl, withAuth)
  ├── UserApiClient   listUsers, getUser, createUser(+Idempotency-Key), replaceUser, updateUser, deleteUser
  └── AuthApiClient   login, refresh, clientCredentials
UserService           create (validated + cleanup), get, findByEmail, trackForCleanup, trackByEmail
```

`BaseApiClient` features: URL resolution under the API base path (`/users` → `<apiBaseUrl>/users`), cross-origin
refusal, auth via pluggable `AuthProvider`, `X-Correlation-Id` per request, timeouts, environment write policy,
structured logging and sanitised request/response recording for failure diagnostics. It returns an
`ApiResponse` (status, headers, `durationMs`, `correlationId`, `json()`, `parse(schema)`, `raw`) and **never throws
on HTTP status** – transport errors raise `ApiRequestError`.

## Assertions

```typescript
const response = await userApi.createUser(payload, { idempotencyKey });
await expect(response).toHaveStatus(201);
await expect(response).toMatchSchema(userSchema);
await expect(response).toHaveHeader('location', /\/api\/users\/\d+/);
await expect(response).toRespondWithin(config.environment.api.responseTimeThresholdMs);
const user = await response.parse(userSchema); // typed + validated
```

Failure messages include the request line, correlation id and a body excerpt. Schemas are `strict()` so unexpected
fields (e.g. a leaked `password`) fail.

## Authentication

| Mechanism                              | How                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Username/password (bearer)             | `authService.bearerFor('admin')` – token cached per role, refreshed before expiry via refresh-token rotation, re-acquired if refresh fails, concurrent requests de-duplicated. |
| OAuth2 client credentials              | `authService.clientCredentials(scope?)` using `API_CLIENT_ID` / `API_CLIENT_SECRET`.                                                                                           |
| HTTP Basic                             | `authService.basicFor('viewer')`.                                                                                                                                              |
| Fixed / invalid token (negative tests) | `new StaticTokenProvider('…')`.                                                                                                                                                |
| Per-call override                      | `client.get('/users', { auth: provider })` or `client.withAuth(provider)`.                                                                                                     |

Tokens and passwords are never logged (sanitiser + metadata-only logs).

## Coverage (tests/api)

| #   | Scenario                                                                           | Spec                                                |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1–5 | Positive GET / POST / PUT / PATCH / DELETE                                         | `users/users-crud.spec.ts`                          |
| 6   | Invalid authentication (no token, forged token, wrong password, bad client secret) | `authentication/authentication.spec.ts`             |
| 7   | Missing mandatory fields                                                           | `users/users-validation.spec.ts`                    |
| 8   | Invalid payloads (data-driven from `test-data`), malformed JSON, duplicates        | `users/users-validation.spec.ts`                    |
| 9   | Boundary values (name length 50/51, pageSize 0/1/100/101/-1)                       | `users/users-validation.spec.ts`                    |
| 10  | Invalid endpoint / unknown id                                                      | `users/users-validation.spec.ts`                    |
| 11  | Schema validation                                                                  | all specs (`toMatchSchema`, `parse`)                |
| 12  | Response headers (content type, cache, nosniff, correlation id)                    | `users/users-crud.spec.ts`                          |
| 13  | Response time thresholds (per environment)                                         | `users/users-crud.spec.ts`, `health/health.spec.ts` |
| 14  | Idempotency (Idempotency-Key replay & conflict, PUT, repeated DELETE)              | `users/users-crud.spec.ts`                          |
| 15  | Authorization / RBAC (viewer vs admin, protected accounts)                         | `authentication/authorization.spec.ts`              |
| –   | Refresh-token rotation, client credentials, Basic auth                             | `authentication/authentication.spec.ts`             |
| –   | Production health check (`@prod-safe`)                                             | `health/health.spec.ts`                             |

Side effects are verified (e.g. a 403 leaves the resource unchanged; a created resource is retrievable; delete → 404).

## Hybrid UI + API

`tests/e2e/user-lifecycle.spec.ts` – API setup → UI login → UI search & verify → UI edit → API verification →
API delete. `tests/integration/registration-consistency.spec.ts` – UI registration verified via API (least
privilege) and API deactivation blocking UI sign-in. The API is used for setup/verification, never to bypass the
UI behaviour under test.
