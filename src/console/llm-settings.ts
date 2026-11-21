import { z } from 'zod';

import type { FetchLike } from '../ai/providers/http-transport.js';
import { LlmError } from '../ai/providers/llm-error.js';
import {
  listToolCallingModels,
  MODEL_ID_PATTERN,
  verifyApiKey,
  type ModelInfo,
} from '../ai/providers/model-catalog.js';
import {
  DEFAULT_BASE_URLS,
  isToolCallingProvider,
  KEYLESS_PROVIDERS,
  TOOL_CALLING_PROVIDERS,
  type ToolCallingProvider,
} from '../ai/providers/tool-chat.js';
import type { FrameworkConfig } from '../config/index.js';
import type { Logger } from '../utils/logger.js';
import { SecretStoreError, type EncryptedFileStore } from './secret-store.js';

/**
 * LLM settings of the Test Console: provider, model and one API key per
 * provider, chosen in the UI and persisted in the encrypted secret store.
 * Saved settings take precedence over LLM_* in .env, which stays a fallback.
 * API keys never leave the server again: status responses carry a masked hint only.
 */

export const PROVIDER_LABELS: Record<ToolCallingProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama (local)',
};

const providerSchema = z.enum(TOOL_CALLING_PROVIDERS);
export const modelIdSchema = z
  .string()
  .trim()
  .regex(MODEL_ID_PATTERN, 'Model: use a model from the list (letters, digits and . _ : / @ + - only)');
export const apiKeySchema = z
  .string()
  .trim()
  .min(8, 'API key: too short')
  .max(512, 'API key: too long')
  .regex(/^[\x21-\x7E]+$/, 'API key: must be one token of printable characters without spaces');

export const settingsInputSchema = z
  .object({ provider: providerSchema, model: modelIdSchema, apiKey: apiKeySchema.optional() })
  .strict();
export const modelsInputSchema = z
  .object({ provider: providerSchema, apiKey: apiKeySchema.optional() })
  .strict();
export type SettingsInput = z.infer<typeof settingsInputSchema>;

const storedSchema = z
  .object({
    version: z.literal(1),
    active: z.object({ provider: providerSchema, model: modelIdSchema }).strict().optional(),
    apiKeys: z.partialRecord(providerSchema, apiKeySchema).default({}),
  })
  .strict();
type StoredSettings = z.infer<typeof storedSchema>;

export type SettingsSource = 'saved' | 'env' | 'none';

export class SettingsError extends Error {
  override readonly name = 'SettingsError';
  constructor(
    readonly errors: string[],
    readonly status = 400,
  ) {
    super(errors.join('; '));
  }
}

export interface LlmSettingsOptions {
  /** LLM_* values from .env (fallback and timeouts/retries). */
  env: FrameworkConfig['llm'];
  /** Encrypted persistence; without it settings live in memory only. */
  store?: EncryptedFileStore;
  /** Endpoint overrides (tests / proxies). The UI can never change endpoints. */
  baseUrls?: Partial<Record<ToolCallingProvider, string>>;
  fetch?: FetchLike;
  logger?: Logger;
}

export interface LlmSettingsStatus {
  ready: boolean;
  message: string;
  provider: ToolCallingProvider | null;
  model: string | null;
  source: SettingsSource;
  encrypted: boolean;
  warning?: string;
  providers: Array<{
    id: ToolCallingProvider;
    label: string;
    requiresApiKey: boolean;
    apiKey: { source: SettingsSource; hint: string | null };
  }>;
}

const requiresKey = (provider: ToolCallingProvider) => !KEYLESS_PROVIDERS.includes(provider);
const maskKey = (key: string) => `••••${key.slice(-4)}`;

export class LlmSettings {
  private stored: StoredSettings = { version: 1, apiKeys: {} };
  private storeError: string | undefined;

  constructor(private readonly options: LlmSettingsOptions) {
    const { store } = options;
    if (!store) return;
    try {
      const raw = store.read();
      if (raw !== undefined) this.stored = storedSchema.parse(raw);
    } catch (error) {
      this.storeError =
        error instanceof SecretStoreError ? error.message : 'the saved settings have an invalid structure';
      options.logger?.warn({ reason: this.storeError }, 'saved LLM settings ignored');
    }
  }

  baseUrl(provider: ToolCallingProvider): string {
    const env = this.options.env;
    return (
      this.options.baseUrls?.[provider] ??
      (env.provider === provider ? env.baseUrl : undefined) ??
      DEFAULT_BASE_URLS[provider]
    );
  }

  private apiKey(provider: ToolCallingProvider): { value?: string; source: SettingsSource } {
    const saved = this.stored.apiKeys[provider];
    if (saved) return { value: saved, source: 'saved' };
    const env = this.options.env;
    if (env.provider === provider && env.apiKey) return { value: env.apiKey, source: 'env' };
    return { source: 'none' };
  }

