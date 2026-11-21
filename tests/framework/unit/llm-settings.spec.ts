import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import type { FetchLike } from '../../../src/ai/providers/http-transport.js';
import { LlmError } from '../../../src/ai/providers/llm-error.js';
import { listToolCallingModels } from '../../../src/ai/providers/model-catalog.js';
import {
  AnthropicToolChat,
  toAnthropicMessages,
  type AgentMessage,
} from '../../../src/ai/providers/tool-chat.js';
import { LlmHttpTransport } from '../../../src/ai/providers/http-transport.js';
import { loadConfig } from '../../../src/config/index.js';
import { LlmSettings, SettingsError } from '../../../src/console/llm-settings.js';
import { EncryptedFileStore, SecretStoreError } from '../../../src/console/secret-store.js';

const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

type Route = (url: string, init: RequestInit) => { status?: number; body: unknown };
/** Minimal fetch double: first route whose prefix matches the URL answers. */
function mockFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(init.body ? { body: JSON.parse(init.body as string) as unknown } : {}),
    });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) return Promise.reject(new TypeError(`fetch failed: ${url}`));
    const { status = 200, body } = route[1](url, init);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchImpl, calls };
}

const OPENROUTER_MODELS = {
  data: [
    {
      id: 'openai/gpt-4o-mini',
      name: 'GPT-4o mini',
      context_length: 128000,
      supported_parameters: ['tools'],
    },
    { id: 'google/gemini-3.8-flash', name: 'Gemini', supported_parameters: ['tools', 'temperature'] },
    { id: 'some/text-only', supported_parameters: ['temperature'] },
    { id: 'bad id with spaces', supported_parameters: ['tools'] },
    { id: '<script>', supported_parameters: ['tools'] },
  ],
};
const openRouterRoutes = (validKey = SECRET): Record<string, Route> => ({
  'https://openrouter.ai/api/v1/models': () => ({ body: OPENROUTER_MODELS }),
  'https://openrouter.ai/api/v1/key': (_url, init) =>
    (init.headers as Record<string, string>).Authorization === `Bearer ${validKey}`
      ? { body: { data: { label: 'x' } } }
      : { status: 401, body: { error: { message: 'No auth credentials found' } } },
});

const envLlm = (env: Record<string, string> = {}) => loadConfig({ env }).llm;

test.describe('Encrypted secret store', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pw-secrets-'));
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('round-trips with a generated master key file and stores ciphertext only', () => {
    const keyFile = path.join(dir, 'home', 'master.key');
    const store = new EncryptedFileStore({ file: path.join(dir, 'proj', 'secrets.enc.json'), keyFile });
    expect(store.read()).toBeUndefined();
    store.write({ apiKeys: { openrouter: SECRET } });

    expect(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64')).toHaveLength(32);
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('openrouter');
    expect(JSON.parse(raw)).toMatchObject({ cipher: 'aes-256-gcm', kdf: 'keyfile', version: 1 });
    if (process.platform !== 'win32') expect(statSync(store.file).mode & 0o077).toBe(0);
    expect(store.read()).toEqual({ apiKeys: { openrouter: SECRET } });

    // A new IV on every write: same plaintext, different ciphertext.
    store.write({ apiKeys: { openrouter: SECRET } });
    expect(readFileSync(store.file, 'utf8')).not.toBe(raw);
  });

  test('detects tampering and refuses a different master key', () => {
    const file = path.join(dir, 's.json');
    new EncryptedFileStore({ file, keyFile: path.join(dir, 'a.key') }).write({ v: 1 });
    expect(() => new EncryptedFileStore({ file, keyFile: path.join(dir, 'b.key') }).read()).toThrow(
      SecretStoreError,
    );

    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { data: string };
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(file, JSON.stringify({ ...envelope, data: bytes.toString('base64') }));
    expect(() => new EncryptedFileStore({ file, keyFile: path.join(dir, 'a.key') }).read()).toThrow(
      /wrong master key or the file was modified/,
    );
    writeFileSync(file, '{"format":"other"}');
    expect(() => new EncryptedFileStore({ file, keyFile: path.join(dir, 'a.key') }).read()).toThrow(
      /corrupted/,
    );
  });

  test('passphrase mode uses scrypt with a random salt', () => {
    const file = path.join(dir, 's.json');
    const store = new EncryptedFileStore({ file, passphrase: 'correct horse battery staple' });
    store.write({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ kdf: 'scrypt', salt: expect.any(String) });
    expect(store.read()).toEqual({ ok: true });
    expect(() => new EncryptedFileStore({ file, passphrase: 'wrong horse battery staple' }).read()).toThrow(
      SecretStoreError,
    );
    expect(() => new EncryptedFileStore({ file, keyFile: path.join(dir, 'k') }).read()).toThrow(
      /encrypted with a passphrase/,
    );
    expect(() => new EncryptedFileStore({ file, passphrase: 'short' })).toThrow(/at least 16/);
    store.clear();
    expect(store.exists()).toBe(false);
  });
});

