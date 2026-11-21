import type { Logger } from '../../utils/logger.js';
import type { LLMProvider, LLMRequest, LLMResponse } from './llm-provider.interface.js';

export interface UsageTotals {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
}

/** Accumulates token usage and latency across calls (per process). */
export class UsageTracker {
  private readonly totals: UsageTotals = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
  };

  recordSuccess(response: LLMResponse): void {
    this.totals.calls += 1;
    this.totals.inputTokens += response.inputTokens ?? 0;
    this.totals.outputTokens += response.outputTokens ?? 0;
    this.totals.totalLatencyMs += response.latencyMs;
  }

  recordFailure(latencyMs: number): void {
    this.totals.calls += 1;
    this.totals.failures += 1;
    this.totals.totalLatencyMs += latencyMs;
  }

  snapshot(): UsageTotals {
    return { ...this.totals };
  }
}

/**
 * Decorator adding usage tracking and metadata-only logging to any provider.
 * Prompt and completion content is never logged.
 */
export class TrackedLlmProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    readonly usage: UsageTracker = new UsageTracker(),
    private readonly logger?: Logger,
  ) {}

  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const started = performance.now();
    try {
      const response = await this.inner.generate(request);
      this.usage.recordSuccess(response);
      this.logger?.info(
        {
          provider: response.provider,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
        },
        'LLM call completed',
      );
      return response;
    } catch (error) {
      this.usage.recordFailure(Math.round(performance.now() - started));
      this.logger?.warn(
        { provider: this.inner.name, model: this.inner.model, err: error },
        'LLM call failed',
      );
      throw error;
    }
  }
}
