import type { FrameworkConfig } from '../../config/index.js';
import type { Logger } from '../../utils/logger.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { LlmHttpTransport, type FetchLike } from './http-transport.js';
import { LlmError } from './llm-error.js';
import type { LLMProvider } from './llm-provider.interface.js';
import { OllamaProvider } from './ollama.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { OpenRouterProvider } from './openrouter.provider.js';
import { TrackedLlmProvider, UsageTracker } from './usage-tracker.js';

export interface ProviderFactoryDeps {
  fetch?: FetchLike;
  logger?: Logger;
  usage?: UsageTracker;
}

export function isLlmConfigured(llm: FrameworkConfig['llm']): boolean {
  if (llm.provider === 'none' || !llm.model) return false;
  return llm.provider === 'ollama' || Boolean(llm.apiKey);
}

/**
 * Creates the configured provider (LLM_PROVIDER / LLM_MODEL / LLM_API_KEY /
 * LLM_BASE_URL). Throws a `configuration` LlmError with an actionable message
 * when AI features are used without configuration – deterministic test
 * execution never calls this.
 */
export function createLlmProvider(
  llm: FrameworkConfig['llm'],
  deps: ProviderFactoryDeps = {},
): TrackedLlmProvider {
  if (llm.provider === 'none') {
    throw new LlmError(
      'none',
      'configuration',
      'No LLM provider configured. Set LLM_PROVIDER (openai|anthropic|openrouter|ollama) and LLM_MODEL.',
    );
  }
  if (!llm.model) throw new LlmError(llm.provider, 'configuration', 'LLM_MODEL is required');
  if (llm.provider !== 'ollama' && !llm.apiKey) {
    throw new LlmError(llm.provider, 'configuration', 'LLM_API_KEY is required for this provider');
  }

  const transport = new LlmHttpTransport({
    provider: llm.provider,
    timeoutMs: llm.timeoutMs,
    maxRetries: llm.maxRetries,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  const baseUrl = llm.baseUrl ? { baseUrl: llm.baseUrl } : {};

  let provider: LLMProvider;
  switch (llm.provider) {
    case 'openai':
      provider = new OpenAiProvider({ apiKey: llm.apiKey!, model: llm.model, ...baseUrl }, transport);
      break;
    case 'anthropic':
      provider = new AnthropicProvider({ apiKey: llm.apiKey!, model: llm.model, ...baseUrl }, transport);
      break;
    case 'openrouter':
      provider = new OpenRouterProvider({ apiKey: llm.apiKey!, model: llm.model, ...baseUrl }, transport);
      break;
    case 'ollama':
      provider = new OllamaProvider({ model: llm.model, ...baseUrl }, transport);
      break;
  }
  return new TrackedLlmProvider(provider, deps.usage ?? new UsageTracker(), deps.logger);
}
