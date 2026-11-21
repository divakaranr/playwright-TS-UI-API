import type { LLMProvider, LLMRequest, LLMResponse } from '../../../src/ai/providers/index.js';

/** Scripted LLM provider for deterministic unit tests. Records every request. */
export class FakeLlmProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly model = 'fake-model';
  readonly requests: LLMRequest[] = [];

  constructor(private readonly replies: Array<string | Error>) {}

  generate(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (reply === undefined) return Promise.reject(new Error('FakeLlmProvider: no scripted reply left'));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      content: reply,
      model: this.model,
      provider: this.name,
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 1,
    });
  }
}
