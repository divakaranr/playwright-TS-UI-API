import { asNumber, asString, pick, type LlmHttpTransport } from './http-transport.js';
import { LlmError } from './llm-error.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.interface.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Anthropic requires max_tokens on every request (default 4096). */
  defaultMaxTokens?: number;
}

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic Messages API adapter. */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;

  constructor(
    private readonly options: AnthropicProviderOptions,
    private readonly transport: LlmHttpTransport,
  ) {
    this.model = options.model;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const started = performance.now();
    const base = (this.options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const json = await this.transport.postJson(
      `${base}/v1/messages`,
      {
        model: this.model,
        system: request.systemPrompt,
        messages: [{ role: 'user', content: request.userPrompt }],
        max_tokens: request.maxTokens ?? this.options.defaultMaxTokens ?? 4096,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      { 'x-api-key': this.options.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      request.timeoutMs,
    );

    const blocks = pick(json, 'content');
    const content = Array.isArray(blocks)
      ? blocks
          .filter(
            (b): b is { type: string; text: string } =>
              pick(b, 'type') === 'text' && typeof pick(b, 'text') === 'string',
          )
          .map((b) => b.text)
          .join('')
      : undefined;
    if (content === undefined)
      throw new LlmError(this.name, 'invalid_response', 'response contained no content blocks');

    const inputTokens = asNumber(pick(json, 'usage', 'input_tokens'));
    const outputTokens = asNumber(pick(json, 'usage', 'output_tokens'));
    const finishReason = asString(pick(json, 'stop_reason'));
    return {
      content,
      model: asString(pick(json, 'model')) ?? this.model,
      provider: this.name,
      latencyMs: Math.round(performance.now() - started),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }
}
