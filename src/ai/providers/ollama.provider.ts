import { asNumber, asString, pick, type LlmHttpTransport } from './http-transport.js';
import { LlmError } from './llm-error.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.interface.js';

export interface OllamaProviderOptions {
  model: string;
  /** Default http://localhost:11434 */
  baseUrl?: string;
}

/**
 * Ollama adapter (local models). Data never leaves the machine/organisation,
 * which makes it the recommended provider for sensitive environments.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly model: string;

  constructor(
    private readonly options: OllamaProviderOptions,
    private readonly transport: LlmHttpTransport,
  ) {
    this.model = options.model;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const started = performance.now();
    const base = (this.options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    const options: Record<string, number> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;

    const json = await this.transport.postJson(
      `${base}/api/chat`,
      {
        model: this.model,
        stream: false,
        messages: [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
      },
      {},
      request.timeoutMs,
    );

    const content = asString(pick(json, 'message', 'content'));
    if (content === undefined)
      throw new LlmError(this.name, 'invalid_response', 'response contained no message.content');
    const inputTokens = asNumber(pick(json, 'prompt_eval_count'));
    const outputTokens = asNumber(pick(json, 'eval_count'));
    const finishReason = asString(pick(json, 'done_reason'));
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
