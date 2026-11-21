import type { AgentMessage, ToolChatClient } from '../ai/providers/tool-chat.js';
import { maskSensitiveText, truncate } from '../utils/sanitizer.js';
import { OUT_OF_SCOPE_MARKER } from './prompts.js';
import type { AgentEvent, AgentResult, AgentTool } from './types.js';

export interface TestAgentOptions {
  chat: ToolChatClient;
  tools: AgentTool[];
  emit: (event: AgentEvent) => void;
  /** Maximum model turns that may call tools (default 30). */
  maxSteps?: number;
  signal?: AbortSignal;
  /** Characters of a tool result sent to the model (default 12 000). */
  maxToolResultChars?: number;
  /** Number of most recent tool results kept in full; older ones are shortened (default 4). */
  keepRecentToolResults?: number;
  /** Called after each tool execution (used by the console for live screenshots). */
  afterTool?: (name: string, step: number) => Promise<void>;
}

const FINAL_REPORT_REQUEST =
  'The step budget is exhausted. Do not call tools. Write the final report now using what you have observed.';

/**
 * Minimal, auditable tool-calling loop:
 *   model -> tool calls -> execute (validated, guarded) -> results -> model … -> final text report.
 *
 * Safeguards: step budget, cancellation, unknown tools/invalid JSON returned to the
 * model as errors (never thrown), bounded tool output, older tool results compacted
 * to keep the context small, all text shown to humans is sanitised.
 */
export class TestAgent {
  private readonly tools: Map<string, AgentTool>;
  private readonly usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(private readonly options: TestAgentOptions) {
    this.tools = new Map(options.tools.map((t) => [t.spec.name, t]));
  }

  async run(systemPrompt: string, userPrompt: string): Promise<AgentResult> {
    const maxSteps = this.options.maxSteps ?? 30;
    const signal = this.options.signal ?? new AbortController().signal;
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const specs = [...this.tools.values()].map((t) => t.spec);

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) return this.finish('cancelled', 'Run cancelled by user.', step - 1);

      const response = await this.chat(this.compact(messages), specs);
      messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

      if (response.toolCalls.length === 0) {
        const content = response.content ?? '(the model returned no report)';
        // The system prompt instructs the model to decline out-of-scope requests with this marker.
        return this.finish(
          content.trimStart().startsWith(OUT_OF_SCOPE_MARKER) ? 'refused' : 'completed',
          content,
          step,
        );
      }
      if (response.content?.trimStart().startsWith(OUT_OF_SCOPE_MARKER)) {
        // Declined but still tried to call tools: do not execute them.
        return this.finish('refused', response.content, step);
      }
      if (response.content?.trim()) {
        this.options.emit({ type: 'thinking', step, text: maskSensitiveText(response.content) });
      }

      for (const call of response.toolCalls) {
        if (signal.aborted) return this.finish('cancelled', 'Run cancelled by user.', step);
        const outcome = await this.execute(call.name, call.arguments, call.id, step, signal);
        messages.push({ role: 'tool', toolCallId: call.id, content: outcome });
      }
    }

    // Budget exhausted: one final turn without tools to obtain a report.
    messages.push({ role: 'user', content: FINAL_REPORT_REQUEST });
    const final = await this.chat(this.compact(messages), []);
    return this.finish('max_steps', final.content ?? '(no report)', maxSteps);
  }

  private async chat(messages: AgentMessage[], tools: AgentTool['spec'][]) {
    const response = await this.options.chat.chat({ messages, tools, temperature: 0.2, maxTokens: 4000 });
    this.usage.calls += 1;
    this.usage.inputTokens += response.inputTokens ?? 0;
    this.usage.outputTokens += response.outputTokens ?? 0;
    this.options.emit({ type: 'usage', ...this.usage });
    return response;
  }

  /** Validates and executes one tool call. Problems are returned to the model as text, never thrown. */
  private async execute(
    name: string,
    rawArgs: string,
    id: string,
    step: number,
    signal: AbortSignal,
  ): Promise<string> {
    const tool = this.tools.get(name);
    let args: Record<string, unknown> | undefined;
    let outcome: { text: string; isError?: boolean } = {
      text: 'ERROR: tool was not executed',
      isError: true,
    };
    try {
      const parsed: unknown = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('arguments must be a JSON object');
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      outcome = { text: `ERROR: invalid JSON arguments (${(error as Error).message})`, isError: true };
    }
    this.options.emit({
      type: 'tool_call',
      step,
      id,
      name,
      args: args ? redactArgs(args) : { raw: truncate(rawArgs, 300) },
    });

    if (args && !tool) {
      outcome = {
        text: `ERROR: unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}`,
        isError: true,
      };
    } else if (args && tool) {
      try {
        outcome = await tool.execute(args, signal);
      } catch (error) {
        outcome = { text: `ERROR: ${(error as Error).message}`, isError: true };
      }
      await this.options.afterTool?.(name, step).catch(() => undefined);
    }

    const text = truncate(outcome.text, this.options.maxToolResultChars ?? 12_000);
    this.options.emit({
      type: 'tool_result',
      step,
      id,
      name,
      ok: !outcome.isError,
      text: truncate(maskSensitiveText(text), 3000),
    });
    return text;
  }

  /** Shortens all but the most recent tool results to keep the context window bounded. */
  private compact(messages: AgentMessage[]): AgentMessage[] {
    const keep = this.options.keepRecentToolResults ?? 4;
    const toolIndexes = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
    const old = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keep)));
    return messages.map((m, i) =>
      m.role === 'tool' && old.has(i) ? { ...m, content: truncate(m.content, 400) } : m,
    );
  }

  private finish(status: AgentResult['status'], report: string, steps: number): AgentResult {
    return { status, report: maskSensitiveText(report), steps, usage: { ...this.usage } };
  }
}

/** Hides values the model typed into password-like fields from the human-facing log. */
function redactArgs(args: Record<string, unknown>): unknown {
  const text = JSON.stringify(args);
  return /password|secret|token/i.test(text)
    ? (JSON.parse(text.replace(/("(?:text|value)"\s*:\s*")[^"]*(")/g, '$1***$2')) as unknown)
    : args;
}
