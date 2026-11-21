import type { ToolSpec } from '../ai/providers/tool-chat.js';

export interface ToolOutcome {
  /** Text returned to the model (kept bounded by the agent). */
  text: string;
  isError?: boolean;
  /** Images for the human UI only – never sent to the model. */
  images?: Array<{ mimeType: string; data: string }>;
}

/** A tool the agent may call. Implementations must validate their own arguments. */
export interface AgentTool {
  spec: ToolSpec;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome>;
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'thinking'; step: number; text: string }
  | { type: 'tool_call'; step: number; id: string; name: string; args: unknown }
  | { type: 'tool_result'; step: number; id: string; name: string; ok: boolean; text: string }
  | { type: 'screenshot'; step: number; url: string; caption: string }
  | { type: 'file'; name: string; url: string; kind: 'test' | 'report' | 'html-report' }
  | { type: 'test_run'; fileName: string; status: string; totals: Record<string, number>; reportUrl?: string }
  | { type: 'usage'; calls: number; inputTokens: number; outputTokens: number }
  | { type: 'report'; markdown: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: AgentRunStatus; durationMs: number; steps: number };

export type AgentRunStatus = 'completed' | 'refused' | 'max_steps' | 'cancelled' | 'failed';

export interface AgentResult {
  status: AgentRunStatus;
  report: string;
  steps: number;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}
