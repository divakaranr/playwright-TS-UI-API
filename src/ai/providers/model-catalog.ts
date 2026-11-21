import { maskSensitiveText, truncate } from '../../utils/sanitizer.js';
import { asNumber, asString, pick, type FetchLike } from './http-transport.js';
import { classifyStatus, LlmError } from './llm-error.js';
import { ANTHROPIC_VERSION, DEFAULT_BASE_URLS, type ToolCallingProvider } from './tool-chat.js';

/**
 * Live model catalogue per provider, used to fill the Test Console's model
 * dropdown. Only models usable for tool calling are returned where the
 * provider exposes that capability (OpenRouter); for the others a name filter
 * removes obviously unsuitable models (embeddings, audio, images, …).
 */

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
}

export interface CatalogOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Accepted model id shape (e.g. "openai/gpt-4o:free", "llama3.1:8b", "claude-sonnet-4-5"). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const MAX_MODELS = 2000;
const OPENAI_CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NOT_CHAT =
  /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|whisper|dall-e)/;

async function getJson(
  provider: ToolCallingProvider,
  url: string,
  headers: Record<string, string>,
  options: CatalogOptions,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new LlmError(
      provider,
      timeout ? 'timeout' : 'network',
      timeout ? `no answer within ${timeoutMs}ms` : `cannot reach ${new URL(url).host}`,
      { cause: error },
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new LlmError(
      provider,
      classifyStatus(response.status),
      `HTTP ${response.status}: ${truncate(maskSensitiveText(text), 200)}`,
      { status: response.status },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new LlmError(provider, 'invalid_response', 'model list is not valid JSON', { cause: error });
  }
}

const base = (provider: ToolCallingProvider, options: CatalogOptions) =>
  (options.baseUrl ?? DEFAULT_BASE_URLS[provider]).replace(/\/$/, '');

function requireKey(provider: ToolCallingProvider, options: CatalogOptions): string {
  if (!options.apiKey) throw new LlmError(provider, 'configuration', 'an API key is required');
  return options.apiKey;
}

function normalise(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models
    .filter((m) => MODEL_ID_PATTERN.test(m.id) && !seen.has(m.id) && seen.add(m.id))
    .map((m) => ({
      id: m.id,
      ...(m.name && m.name !== m.id ? { name: truncate(m.name, 120) } : {}),
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_MODELS);
}

const list = (json: unknown, key: string): unknown[] => {
  const value = pick(json, key);
  return Array.isArray(value) ? value : [];
};

/** Lists the tool-calling capable models the given provider/key can use. */
export async function listToolCallingModels(
  provider: ToolCallingProvider,
  options: CatalogOptions = {},
): Promise<ModelInfo[]> {
  const root = base(provider, options);
  switch (provider) {
    case 'openrouter': {
      const json = await getJson(
        provider,
        `${root}/models?supported_parameters=tools`,
        options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
        options,
      );
      return normalise(
        list(json, 'data')
          .filter((m) => {
            const params = pick(m, 'supported_parameters');
            return !Array.isArray(params) || params.includes('tools');
          })
          .map((m) => ({
            id: asString(pick(m, 'id')) ?? '',
            name: asString(pick(m, 'name')),
            contextLength: asNumber(pick(m, 'context_length')),
          })),
      );
    }
    case 'openai': {
      const json = await getJson(
        provider,
        `${root}/models`,
        { Authorization: `Bearer ${requireKey(provider, options)}` },
        options,
      );
      return normalise(
        list(json, 'data')
          .map((m) => ({ id: asString(pick(m, 'id')) ?? '' }))
          .filter((m) => OPENAI_CHAT_MODEL.test(m.id) && !OPENAI_NOT_CHAT.test(m.id)),
      );
    }
    case 'anthropic': {
      const json = await getJson(
        provider,
        `${root}/v1/models?limit=1000`,
        { 'x-api-key': requireKey(provider, options), 'anthropic-version': ANTHROPIC_VERSION },
        options,
      );
      return normalise(
        list(json, 'data').map((m) => ({
          id: asString(pick(m, 'id')) ?? '',
          name: asString(pick(m, 'display_name')),
        })),
      );
    }
    case 'ollama': {
      const json = await getJson(provider, `${root}/api/tags`, {}, options);
      return normalise(
        list(json, 'models').map((m) => ({
          id: asString(pick(m, 'name')) ?? asString(pick(m, 'model')) ?? '',
        })),
      );
    }
  }
}

/**
 * Confirms the API key is accepted. Listing models already authenticates for
 * OpenAI and Anthropic; OpenRouter's catalogue is public, so its key endpoint is checked.
 */
export async function verifyApiKey(provider: ToolCallingProvider, options: CatalogOptions): Promise<void> {
  if (provider !== 'openrouter') return;
  await getJson(
    provider,
    `${base(provider, options)}/key`,
    { Authorization: `Bearer ${requireKey(provider, options)}` },
    options,
  );
}
