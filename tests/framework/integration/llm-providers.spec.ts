import { expect, test } from '@playwright/test';

import {
  AnthropicProvider,
  createLlmProvider,
  isLlmConfigured,
  LlmError,
  LlmHttpTransport,
  OllamaProvider,
  OpenAiProvider,
  OpenRouterProvider,
  UsageTracker,
} from '../../../src/ai/providers/index.js';
import { loadConfig } from '../../../src/config/index.js';
import { json, MockServer } from '../support/mock-server.js';

const REQUEST = { systemPrompt: 'You are a test.', userPrompt: 'Say OK', temperature: 0, maxTokens: 50 };

test.describe('LLM provider adapters (mocked HTTP)', () => {
  const server = new MockServer();
  let base: string;
  let behaviour: (
    url: string,
    attempt: number,
  ) => { status: number; body: unknown; headers?: Record<string, string>; delayMs?: number };
  const attempts = new Map<string, number>();

  test.beforeAll(async () => {
    server.on(async (req, res) => {
      const count = (attempts.get(req.url) ?? 0) + 1;
      attempts.set(req.url, count);
      const reply = behaviour(req.url, count);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      json(res, reply.status, reply.body, reply.headers);
    });
    base = await server.start();
  });
  test.afterAll(() => server.stop());
  test.beforeEach(() => {
    attempts.clear();
    server.requests.length = 0;
  });

  const transport = (overrides: Partial<ConstructorParameters<typeof LlmHttpTransport>[0]> = {}) =>
    new LlmHttpTransport({ provider: 'test', timeoutMs: 2000, maxRetries: 2, ...overrides });

  test('OpenAI: chat completions request shape, content and usage', async () => {
    behaviour = () => ({
      status: 200,
      body: {
        model: 'gpt-x-2026',
        choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      },
    });
    const provider = new OpenAiProvider(
      { apiKey: 'sk-test-key-123', model: 'gpt-x', baseUrl: `${base}/v1` },
      transport(),
    );

    const response = await provider.generate({ ...REQUEST, responseFormat: 'json' });

    expect(response).toMatchObject({
      content: 'OK',
      model: 'gpt-x-2026',
      provider: 'openai',
      inputTokens: 12,
      outputTokens: 2,
      finishReason: 'stop',
    });
    const sent = server.requests[0]!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-test-key-123');
    expect(JSON.parse(sent.body)).toEqual({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Say OK' },
      ],
      temperature: 0,
      max_completion_tokens: 50,
      response_format: { type: 'json_object' },
    });
  });

  test('Anthropic: messages API request shape, content blocks and usage', async () => {
    behaviour = () => ({
      status: 200,
      body: {
        model: 'claude-x',
        content: [
          { type: 'text', text: 'O' },
          { type: 'text', text: 'K' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 1 },
      },
    });
    const provider = new AnthropicProvider(
      { apiKey: 'anthropic-key', model: 'claude-x', baseUrl: base },
      transport(),
    );

    const response = await provider.generate(REQUEST);

    expect(response).toMatchObject({
      content: 'OK',
      provider: 'anthropic',
      inputTokens: 9,
      outputTokens: 1,
      finishReason: 'end_turn',
    });
    const sent = server.requests[0]!;
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('anthropic-key');
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(sent.body)).toEqual({
      model: 'claude-x',
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'Say OK' }],
      max_tokens: 50,
      temperature: 0,
    });
  });

  test('OpenRouter: OpenAI-compatible with attribution headers and max_tokens', async () => {
    behaviour = () => ({
      status: 200,
      body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    });
    const provider = new OpenRouterProvider(
      { apiKey: 'or-key', model: 'vendor/model', baseUrl: `${base}/api/v1` },
      transport(),
    );

    const response = await provider.generate(REQUEST);

    expect(response).toMatchObject({ content: 'OK', provider: 'openrouter', model: 'vendor/model' });
    const sent = server.requests[0]!;
    expect(sent.url).toBe('/api/v1/chat/completions');
    expect(sent.headers['x-title']).toBe('playwright-enterprise-framework');
    expect(JSON.parse(sent.body)).toMatchObject({ max_tokens: 50 });
    expect(JSON.parse(sent.body)).not.toHaveProperty('response_format');
  });

  test('Ollama: local chat API with options and eval counts', async () => {
    behaviour = () => ({
      status: 200,
      body: {
        model: 'llama-x',
        message: { role: 'assistant', content: 'OK' },
        prompt_eval_count: 20,
        eval_count: 3,
        done_reason: 'stop',
      },
    });
    const provider = new OllamaProvider({ model: 'llama-x', baseUrl: base }, transport());

    const response = await provider.generate({ ...REQUEST, responseFormat: 'json' });

    expect(response).toMatchObject({ content: 'OK', provider: 'ollama', inputTokens: 20, outputTokens: 3 });
    expect(server.requests[0]!.url).toBe('/api/chat');
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      stream: false,
      format: 'json',
      options: { temperature: 0, num_predict: 50 },
    });
  });

  test('retries rate limits honouring Retry-After, then succeeds', async () => {
    behaviour = (_url, attempt) =>
      attempt === 1
        ? { status: 429, body: { error: 'slow down' }, headers: { 'Retry-After': '0' } }
        : { status: 200, body: { choices: [{ message: { content: 'OK' } }] } };
    const provider = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: base }, transport());

    expect((await provider.generate(REQUEST)).content).toBe('OK');
    expect(server.requests).toHaveLength(2);
  });

  test('normalises errors: auth is not retried, server errors are retried then surfaced', async () => {
    behaviour = () => ({
      status: 401,
      body: { error: { message: 'invalid key sk-abcdefghijklmnopqrstuvwx' } },
    });
    const openai = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: base }, transport());
    const authError = (await openai.generate(REQUEST).then(
      () => undefined,
      (e: unknown) => e,
    )) as LlmError;
    expect(authError).toBeInstanceOf(LlmError);
    expect(authError).toMatchObject({ kind: 'authentication', status: 401, retryable: false });
    expect(authError.message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(server.requests).toHaveLength(1);

    server.requests.length = 0;
    behaviour = () => ({ status: 503, body: { error: 'overloaded' } });
    const fast = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: base }, transport({ maxRetries: 1 }));
    await expect(fast.generate(REQUEST)).rejects.toMatchObject({ kind: 'server', status: 503 });
    expect(server.requests).toHaveLength(2);
  });

  test('times out slow providers and rejects malformed responses', async () => {
    behaviour = () => ({ status: 200, body: {}, delayMs: 1500 });
    const slow = new OllamaProvider(
      { model: 'm', baseUrl: base },
      transport({ timeoutMs: 300, maxRetries: 0 }),
    );
    await expect(slow.generate(REQUEST)).rejects.toMatchObject({ kind: 'timeout' });

    behaviour = () => ({ status: 200, body: { unexpected: true } });
    const odd = new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }, transport());
    await expect(odd.generate(REQUEST)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  test('factory selects providers from configuration and tracks usage', async () => {
    behaviour = () => ({
      status: 200,
      body: { message: { content: 'OK' }, prompt_eval_count: 5, eval_count: 2 },
    });
    const config = loadConfig({ env: { LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama-x', LLM_BASE_URL: base } });
    const usage = new UsageTracker();
    const provider = createLlmProvider(config.llm, { usage });

    expect(provider.name).toBe('ollama');
    await provider.generate(REQUEST);
    await provider.generate(REQUEST);
    expect(usage.snapshot()).toMatchObject({ calls: 2, failures: 0, inputTokens: 10, outputTokens: 4 });

    for (const name of ['openai', 'anthropic', 'openrouter'] as const) {
      const cfg = loadConfig({ env: { LLM_PROVIDER: name, LLM_MODEL: 'm', LLM_API_KEY: 'key' } });
      expect(createLlmProvider(cfg.llm).name).toBe(name);
    }
  });

  test('factory fails with actionable configuration errors', () => {
    const none = loadConfig({ env: {} }).llm;
    expect(isLlmConfigured(none)).toBe(false);
    expect(() => createLlmProvider(none)).toThrow(/No LLM provider configured/);
    expect(() =>
      createLlmProvider(loadConfig({ env: { LLM_PROVIDER: 'openai', LLM_MODEL: 'm' } }).llm),
    ).toThrow(/LLM_API_KEY is required/);
    expect(() => createLlmProvider(loadConfig({ env: { LLM_PROVIDER: 'ollama' } }).llm)).toThrow(
      /LLM_MODEL is required/,
    );
    expect(isLlmConfigured(loadConfig({ env: { LLM_PROVIDER: 'ollama', LLM_MODEL: 'x' } }).llm)).toBe(true);
  });
});
