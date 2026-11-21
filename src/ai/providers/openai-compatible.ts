import type { LlmProviderName } from '../../config/index.js';
import { asNumber, asString, pick, type LlmHttpTransport } from './http-transport.js';
import { LlmError } from './llm-error.js';
import type { LLMRequest, LLMResponse } from './llm-provider.interface.js';

export interface ChatCompletionsOptions {
  provider: LlmProviderName;
  url: string;
  model: string;
  headers: Record<string, string>;
  /** OpenAI uses `max_completion_tokens`; most compatible APIs use `max_tokens`. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** Whether `response_format: {type: 'json_object'}` is supported. */
  supportsJsonMode: boolean;
}

/** Shared implementation of the OpenAI Chat Completions wire format (OpenAI, OpenRouter, …). */
export async function chatCompletions(
  transport: LlmHttpTransport,
  options: ChatCompletionsOptions,
  request: LLMRequest,
): Promise<LLMResponse> {
  const started = performance.now();
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ],
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { [options.maxTokensField]: request.maxTokens } : {}),
    ...(request.responseFormat === 'json' && options.supportsJsonMode
      ? { response_format: { type: 'json_object' } }
      : {}),
  };

  const json = await transport.postJson(options.url, body, options.headers, request.timeoutMs);
  const content = asString(pick(json, 'choices', 0, 'message', 'content'));
  if (content === undefined) {
    throw new LlmError(
      options.provider,
      'invalid_response',
      'response contained no choices[0].message.content',
    );
  }
  const inputTokens = asNumber(pick(json, 'usage', 'prompt_tokens'));
  const outputTokens = asNumber(pick(json, 'usage', 'completion_tokens'));
  const finishReason = asString(pick(json, 'choices', 0, 'finish_reason'));
  return {
    content,
    model: asString(pick(json, 'model')) ?? options.model,
    provider: options.provider,
    latencyMs: Math.round(performance.now() - started),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}
