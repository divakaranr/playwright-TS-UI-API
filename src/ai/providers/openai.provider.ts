import type { LlmHttpTransport } from './http-transport.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.interface.js';
import { chatCompletions } from './openai-compatible.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Default https://api.openai.com/v1 (also works for Azure OpenAI-compatible gateways). */
  baseUrl?: string;
}

/** OpenAI Chat Completions adapter. */
export class OpenAiProvider implements LLMProvider {
  readonly name = 'openai' as const;
  readonly model: string;

  constructor(
    private readonly options: OpenAiProviderOptions,
    private readonly transport: LlmHttpTransport,
  ) {
    this.model = options.model;
  }

  generate(request: LLMRequest): Promise<LLMResponse> {
    const base = (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    return chatCompletions(
      this.transport,
      {
        provider: this.name,
        url: `${base}/chat/completions`,
        model: this.model,
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        maxTokensField: 'max_completion_tokens',
        supportsJsonMode: true,
      },
      request,
    );
  }
}
