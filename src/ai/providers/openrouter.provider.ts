import type { LlmHttpTransport } from './http-transport.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.interface.js';
import { chatCompletions } from './openai-compatible.js';

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** e.g. "anthropic/claude-sonnet-…" or "openai/gpt-…" – OpenRouter model slug. */
  model: string;
  baseUrl?: string;
  /** Optional attribution headers recommended by OpenRouter. */
  appName?: string;
  appUrl?: string;
}

/**
 * OpenRouter adapter (OpenAI-compatible API in front of many model vendors).
 * JSON mode is not requested because support varies per routed model; the
 * structured-output layer validates and repairs JSON instead.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter' as const;
  readonly model: string;

  constructor(
    private readonly options: OpenRouterProviderOptions,
    private readonly transport: LlmHttpTransport,
  ) {
    this.model = options.model;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    const base = (this.options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    return chatCompletions(
      this.transport,
      {
        provider: this.name,
        url: `${base}/chat/completions`,
        model: this.model,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'X-Title': this.options.appName ?? 'playwright-enterprise-framework',
          ...(this.options.appUrl ? { 'HTTP-Referer': this.options.appUrl } : {}),
        },
        maxTokensField: 'max_tokens',
        supportsJsonMode: false,
      },
      request,
    );
  }
}