test.describe('Model catalogue', () => {
  test('OpenRouter: only tool-calling models with safe ids, sorted', async () => {
    const { fetchImpl, calls } = mockFetch(openRouterRoutes());
    const models = await listToolCallingModels('openrouter', { fetch: fetchImpl });
    expect(models).toEqual([
      { id: 'google/gemini-3.8-flash', name: 'Gemini' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', contextLength: 128000 },
    ]);
    expect(calls[0]!.url).toContain('supported_parameters=tools');
  });

  test('OpenAI: chat models only and a key is required', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.openai.com/v1/models': () => ({
        body: {
          data: [
            'gpt-4o',
            'o3-mini',
            'text-embedding-3-small',
            'whisper-1',
            'gpt-4o-realtime-preview',
            'dall-e-3',
          ].map((id) => ({ id })),
        },
      }),
    });
    await expect(listToolCallingModels('openai', { fetch: fetchImpl })).rejects.toMatchObject({
      kind: 'configuration',
    });
    const models = await listToolCallingModels('openai', { fetch: fetchImpl, apiKey: 'sk-test-123456' });
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'o3-mini']);
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-test-123456');
  });

  test('Anthropic: sends x-api-key and maps 401 to an authentication error', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.anthropic.com/v1/models': (_u, init) =>
        (init.headers as Record<string, string>)['x-api-key'] === 'sk-ant-good-key'
          ? { body: { data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] } }
          : { status: 401, body: { error: { message: 'invalid x-api-key' } } },
    });
    expect(await listToolCallingModels('anthropic', { fetch: fetchImpl, apiKey: 'sk-ant-good-key' })).toEqual(
      [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    );
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    const error = await listToolCallingModels('anthropic', {
      fetch: fetchImpl,
      apiKey: 'sk-ant-bad-key',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'authentication', status: 401 });
  });

  test('Ollama: lists local models without a key', async () => {
    const { fetchImpl } = mockFetch({
      'http://localhost:11434/api/tags': () => ({
        body: { models: [{ name: 'qwen3:8b' }, { name: 'llama3.1:8b' }] },
      }),
    });
    expect((await listToolCallingModels('ollama', { fetch: fetchImpl })).map((m) => m.id)).toEqual([
      'llama3.1:8b',
      'qwen3:8b',
    ]);
  });
});

test.describe('Anthropic tool chat', () => {
  test('maps the transcript to alternating messages with tool_use / tool_result blocks', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'test login' },
      {
        role: 'assistant',
        content: 'navigating',
        toolCalls: [
          { id: 't1', name: 'browser_navigate', arguments: '{"url":"https://x.test/"}' },
          { id: 't2', name: 'browser_snapshot', arguments: 'not json' },
        ],
      },
      { role: 'tool', toolCallId: 't1', content: 'ok' },
      { role: 'tool', toolCallId: 't2', content: 'tree' },
      { role: 'user', content: 'continue' },
    ];
    expect(toAnthropicMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'test login' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'navigating' },
          { type: 'tool_use', id: 't1', name: 'browser_navigate', input: { url: 'https://x.test/' } },
          { type: 'tool_use', id: 't2', name: 'browser_snapshot', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 't2', content: 'tree' },
          { type: 'text', text: 'continue' },
        ],
      },
    ]);
  });

  test('declares tools, parses tool_use, and forbids tools on the final tool-less request', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://api.anthropic.com/v1/messages': () => ({
        body: {
          model: 'claude-x',
          content: [
            { type: 'text', text: 'Looking' },
            { type: 'tool_use', id: 'toolu_1', name: 'browser_snapshot', input: { a: 1 } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 12, output_tokens: 3 },
        },
      }),
    });
    const chat = new AnthropicToolChat(
      'claude-x',
      { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': 'k' } },
      new LlmHttpTransport({ provider: 'anthropic', timeoutMs: 5000, maxRetries: 0, fetch: fetchImpl }),
    );
    const tool = { name: 'browser_snapshot', description: 'snap', parameters: { type: 'object' } };
    const response = await chat.chat({
      messages: [
        { role: 'system', content: 'only test' },
        { role: 'user', content: 'go' },
      ],
      tools: [tool],
    });
    expect(response).toMatchObject({
      content: 'Looking',
      toolCalls: [{ id: 'toolu_1', name: 'browser_snapshot', arguments: '{"a":1}' }],
      inputTokens: 12,
      finishReason: 'tool_use',
    });
    expect(calls[0]!.body).toMatchObject({
      system: 'only test',
      max_tokens: 4096,
      tools: [{ name: 'browser_snapshot', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    });
    await chat.chat({ messages: [{ role: 'user', content: 'report' }], tools: [] });
    expect(calls[1]!.body).toMatchObject({
      tools: [{ name: 'browser_snapshot' }],
      tool_choice: { type: 'none' },
    });
  });
});

