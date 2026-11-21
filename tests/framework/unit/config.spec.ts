import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
  assertWriteAllowed,
  getCredentials,
  isTestAllowedInEnvironment,
  loadConfig,
} from '../../../src/config/index.js';
import { ConfigurationError, EnvironmentPolicyError } from '../../../src/core/exceptions/index.js';
import { paths } from '../../../src/utils/paths.js';

test.describe('configuration', () => {
  test('defaults to the local environment with validated values', () => {
    const config = loadConfig({ env: {} });

    expect(config.environment.name).toBe('local');
    expect(config.environment.baseUrl).toBe('http://localhost:4000');
    expect(config.execution).toMatchObject({ ci: false, retries: 0, headless: true });
    expect(config.llm.provider).toBe('none');
    expect(config.mcp.allowedEnvironments).toEqual(['local', 'dev', 'qa']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  for (const env of ['dev', 'qa', 'uat', 'staging', 'prod'] as const) {
    test(`loads the ${env} environment`, () => {
      expect(loadConfig({ env: { TEST_ENV: env } }).environment.name).toBe(env);
    });
  }

  test('environment variables override JSON defaults', () => {
    const config = loadConfig({
      env: {
        TEST_ENV: 'qa',
        BASE_URL: 'https://qa-2.example.com/',
        API_BASE_URL: 'https://api.example.com/v2',
        CI: 'true',
      },
    });

    expect(config.environment.baseUrl).toBe('https://qa-2.example.com');
    expect(config.environment.apiBaseUrl).toBe('https://api.example.com/v2');
    expect(config.execution.retries, 'CI defaults to 2 retries').toBe(2);
  });

  test('fails fast listing every invalid variable', () => {
    const load = () =>
      loadConfig({ env: { TEST_ENV: 'qa', BASE_URL: 'nope', WORKERS: '0', LLM_PROVIDER: 'gpt' } });

    expect(load).toThrow(ConfigurationError);
    expect(load).toThrow(/BASE_URL/);
    expect(load).toThrow(/WORKERS/);
    expect(load).toThrow(/LLM_PROVIDER/);
  });

  test('rejects an unknown environment', () => {
    expect(() => loadConfig({ env: { TEST_ENV: 'production' } })).toThrow(/TEST_ENV/);
  });

  test('rejects an invalid environment file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
    const qa = JSON.parse(readFileSync(path.join(paths.environments, 'qa.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      path.join(dir, 'qa.json'),
      JSON.stringify({ ...qa, baseUrl: 'not-a-url', unexpected: true }),
    );

    expect(() => loadConfig({ env: { TEST_ENV: 'qa' }, configDir: dir })).toThrow(
      /baseUrl[\s\S]*unexpected|unexpected[\s\S]*baseUrl/,
    );
  });

  test('production must stay read-only and MCP may never target it', () => {
    expect(loadConfig({ env: { TEST_ENV: 'prod' } }).environment.readOnly).toBe(true);
    expect(() => loadConfig({ env: { TEST_ENV: 'prod', ALLOW_PROD_WRITES: 'true' } })).toThrow(
      /PROD_WRITE_ALLOWLIST/,
    );
    expect(() => loadConfig({ env: { MCP_ALLOWED_ENVIRONMENTS: 'qa,prod' } })).toThrow(
      /must not include prod/,
    );
  });

  test('credentials are resolved per declared role and never invented', () => {
    const config = loadConfig({ env: {} });
    const env = { APP_ADMIN_USERNAME: 'a@x.io', APP_ADMIN_PASSWORD: 'secret' };

    expect(getCredentials(config, 'admin', env)).toEqual({ username: 'a@x.io', password: 'secret' });
    expect(() => getCredentials(config, 'viewer', env)).toThrow(
      /APP_VIEWER_USERNAME and APP_VIEWER_PASSWORD/,
    );
    expect(() => getCredentials(config, 'superuser', env)).toThrow(/not declared/);
    expect(
      () => getCredentials(loadConfig({ env: { TEST_ENV: 'prod' } }), 'admin', env),
      'prod is least-privilege',
    ).toThrow(/not declared/);
  });
});

test.describe('environment write policy', () => {
  const qa = loadConfig({ env: { TEST_ENV: 'qa' } });
  const prod = loadConfig({ env: { TEST_ENV: 'prod' } });
  const prodOptIn = loadConfig({
    env: {
      TEST_ENV: 'prod',
      ALLOW_PROD_WRITES: 'true',
      PROD_WRITE_ALLOWLIST: 'POST /feedback,PATCH /users/*',
    },
  });

  test('writable environments allow every method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(() => assertWriteAllowed(qa, method, '/users')).not.toThrow();
  });

  test('read-only environments allow safe methods only', () => {
    expect(() => assertWriteAllowed(prod, 'GET', '/users')).not.toThrow();
    expect(() => assertWriteAllowed(prod, 'POST', '/users')).toThrow(EnvironmentPolicyError);
  });

  test('explicit opt-in permits only allow-listed writes and never DELETE', () => {
    expect(() => assertWriteAllowed(prodOptIn, 'POST', '/feedback')).not.toThrow();
    expect(() => assertWriteAllowed(prodOptIn, 'PATCH', '/users/42')).not.toThrow();
    expect(() => assertWriteAllowed(prodOptIn, 'PATCH', '/users/42/roles')).toThrow(/allowlist/);
    expect(() => assertWriteAllowed(prodOptIn, 'POST', '/users')).toThrow(/allowlist/);
    expect(() => assertWriteAllowed(prodOptIn, 'DELETE', '/feedback')).toThrow(/never permitted/);
  });

  test('only @prod-safe, non-destructive tests run in read-only environments', () => {
    expect(isTestAllowedInEnvironment(qa, ['@regression'])).toBe(true);
    expect(isTestAllowedInEnvironment(prod, ['@regression'])).toBe(false);
    expect(isTestAllowedInEnvironment(prod, ['@prod-safe'])).toBe(true);
    expect(isTestAllowedInEnvironment(prod, ['@prod-safe', '@destructive'])).toBe(false);
  });
});
