import { expect as baseExpect, request, test } from '@playwright/test';
import * as z from 'zod';

import { BearerTokenProvider } from '../../../src/api/auth/auth-provider.js';
import { BaseApiClient } from '../../../src/api/clients/base-api.client.js';
import { loadConfig, type FrameworkConfig } from '../../../src/config/index.js';
import { expect } from '../../../src/core/assertions/index.js';
import { ApiCallRecorder } from '../../../src/core/diagnostics/api-call.recorder.js';
import {
  ApiRequestError,
  EnvironmentPolicyError,
  SchemaValidationError,
} from '../../../src/core/exceptions/index.js';
import { json, MockServer } from '../support/mock-server.js';

test.describe('BaseApiClient (against a mock server)', () => {
  const server = new MockServer();
  let baseUrl: string;

  test.beforeAll(async () => {
    server.on((req, res) => {
      if (req.url.startsWith('/v1/items'))
        return json(
          res,
          200,
          { id: 1, name: 'widget' },
          { 'X-Correlation-Id': String(req.headers['x-correlation-id']) },
        );
      if (req.url.startsWith('/v1/broken')) return json(res, 503, { error: 'down' });
      return json(res, 404, { error: 'not found' });
    });
    baseUrl = `${await server.start()}/v1`;
  });
  test.afterAll(() => server.stop());

  function client(config: FrameworkConfig, recorder = new ApiCallRecorder()) {
    return request.newContext().then((ctx) => ({
      ctx,
      recorder,
      api: new BaseApiClient(ctx, {
        baseUrl,
        config,
        recorder,
        auth: new BearerTokenProvider(async () => 'super-secret-token'),
      }),
    }));
  }

  test('resolves endpoints under the base path and sends auth, correlation and query params', async () => {
    const { ctx, api } = await client(loadConfig({ env: {} }));

    const response = await api.get('/items', { params: { q: 'a b', page: 2, skip: undefined } });

    await expect(response).toHaveStatus(200);
    const last = server.requests.at(-1)!;
    baseExpect(last.url).toBe('/v1/items?q=a+b&page=2');
    baseExpect(last.headers.authorization).toBe('Bearer super-secret-token');
    baseExpect(last.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    baseExpect(response.correlationId).toBe(last.headers['x-correlation-id']);
    baseExpect(response.durationMs).toBeGreaterThanOrEqual(0);
    await ctx.dispose();
  });

  test('parse() validates schemas and reports every issue', async () => {
    const { ctx, api } = await client(loadConfig({ env: {} }));
    const response = await api.get('items');

    baseExpect(await response.parse(z.object({ id: z.number(), name: z.string() }))).toEqual({
      id: 1,
      name: 'widget',
    });
    await baseExpect(response.parse(z.object({ id: z.string(), price: z.number() }))).rejects.toThrow(
      SchemaValidationError,
    );
    await expect(response).not.toMatchSchema(z.object({ id: z.string() }));
    await ctx.dispose();
  });

  test('records sanitised diagnostics and never throws on HTTP errors', async () => {
    const { ctx, api, recorder } = await client(loadConfig({ env: {} }));

    const response = await api.post('/broken', { password: 'p4ss', name: 'x' });

    await expect(response).toHaveStatus(503);
    const record = recorder.all().at(-1)!;
    baseExpect(record.requestHeaders.Authorization).toBe('[REDACTED]');
    baseExpect(record.requestBody).toEqual({ password: '[REDACTED]', name: 'x' });
    baseExpect(recorder.failures()).toHaveLength(1);
    baseExpect(JSON.stringify(recorder.all())).not.toContain('super-secret-token');
    await ctx.dispose();
  });

  test('blocks writes in read-only environments before any request is sent', async () => {
    const { ctx, api } = await client(loadConfig({ env: { TEST_ENV: 'prod' } }));
    const before = server.requests.length;

    await baseExpect(api.post('/items', {})).rejects.toThrow(EnvironmentPolicyError);
    await baseExpect(api.delete('/items/1')).rejects.toThrow(/never permitted/);
    baseExpect(server.requests.length, 'no request reached the server').toBe(before);
    await expect(await api.get('/items')).toHaveStatus(200);
    await ctx.dispose();
  });

  test('refuses cross-origin absolute URLs', async () => {
    const { ctx, api } = await client(loadConfig({ env: {} }));
    await baseExpect(api.get('https://evil.example.com/steal')).rejects.toThrow(/cross-origin/);
    await ctx.dispose();
  });

  test('wraps transport failures in ApiRequestError', async () => {
    const ctx = await request.newContext();
    const api = new BaseApiClient(ctx, {
      baseUrl: 'http://127.0.0.1:1',
      config: loadConfig({ env: {} }),
      timeoutMs: 2000,
    });

    await baseExpect(api.get('/anything')).rejects.toThrow(ApiRequestError);
    await ctx.dispose();
  });
});