test.describe('LLM settings', () => {
  let dir: string;
  let store: EncryptedFileStore;
  test.beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pw-settings-'));
    store = new EncryptedFileStore({
      file: path.join(dir, 'llm.enc.json'),
      keyFile: path.join(dir, 'master.key'),
    });
  });
  test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('falls back to .env and never exposes the key in status', () => {
    const settings = new LlmSettings({
      env: envLlm({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'google/gemini-3.8-flash', LLM_API_KEY: SECRET }),
      store,
    });
    const status = settings.status();
    expect(status).toMatchObject({ ready: true, source: 'env', provider: 'openrouter', encrypted: true });
    expect(status.providers.find((p) => p.id === 'openrouter')!.apiKey).toEqual({
      source: 'env',
      hint: `••••${SECRET.slice(-4)}`,
    });
    expect(JSON.stringify(status)).not.toContain(SECRET.slice(0, 12));
    expect(new LlmSettings({ env: envLlm(), store }).status()).toMatchObject({
      ready: false,
      provider: null,
    });
  });

  test('verifies key and model before saving, then persists encrypted', async () => {
    const { fetchImpl } = mockFetch(openRouterRoutes());
    const settings = new LlmSettings({ env: envLlm(), store, fetch: fetchImpl });

    const badKey = await settings
      .save({ provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: 'sk-or-wrong-key' })
      .catch((e: unknown) => e);
    expect(badKey).toBeInstanceOf(SettingsError);
    expect((badKey as SettingsError).errors).toEqual(['API key: rejected by OpenRouter (HTTP 401)']);

    await expect(
      settings.save({ provider: 'openrouter', model: 'some/text-only', apiKey: SECRET }),
    ).rejects.toThrow(/not offered by OpenRouter for tool calling/);
    await expect(settings.save({ provider: 'openai', model: 'gpt-4o' })).rejects.toThrow(
      /API key: required for OpenAI/,
    );
    expect(store.exists()).toBe(false);

    const status = await settings.save({
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      apiKey: SECRET,
    });
    expect(status).toMatchObject({ ready: true, source: 'saved', model: 'openai/gpt-4o-mini' });
    expect(readFileSync(store.file, 'utf8')).not.toContain(SECRET);

    // A restarted console decrypts the same settings; the key is reused without re-entering it.
    const restarted = new LlmSettings({ env: envLlm(), store, fetch: fetchImpl });
    expect(restarted.llmConfig()).toMatchObject({ provider: 'openrouter', apiKey: SECRET });
    await restarted.save({ provider: 'openrouter', model: 'google/gemini-3.8-flash' });
    expect(restarted.status().model).toBe('google/gemini-3.8-flash');

    // Switching provider keeps the OpenRouter key; Ollama needs none.
    const ollama = mockFetch({
      'http://localhost:11434/api/tags': () => ({ body: { models: [{ name: 'qwen3:8b' }] } }),
    });
    const local = new LlmSettings({ env: envLlm(), store, fetch: ollama.fetchImpl });
    await local.save({ provider: 'ollama', model: 'qwen3:8b' });
    expect(local.llmConfig()).toMatchObject({
      provider: 'ollama',
      apiKey: undefined,
      baseUrl: 'http://localhost:11434',
    });
    expect(local.status().providers.find((p) => p.id === 'openrouter')!.apiKey.source).toBe('saved');

    expect(local.clear()).toMatchObject({ ready: false, source: 'none' });
    expect(store.exists()).toBe(false);
  });

  test('an unreadable store is reported, not fatal', () => {
    writeFileSync(store.file, 'garbage');
    const settings = new LlmSettings({
      env: envLlm({ LLM_PROVIDER: 'openrouter', LLM_MODEL: 'a/b', LLM_API_KEY: SECRET }),
      store,
    });
    expect(settings.status()).toMatchObject({
      ready: true,
      source: 'env',
      warning: expect.stringMatching(/corrupted/),
    });
  });

  test('unreachable providers produce a clear message', async () => {
    const settings = new LlmSettings({ env: envLlm(), store, fetch: mockFetch({}).fetchImpl });
    const error = (await settings.listModels('ollama').catch((e: unknown) => e)) as SettingsError;
    expect(error.status).toBe(502);
    expect(error.errors[0]).toMatch(/Ollama \(local\) is not reachable at http:\/\/localhost:11434/);
  });
});
