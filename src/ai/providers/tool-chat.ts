import type { FrameworkConfig, LlmProviderName } from '../../config/index.js';
import type { Logger } from '../../utils/logger.js';
import { asNumber, asString, LlmHttpTransport, pick, type FetchLike } from './http-transport.js';
import { LlmError } from './llm-error.js';

/**
 * Tool-calling ("function calling") chat for agentic use cases such as the
 * Test Console. Kept separate from the text-only `LLMProvider` contract so the
 * deterministic AI services stay simple. OpenAI, OpenRouter and Ollama share
 * the OpenAI Chat Completions wire format; Anthropic uses its Messages API.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string produced by the model (may be invalid – validate before use). */
  arguments: string;
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolChatRequest {
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

export interface ToolChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  finishReason?: string;
}

export interface ToolChatClient {
  readonly provider: LlmProviderName;
  readonly model: string;
  chat(request: ToolChatRequest): Promise<ToolChatResponse>;
}

export const TOOL_CALLING_PROVIDERS = ['openrouter', 'openai', 'anthropic', 'ollama'] as const;
export type ToolCallingProvider = (typeof TOOL_CALLING_PROVIDERS)[number];
export const isToolCallingProvider = (value: string): value is ToolCallingProvider =>
  (TOOL_CALLING_PROVIDERS as readonly string[]).includes(value);

/** Fixed API endpoints per provider (overridable only via configuration, never from the UI). */
export const DEFAULT_BASE_URLS: Record<ToolCallingProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://localhost:11434',
};
/** Providers that work without an API key (local models). */
export const KEYLESS_PROVIDERS: readonly ToolCallingProvider[] = ['ollama'];
export const ANTHROPIC_VERSION = '2023-06-01';

function toWireMessage(message: AgentMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

export class OpenAiCompatibleToolChat implements ToolChatClient {
  constructor(
    readonly provider: LlmProviderName,
    readonly model: string,
    private readonly options: {
      url: string;
      headers: Record<string, string>;
      maxTokensField: 'max_tokens' | 'max_completion_tokens';
    },
    private readonly transport: LlmHttpTransport,
  ) {}

  async chat(request: ToolChatRequest): Promise<ToolChatResponse> {
    const started = performance.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { [this.options.maxTokensField]: request.maxTokens } : {}),
    };

    const json = await this.transport.postJson(this.options.url, body, this.options.headers);
    const message = pick(json, 'choices', 0, 'message');
    if (!message || typeof message !== 'object') {
      throw new LlmError(this.provider, 'invalid_response', 'response contained no choices[0].message');
    }
    const rawCalls = pick(message, 'tool_calls');
    const toolCalls: ToolCall[] = Array.isArray(rawCalls)
      ? rawCalls.map((call, index) => {
          const args = pick(call, 'function', 'arguments');
          return {
            id: asString(pick(call, 'id')) ?? `call_${index}`,
            name: asString(pick(call, 'function', 'name')) ?? '',
            arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
          };
        })
      : [];
    const inputTokens = asNumber(pick(json, 'usage', 'prompt_tokens'));
    const outputTokens = asNumber(pick(json, 'usage', 'completion_tokens'));
    const finishReason = asString(pick(json, 'choices', 0, 'finish_reason'));
    return {
      content: asString(pick(message, 'content')) ?? null,
      toolCalls,
      model: asString(pick(json, 'model')) ?? this.model,
      latencyMs: Math.round(performance.now() - started),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }
}

type AnthropicBlock = Record<string, unknown>;

function parseObject(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Maps the neutral transcript to Anthropic messages (alternating roles, tool results as user blocks). */
export function toAnthropicMessages(
  messages: AgentMessage[],
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        push('user', [{ type: 'text', text: message.content }]);
        break;
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
        break;
      case 'assistant':
        push('assistant', [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...(message.toolCalls ?? []).map((c) => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: parseObject(c.arguments),
          })),
        ]);
        break;
    }
  }
  return out;
}

