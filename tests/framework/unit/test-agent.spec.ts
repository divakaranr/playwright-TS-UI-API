import { expect, test } from '@playwright/test';

import type {
  ToolChatClient,
  ToolChatRequest,
  ToolChatResponse,
} from '../../../src/ai/providers/tool-chat.js';
import { OriginGuard } from '../../../src/agent/browser-tools.js';
import { validateGeneratedTestCode } from '../../../src/agent/draft-tools.js';
import { TestAgent } from '../../../src/agent/test-agent.js';
import type { AgentEvent, AgentTool } from '../../../src/agent/types.js';

type Reply = { content?: string; calls?: Array<[string, unknown]> };

/** Scripted tool-calling model; records every request. */
class ScriptedChat implements ToolChatClient {
  readonly provider = 'openrouter' as const;
  readonly model = 'scripted';
  readonly requests: ToolChatRequest[] = [];
  constructor(private readonly replies: Reply[]) {}

  chat(request: ToolChatRequest): Promise<ToolChatResponse> {
    this.requests.push(structuredClone(request));
    const reply = this.replies.shift() ?? { content: 'final report' };
    return Promise.resolve({
      content: reply.content ?? null,
      toolCalls: (reply.calls ?? []).map(([name, args], i) => ({
        id: `c${this.requests.length}-${i}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      })),
      model: this.model,
      inputTokens: 10,
      outputTokens: 2,
      latencyMs: 1,
    });
  }
}

function echoTool(name = 'echo'): AgentTool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    spec: { name, description: 'echo', parameters: { type: 'object' } },
    execute: async (args) => {
      calls.push(args);
      return { text: `echo:${JSON.stringify(args)}` };
    },
  };
}

test.describe('TestAgent loop', () => {
  test('executes tool calls, feeds results back and returns the final report', async () => {
    const chat = new ScriptedChat([
      { content: 'checking', calls: [['echo', { a: 1 }]] },
      { content: '## Summary\nAll good' },
    ]);
    const tool = echoTool();
    const events: AgentEvent[] = [];

    const result = await new TestAgent({ chat, tools: [tool], emit: (e) => events.push(e) }).run(
      'system',
      'user',
    );

    expect(result).toMatchObject({
      status: 'completed',
      report: '## Summary\nAll good',
      steps: 2,
      usage: { calls: 2, inputTokens: 20 },
    });
    expect(tool.calls).toEqual([{ a: 1 }]);
    const second = chat.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: 'tool', toolCallId: 'c1-0', content: 'echo:{"a":1}' });
    expect(chat.requests[0]!.tools.map((t) => t.name)).toEqual(['echo']);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['thinking', 'tool_call', 'tool_result', 'usage']),
    );
  });

  test('returns invalid JSON, unknown tools and tool exceptions to the model instead of failing', async () => {
    const failing: AgentTool = {
      spec: { name: 'boom', description: '', parameters: {} },
      execute: () => Promise.reject(new Error('kaput')),
    };
    const chat = new ScriptedChat([
      {
        calls: [
          ['echo', '{not json'],
          ['nope', {}],
          ['boom', {}],
        ],
      },
      { content: 'done' },
    ]);

    const result = await new TestAgent({ chat, tools: [echoTool(), failing], emit: () => undefined }).run(
      's',
      'u',
    );

    expect(result.status).toBe('completed');
    const toolMessages = chat.requests[1]!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMessages[0]).toContain('invalid JSON');
    expect(toolMessages[1]).toContain('unknown tool "nope"');
    expect(toolMessages[2]).toBe('ERROR: kaput');
  });

  test('enforces the step budget and asks for a final report without tools', async () => {
    const replies: Reply[] = [
      ...Array.from({ length: 3 }, (): Reply => ({ calls: [['echo', {}]] })),
      { content: 'partial report' },
    ];
    const chat = new ScriptedChat(replies);

    const result = await new TestAgent({ chat, tools: [echoTool()], emit: () => undefined, maxSteps: 3 }).run(
      's',
      'u',
    );

    expect(result).toMatchObject({ status: 'max_steps', report: 'partial report' });
    expect(chat.requests).toHaveLength(4);
    expect(chat.requests[3]!.tools).toEqual([]);
  });

  test('stops when cancelled', async () => {
    const controller = new AbortController();
    const tool: AgentTool = {
      spec: { name: 'slow', description: '', parameters: {} },
      execute: async () => {
        controller.abort();
        return { text: 'ok' };
      },
    };
    const chat = new ScriptedChat([{ calls: [['slow', {}]] }, { calls: [['slow', {}]] }]);

    const result = await new TestAgent({
      chat,
      tools: [tool],
      emit: () => undefined,
      signal: controller.signal,
    }).run('s', 'u');

    expect(result.status).toBe('cancelled');
    expect(chat.requests).toHaveLength(1);
  });

  test('compacts old tool results and masks secrets shown to humans', async () => {
    const big: AgentTool = {
      spec: { name: 'big', description: '', parameters: {} },
      execute: async () => ({ text: 'x'.repeat(5000) + ' password=Hunter2' }),
    };
    const chat = new ScriptedChat([
      ...Array.from({ length: 6 }, () => ({ calls: [['big', {}]] as Array<[string, unknown]> })),
      { content: 'r' },
    ]);
    const events: AgentEvent[] = [];

    await new TestAgent({ chat, tools: [big], emit: (e) => events.push(e), keepRecentToolResults: 2 }).run(
      's',
      'u',
    );

    const lengths = chat.requests
      .at(-1)!
      .messages.filter((m) => m.role === 'tool')
      .map((m) => m.content.length);
    expect(lengths.slice(0, 4).every((l) => l < 500)).toBe(true);
    expect(lengths.slice(-2).every((l) => l > 5000)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Hunter2');
  });
});

test.describe('agent guard rails', () => {
  test('OriginGuard keeps navigation on the target origin', () => {
    const guard = new OriginGuard('https://demo-qa-app.azurewebsites.net/');
    expect(guard.check('https://demo-qa-app.azurewebsites.net/login')).toBeUndefined();
    expect(guard.check('/relative/path')).toBeUndefined();
    expect(guard.check('https://evil.example.com/')).toContain('blocked');
    expect(guard.check('http://demo-qa-app.azurewebsites.net/')).toContain('blocked');
    expect(guard.check('file:///etc/passwd')).toContain('not allowed');
    expect(guard.check('javascript:alert(1)')).toContain('not allowed');
  });

  test('generated test code is statically checked before it is saved or run', () => {
    const valid =
      "import { test, expect } from '@playwright/test';\ntest('t', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle(/x/); });";
    expect(validateGeneratedTestCode(valid)).toEqual([]);

    const cases: Array<[string, RegExp]> = [
      ["import fs from 'node:fs';\ntest('t', () => {});", /import from "node:fs"/],
      ["const cp = require('child_process'); test('t', () => {});", /require/],
      ["test('t', async () => { await import('os'); });", /dynamic import/],
      ["test('t', () => { process.exit(1); });", /process access/],
      ["test('t', () => { eval('1'); });", /dynamic code/],
      ["test('t', async ({ page }) => { await page.waitForTimeout(1000); });", /fixed sleeps/],
      ['const x = 1;', /no test/],
    ];
    for (const [code, problem] of cases) expect(validateGeneratedTestCode(code).join('\n')).toMatch(problem);
  });
});
