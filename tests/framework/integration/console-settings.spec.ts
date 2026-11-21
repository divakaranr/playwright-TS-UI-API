import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import type { FetchLike } from '../../../src/ai/providers/http-transport.js';
import { loadConfig } from '../../../src/config/index.js';
import { EncryptedFileStore } from '../../../src/console/secret-store.js';
import { startConsoleServer } from '../../../src/console/server.js';

/**
 * Model settings of the Test Console over HTTP: provider/model/API key are
 * entered in the UI, verified against the provider and stored encrypted.
 * Provider endpoints are faked through `providerFetch` (no network).
 */
const KEY = 'sk-or-v1-integration-0123456789abcdef';

const providerFetch: FetchLike = (url, init) => {
  const auth = (init.headers as Record<string, string>).Authorization;
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (url.startsWith('https://openrouter.ai/api/v1/models'))
    return reply(200, {
      data: [
        { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', supported_parameters: ['tools'] },
        { id: 'meta/no-tools', supported_parameters: [] },
      ],
    });
  if (url.startsWith('https://openrouter.ai/api/v1/key'))
    return auth === `Bearer ${KEY}` ? reply(200, { data: {} }) : reply(401, { error: 'bad key' });
  return Promise.reject(new TypeError('fetch failed'));
};

test.describe('Test Console model settings', () => {
  test.describe.configure({ mode: 'serial' });
  let dir: string;
  let store: EncryptedFileStore;
  let consoleServer: Awaited<ReturnType<typeof startConsoleServer>>;

  const call = (pathname: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${consoleServer.url}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));

  test.beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pw-console-settings-'));
    store = new EncryptedFileStore({
      file: path.join(dir, 'llm.enc.json'),
      keyFile: path.join(dir, 'master.key'),
    });
    consoleServer = await startConsoleServer({
      port: 0,
      llm: loadConfig({ env: {} }).llm,
      secretStore: store,
      providerFetch,
    });
  });
  test.afterAll(async () => {
    await consoleServer?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('starts unconfigured and lists all providers', async () => {
    const res = await call('/api/settings');
    const status = JSON.parse(res.text) as { ready: boolean; providers: Array<{ id: string }> };
    expect(status.ready).toBe(false);
    expect(status.providers.map((p) => p.id)).toEqual(['openrouter', 'openai', 'anthropic', 'ollama']);

    const run = await call('/api/runs', 'POST', {
      targetUrl: 'https://example.com/',
      prompt: 'Test the login page',
    });
    expect(run.status).toBe(400);
    expect(run.text).toContain('Model settings');
  });

  test('rejects non-JSON, cross-site, unknown fields and malformed keys', async () => {
    expect((await call('/api/settings', 'PUT', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(
      (await call('/api/settings', 'DELETE', undefined, { Origin: 'https://attacker.example' })).status,
    ).toBe(403);
    const extra = await call('/api/settings', 'PUT', {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      baseUrl: 'http://169.254.169.254/',
    });
    expect(extra.status).toBe(400);
    expect(extra.text).toMatch(/Unrecognized key/);
    const bad = await call('/api/settings', 'PUT', {
      provider: 'evil',
      model: '<img src=x onerror=alert(1)>',
      apiKey: 'has spaces in it',
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/provider/);
    expect(bad.text).toMatch(/Model: use a model from the list/);
    expect(bad.text).toMatch(/API key: must be one token/);
  });

  test('lists tool-calling models, verifies the key and saves encrypted', async () => {
    const models = JSON.parse(
      (await call('/api/settings/models', 'POST', { provider: 'openrouter' })).text,
    ) as {
      models: Array<{ id: string }>;
    };
    expect(models.models.map((m) => m.id)).toEqual(['openai/gpt-4o-mini']);

    const wrong = await call('/api/settings', 'PUT', {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      apiKey: 'sk-or-wrong-key-123',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain('rejected by OpenRouter');

    const saved = await call('/api/settings', 'PUT', {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      apiKey: KEY,
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(KEY);
    expect(JSON.parse(saved.text)).toMatchObject({
      ready: true,
      source: 'saved',
      model: 'openai/gpt-4o-mini',
    });
    expect(readFileSync(store.file, 'utf8')).not.toContain(KEY);
    expect(store.read()).toMatchObject({ apiKeys: { openrouter: KEY } });

    const status = JSON.parse((await call('/api/status')).text) as { llm: Record<string, unknown> };
    expect(status.llm).toMatchObject({ ready: true, provider: 'openrouter', source: 'saved' });
    for (const p of ['/api/status', '/api/settings']) expect((await call(p)).text).not.toContain(KEY);
  });

  test('forgetting the settings deletes the encrypted file', async () => {
    const res = await call('/api/settings', 'DELETE');
    expect(JSON.parse(res.text)).toMatchObject({ ready: false });
    expect(store.exists()).toBe(false);
  });
});