  /** Active provider/model: saved settings win over .env. */
  active():
    { provider: ToolCallingProvider; model: string; source: Exclude<SettingsSource, 'none'> } | undefined {
    if (this.stored.active) return { ...this.stored.active, source: 'saved' };
    const env = this.options.env;
    if (isToolCallingProvider(env.provider) && env.model)
      return { provider: env.provider, model: env.model, source: 'env' };
    return undefined;
  }

  /** Configuration for the tool-calling client, or undefined while incomplete. */
  llmConfig(): FrameworkConfig['llm'] | undefined {
    const active = this.active();
    if (!active) return undefined;
    const key = this.apiKey(active.provider).value;
    if (!key && requiresKey(active.provider)) return undefined;
    return {
      ...this.options.env,
      provider: active.provider,
      model: active.model,
      apiKey: key,
      baseUrl: this.baseUrl(active.provider),
    };
  }

  status(): LlmSettingsStatus {
    const active = this.active();
    const ready = this.llmConfig() !== undefined;
    return {
      ready,
      message: ready
        ? 'ready'
        : !active
          ? 'Choose a provider and model in Model settings'
          : `Add an API key for ${PROVIDER_LABELS[active.provider]} in Model settings`,
      provider: active?.provider ?? null,
      model: active?.model ?? null,
      source: active?.source ?? 'none',
      encrypted: Boolean(this.options.store),
      ...(this.storeError ? { warning: `Saved settings could not be loaded: ${this.storeError}` } : {}),
      providers: TOOL_CALLING_PROVIDERS.map((id) => {
        const key = this.apiKey(id);
        return {
          id,
          label: PROVIDER_LABELS[id],
          requiresApiKey: requiresKey(id),
          apiKey: { source: key.source, hint: key.value ? maskKey(key.value) : null },
        };
      }),
    };
  }

  /** Models the provider offers for tool calling, using the given key or the stored one. */
  async listModels(provider: ToolCallingProvider, apiKey?: string): Promise<ModelInfo[]> {
    try {
      return await listToolCallingModels(provider, {
        apiKey: apiKey ?? this.apiKey(provider).value,
        baseUrl: this.baseUrl(provider),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (error) {
      throw this.describe(provider, error);
    }
  }

  /** Verifies key + model against the provider, then persists everything encrypted. */
  async save(input: SettingsInput): Promise<LlmSettingsStatus> {
    const { provider, model } = input;
    const label = PROVIDER_LABELS[provider];
    const key = input.apiKey ?? this.apiKey(provider).value;
    if (!key && requiresKey(provider)) throw new SettingsError([`API key: required for ${label}`]);

    const models = await this.listModels(provider, key);
    try {
      await verifyApiKey(provider, {
        apiKey: key,
        baseUrl: this.baseUrl(provider),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (error) {
      throw this.describe(provider, error);
    }
    if (!models.some((m) => m.id === model))
      throw new SettingsError([`Model: "${model}" is not offered by ${label} for tool calling`]);

    this.persist({
      version: 1,
      active: { provider, model },
      apiKeys: { ...this.stored.apiKeys, ...(input.apiKey ? { [provider]: input.apiKey } : {}) },
    });
    this.options.logger?.info(
      { provider, model, apiKeyUpdated: Boolean(input.apiKey), encrypted: Boolean(this.options.store) },
      'LLM settings saved',
    );
    return this.status();
  }

  /** Removes all saved settings and keys (the .env fallback remains). */
  clear(): LlmSettingsStatus {
    try {
      this.options.store?.clear();
    } catch (error) {
      throw new SettingsError([`Could not delete the saved settings: ${(error as Error).message}`], 500);
    }
    this.stored = { version: 1, apiKeys: {} };
    this.storeError = undefined;
    this.options.logger?.info('LLM settings cleared');
    return this.status();
  }

  private persist(next: StoredSettings): void {
    try {
      this.options.store?.write(next);
    } catch (error) {
      throw new SettingsError([`Could not save the encrypted settings: ${(error as Error).message}`], 500);
    }
    this.stored = next;
    this.storeError = undefined;
  }

  private describe(provider: ToolCallingProvider, error: unknown): SettingsError {
    const label = PROVIDER_LABELS[provider];
    if (!(error instanceof LlmError))
      return new SettingsError([`${label}: ${(error as Error).message}`], 502);
    switch (error.kind) {
      case 'configuration':
        return new SettingsError([`API key: required for ${label}`]);
      case 'authentication':
        return new SettingsError([`API key: rejected by ${label} (HTTP ${error.status ?? 401})`]);
      case 'network':
      case 'timeout':
        return new SettingsError(
          [
            `${label} is not reachable${provider === 'ollama' ? ` at ${this.baseUrl(provider)} – is Ollama running?` : ''}`,
          ],
          502,
        );
      case 'rate_limit':
        return new SettingsError([`${label}: rate limited – try again in a moment`], 502);
      default:
        return new SettingsError([`${label}: ${error.message.replace(/^\[[^\]]+\]\s*/, '')}`], 502);
    }
  }
}
