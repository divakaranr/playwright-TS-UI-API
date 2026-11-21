import { writeFileSync } from 'node:fs';
import path from 'node:path';

import * as z from 'zod';

import type { ToolChatClient } from '../ai/providers/tool-chat.js';
import { createBrowserTools, OriginGuard, STATE_CHANGING_TOOLS } from '../agent/browser-tools.js';
import { createDraftTools } from '../agent/draft-tools.js';
import { buildSystemPrompt, buildUserMessage } from '../agent/prompts.js';
import { TestAgent } from '../agent/test-agent.js';
import type { AgentEvent, AgentRunStatus } from '../agent/types.js';
import { McpClient } from '../mcp/client/mcp-client.js';
import { parseServerConfig } from '../mcp/client/mcp-config.js';
import { ensureDir } from '../utils/file.util.js';
import type { Logger } from '../utils/logger.js';
import { paths } from '../utils/paths.js';
import { PROMPT_MAX_LENGTH, SecretRedactor } from './input-guard.js';

export const runRequestSchema = z
  .object({
    // Shape/type checks only – content is validated and sanitised by input-guard.ts before a run starts.
    targetUrl: z.string().max(4096),
    prompt: z.string().max(PROMPT_MAX_LENGTH * 4),
    mode: z.enum(['explore', 'generate']).default('explore'),
    maxSteps: z.number().int().min(3).max(80).default(30),
    headed: z.boolean().default(false),
    runTests: z.boolean().default(true),
  })
  .strict();
export type RunRequest = z.output<typeof runRequestSchema>;

export interface ConsoleRunDeps {
  runId: string;
  request: RunRequest;
  chat: ToolChatClient;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  urlFor: (absolutePath: string) => string;
  logger?: Logger;
}

/**
 * Executes one console run: starts an isolated official Playwright MCP browser,
 * builds the guarded tool set, runs the agent and persists the report.
 */
export async function executeConsoleRun(
  deps: ConsoleRunDeps,
): Promise<{ status: AgentRunStatus; report: string }> {
  const { request, runId } = deps;
  // Last line of defence: no configured secret value ever leaves the server.
  const redactor = new SecretRedactor();
  const emit = (event: AgentEvent) => deps.emit(redactor.redactValue(event));
  const runDir = ensureDir(path.join(paths.reports, 'console-runs', runId));
  const shotsDir = ensureDir(path.join(runDir, 'screenshots'));
  const started = Date.now();

  const browser = new McpClient(
    parseServerConfig({
      name: 'console-browser',
      transport: 'stdio',
      command: process.execPath,
      args: [
        path.join(paths.root, 'node_modules', '@playwright', 'mcp', 'cli.js'),
        '--isolated',
        ...(request.headed ? [] : ['--headless']),
        '--output-dir',
        path.join(runDir, 'browser'),
      ],
      connectTimeoutMs: 60_000,
      requestTimeoutMs: 180_000,
    }),
    deps.logger,
  );

  let status: AgentRunStatus;
  let report: string;
  let steps = 0;
  try {
    emit({ type: 'status', message: `Starting browser (${request.headed ? 'visible' : 'headless'})…` });
    await browser.connect();
    const guard = new OriginGuard(request.targetUrl);
    const tools = [
      ...(await createBrowserTools(browser, guard)),
      ...(request.mode === 'generate'
        ? createDraftTools({
            runId,
            baseUrl: request.targetUrl,
            allowRun: request.runTests,
            emit,
            urlFor: deps.urlFor,
            redactor,
          })
        : []),
    ];
    emit({ type: 'status', message: `Agent started with ${tools.length} tools · model ${deps.chat.model}` });

    let shot = 0;
    const agent = new TestAgent({
      chat: deps.chat,
      tools,
      emit,
      maxSteps: request.maxSteps,
      signal: deps.signal,
      afterTool: async (name, step) => {
        if (!STATE_CHANGING_TOOLS.has(name) && name !== 'browser_take_screenshot') return;
        const result = await browser.callTool(
          'browser_take_screenshot',
          { type: 'jpeg' },
          { timeoutMs: 30_000 },
        );
        const image = result.content.find((b) => b.type === 'image');
        if (!image || image.type !== 'image') return;
        const file = path.join(shotsDir, `step-${String(step).padStart(2, '0')}-${++shot}.jpeg`);
        writeFileSync(file, Buffer.from(image.data, 'base64'));
        emit({ type: 'screenshot', step, url: deps.urlFor(file), caption: `after ${name}` });
      },
    });

    const result = await agent.run(
      buildSystemPrompt(request.mode, request.targetUrl, request.runTests),
      buildUserMessage(request.targetUrl, request.prompt),
    );
    status = result.status;
    report = redactor.redact(result.report);
    steps = result.steps;
  } catch (error) {
    status = deps.signal.aborted ? 'cancelled' : 'failed';
    report = `Run failed: ${(error as Error).message}`;
    emit({ type: 'error', message: (error as Error).message });
  } finally {
    await browser.close();
  }

  const reportFile = path.join(runDir, 'report.md');
  writeFileSync(
    reportFile,
    `# Test console report\n\n- Target: ${request.targetUrl}\n- Mode: ${request.mode}\n- Status: ${status}\n- Started: ${new Date(started).toISOString()}\n\n## Request\n\n${request.prompt}\n\n${report}\n`,
    'utf8',
  );
  emit({ type: 'report', markdown: report });
  emit({
    type: 'file',
    kind: 'report',
    name: path.relative(paths.root, reportFile).split(path.sep).join('/'),
    url: deps.urlFor(reportFile),
  });
  emit({ type: 'done', status, durationMs: Date.now() - started, steps });
  return { status, report };
}