/** Anthropic Messages API with tool use. */
export class AnthropicToolChat implements ToolChatClient {
  readonly provider = 'anthropic' as const;
  /** Anthropic rejects transcripts containing tool blocks unless tools are declared. */
  private lastTools: ToolSpec[] = [];

  constructor(
    readonly model: string,
    private readonly options: { url: string; headers: Record<string, string> },
    private readonly transport: LlmHttpTransport,
  ) {}

  async chat(request: ToolChatRequest): Promise<ToolChatResponse> {
    const started = performance.now();
    if (request.tools.length > 0) this.lastTools = request.tools;
    // A tool-less request (e.g. the final report) still declares the tools but forbids using them.
    const tools = request.tools.length > 0 ? request.tools : this.lastTools;
    const system = request.messages.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n\n');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 4096,
      messages: toAnthropicMessages(request.messages),
      ...(system ? { system } : {}),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            tool_choice: { type: request.tools.length > 0 ? 'auto' : 'none' },
          }
        : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const json = await this.transport.postJson(this.options.url, body, this.options.headers);
    const blocks = pick(json, 'content');
    if (!Array.isArray(blocks)) {
      throw new LlmError(this.provider, 'invalid_response', 'response contained no content blocks');
    }
    const text = blocks
      .filter((b) => pick(b, 'type') === 'text')
      .map((b) => asString(pick(b, 'text')) ?? '')
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => pick(b, 'type') === 'tool_use')
      .map((b, index) => ({
        id: asString(pick(b, 'id')) ?? `toolu_${index}`,
        name: asString(pick(b, 'name')) ?? '',
        arguments: JSON.stringify(pick(b, 'input') ?? {}),
      }));
    const inputTokens = asNumber(pick(json, 'usage', 'input_tokens'));
    const outputTokens = asNumber(pick(json, 'usage', 'output_tokens'));
    const finishReason = asString(pick(json, 'stop_reason'));
    return {
      content: text || null,
      toolCalls,
      model: asString(pick(json, 'model')) ?? this.model,
      latencyMs: Math.round(performance.now() - started),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
    };
  }
}

/** Creates a tool-calling client (OpenRouter, OpenAI, Anthropic or Ollama). */
export function createToolChatClient(
  llm: FrameworkConfig['llm'],
  deps: { fetch?: FetchLike; logger?: Logger } = {},
): ToolChatClient {
  const provider = llm.provider;
  if (!isToolCallingProvider(provider)) {
    throw new LlmError(
      provider,
      'configuration',
      `Tool calling requires one of ${TOOL_CALLING_PROVIDERS.join(', ')} (current: ${provider})`,
    );
  }
  if (!llm.model) throw new LlmError(provider, 'configuration', 'a model is required');
  if (!llm.apiKey && !KEYLESS_PROVIDERS.includes(provider))
    throw new LlmError(provider, 'configuration', 'an API key is required');

  const transport = new LlmHttpTransport({
    provider,
    timeoutMs: llm.timeoutMs,
    maxRetries: llm.maxRetries,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  const base = (llm.baseUrl ?? DEFAULT_BASE_URLS[provider]).replace(/\/$/, '');
  switch (provider) {
    case 'anthropic':
      return new AnthropicToolChat(
        llm.model,
        {
          url: `${base}/v1/messages`,
          headers: { 'x-api-key': llm.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION },
        },
        transport,
      );
    case 'ollama':
      return new OpenAiCompatibleToolChat(
        provider,
        llm.model,
        { url: `${base}/v1/chat/completions`, headers: {}, maxTokensField: 'max_tokens' },
        transport,
      );
    default: {
      const isOpenRouter = provider === 'openrouter';
      return new OpenAiCompatibleToolChat(
        provider,
        llm.model,
        {
          url: `${base}/chat/completions`,
          headers: {
            Authorization: `Bearer ${llm.apiKey}`,
            ...(isOpenRouter ? { 'X-Title': 'playwright-enterprise-framework test console' } : {}),
          },
          maxTokensField: isOpenRouter ? 'max_tokens' : 'max_completion_tokens',
        },
        transport,
      );
    }
  }
}
