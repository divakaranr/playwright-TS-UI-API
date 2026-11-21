import type { LlmProviderName } from '../../config/index.js';

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for JSON output where natively supported (best effort). */
  responseFormat?: 'text' | 'json';
  /** Per-call timeout override. */
  timeoutMs?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: LlmProviderName;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  finishReason?: string;
}

/**
 * Provider-agnostic LLM contract. Test code and AI services depend only on this
 * interface; provider specifics (endpoints, auth headers, payload shapes, token
 * accounting) stay inside the adapters.
 */
export interface LLMProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  generate(request: LLMRequest): Promise<LLMResponse>;
}
