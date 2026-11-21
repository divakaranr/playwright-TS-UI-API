# Hosted Test Console (Vercel)

A public, serverless version of the [Test Console](test-console.md): users sign in with Google, bring their own
LLM API key, describe what to test, and download the generated Playwright tests as a ready-to-run project.

```text
Browser ──HTTPS──► Vercel static UI (web/public)
                   Vercel function /api/* (src/web/handler.ts, Node 22, 300 s)
                     ├─ Google sign-in (OIDC code flow + PKCE, signed session cookie)
                     ├─ model list  ──► OpenRouter / OpenAI / Anthropic (user's key)
                     └─ run (NDJSON stream)
                          agent loop (src/agent) ─► LLM (user's key)
                          serverless Chromium (@sparticuz/chromium + playwright-core) ─► target site
```

## What users get

1. **Sign in with Google** – verified Google accounts only; optionally restricted (see `ALLOWED_EMAIL_DOMAINS`).
2. **Model** – provider (OpenRouter, OpenAI, Anthropic), their own API key, and a model chosen from the live list of
   tool-calling models.
3. **What to test** – URL + prompt; output "Playwright tests + report" or "Report only".
4. Live timeline with screenshots, then **Download project (.zip)**: `tests/*.spec.ts`, `playwright.config.ts`
   (target as `baseURL`), `package.json`, `README.md`, `report.md`. Run locally with
   `npm install && npx playwright install chromium && npx playwright test`.

### Differences from the local console (`npm run console`)

| Local console                                   | Hosted (Vercel)                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Official Playwright MCP process                 | Same tool names, in-process on `playwright-core` + serverless Chromium        |
| Runs up to 20 min, generated tests are executed | ~4 min per run (soft limit 200 s, hard 270 s); tests are **not** executed     |
| Key saved encrypted on your machine             | Key stays in the browser tab (sessionStorage), sent per request, never stored |
| localhost only, no login                        | Google sign-in, per-user rate limit, public URL                               |
| OpenRouter, OpenAI, Anthropic, Ollama           | OpenRouter, OpenAI, Anthropic (a local Ollama is unreachable from the cloud)  |

## Security model

- **Authentication:** Google OIDC authorization-code flow with PKCE and `state`; the ID token's RS256 signature is
  verified against Google's JWKS plus `iss`/`aud`/`exp`; only `email_verified` accounts. Sessions are stateless
  HMAC-signed `__Host-` cookies (HttpOnly, Secure, SameSite=Lax, 12 h).
- **CSRF:** every non-GET request must carry this site's `Origin`; JSON-only bodies.
- **User API keys:** used for the one request, redacted from every streamed event, never logged or persisted.
  Logs contain only a hashed user id, target host, provider and status.
- **Inputs:** the same guard rails as the local console – URL validation with DNS-resolved SSRF protection,
  prompt sanitisation, Playwright-only system prompt with refusal, validated generated code.
- **Browser network guard:** main-frame navigation locked to the target origin; requests to localhost, private,
  link-local and metadata addresses aborted; no downloads, no service workers.
- **Abuse limits:** `RUNS_PER_HOUR` per user (default 10) and one concurrent run per user. These counters live in
  the warm function instance (best effort); for strict global limits add a KV store (e.g. Upstash Redis).
- **Headers:** strict CSP (`script-src 'self'`), HSTS, `frame-ancestors 'none'`, `nosniff`, no-store for the API.

## Deploying

### 1. Google OAuth client (once)

1. [Google Cloud Console](https://console.cloud.google.com/) → _APIs & Services_ → _OAuth consent screen_:
   User type **External**, app name, support e-mail, scopes `openid`, `email`, `profile`. Publish the app
   (otherwise only listed test users can sign in).
2. _Credentials_ → _Create credentials_ → **OAuth client ID** → _Web application_.
   - Authorised JavaScript origin: `https://<your-app>.vercel.app`
   - Authorised redirect URI: `https://<your-app>.vercel.app/api/auth/callback`
   - For local development also add `http://localhost:3100` and `http://localhost:3100/api/auth/callback`.
3. Copy the client ID and secret.

### 2. Vercel project

```bash
npx vercel login                      # once
npx vercel link                       # create/link the project (framework: Other)
npx vercel env add GOOGLE_CLIENT_ID production
npx vercel env add GOOGLE_CLIENT_SECRET production      # mark as sensitive
npx vercel env add AUTH_SECRET production               # e.g. node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npx vercel deploy --prod
```

Or connect the GitHub repository in the Vercel dashboard: `vercel.json` sets the install and build commands, and
every push to `main` deploys automatically.

| Variable                | Required | Purpose                                                                                   |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`      | yes      | OAuth client ID                                                                           |
| `GOOGLE_CLIENT_SECRET`  | yes      | OAuth client secret (sensitive)                                                           |
| `AUTH_SECRET`           | yes      | ≥ 32 random characters, signs session cookies (sensitive; rotating it signs everyone out) |
| `APP_URL`               | no       | Public base URL if not the Vercel production domain (custom domain)                       |
| `ALLOWED_EMAIL_DOMAINS` | no       | e.g. `gmail.com` – only these domains may sign in (empty = any verified Google account)   |
| `ALLOWED_EMAILS`        | no       | Comma-separated addresses that may always sign in (alone: an invite-only list)            |
| `ALLOWED_TARGET_HOSTS`  | no       | Restrict which websites can be tested (`*.example.com` allowed)                           |
| `RUNS_PER_HOUR`         | no       | Runs per user per hour (default 10)                                                       |

The function needs **Fluid compute** (default for new projects) for the 300 s duration; on the Hobby plan this is
the maximum. `GET /api/health` shows whether the required variables are configured (no values are exposed).

## Local development

```bash
# .env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET (OAuth client with the localhost redirect URI)
npm run web:dev                       # http://localhost:3100 – same handler, local Chromium
npm run web:build                     # produces .vercel/output exactly as Vercel does
npx vercel deploy --prebuilt          # optional: deploy a local build as a preview
```

## Files

| Path                                          | Purpose                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| `web/public/`                                 | UI (HTML/CSS/JS, no build step, strict CSP)               |
| `src/web/handler.ts`                          | API router, auth, rate limits, NDJSON streaming           |
| `src/web/google-auth.ts`, `session.ts`        | Google OIDC + signed cookies                              |
| `src/web/browser-tools.ts`                    | playwright-core tools, serverless Chromium, network guard |
| `src/web/web-run.ts`                          | run orchestration, time budget, test-file validation      |
| `scripts/build-web.ts`, `web-dev.ts`          | Build Output API bundle (esbuild) and local dev server    |
| `vercel.json`                                 | install/build commands for Git deployments                |
| `tests/framework/integration/web-app.spec.ts` | end-to-end tests with a mock Google/LLM and real Chromium |
