import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Absolute path of the Playwright CLI – invoked via `node` directly (no shell, no npx). */
export function playwrightCli(): string {
  return path.join(path.dirname(require.resolve('@playwright/test/package.json')), 'cli.js');
}

/** Kills a process and all its children (Playwright spawns worker processes). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = process group (child spawned detached)
    } catch {
      child.kill('SIGKILL');
    }
  }
}

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

/**
 * Runs `node <script> ...args` with an argument array (never through a shell, so
 * inputs cannot inject commands), a hard timeout, and bounded output capture.
 * stdio is piped – never inherited – because the MCP stdio server's stdout is the protocol channel.
 */
export function runNodeScript(
  script: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputChars?: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  const maxOutput = options.maxOutputChars ?? 50_000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);
    const onAbort = () => killTree(child);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, timedOut, output, durationMs: Date.now() - started });
    });
  });
}
