import { mkdirSync } from 'node:fs';
import path from 'node:path';

import pino, { type Logger, type LevelWithSilent, type StreamEntry } from 'pino';
import pretty from 'pino-pretty';

import { paths } from './paths.js';
import { redactSensitive } from './sanitizer.js';

export type { Logger } from 'pino';

export interface LoggerOptions {
  /** Minimum level written to the JSON log file. */
  level?: LevelWithSilent;
  /** Minimum level written to the console. */
  consoleLevel?: LevelWithSilent;
  /** Console stream. MCP stdio servers MUST use 'stderr' (stdout carries the protocol). */
  destination?: 'stdout' | 'stderr';
  /** JSON log file path. `false` disables file logging. */
  file?: string | false;
  /** Human-readable console output (default: true outside CI). */
  pretty?: boolean;
  /** Static fields added to every record. */
  base?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LevelWithSilent, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

/**
 * Creates a structured Pino logger. Every record is deep-sanitised (passwords,
 * tokens, secrets, cookies, e-mail PII) before it is serialised, so callers can
 * log request/response metadata without leaking credentials.
 *
 * Uses `pino.multistream` with synchronous destinations (no worker-thread
 * transports) so it works identically inside Playwright workers, CLI scripts and
 * the MCP server.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const consoleLevel = options.consoleLevel ?? 'warn';
  const fd = options.destination === 'stderr' ? 2 : 1;
  const streams: StreamEntry[] = [];

  if (consoleLevel !== 'silent') {
    const usePretty = options.pretty ?? !process.env.CI;
    streams.push({
      level: consoleLevel,
      stream: usePretty
        ? pretty({
            colorize: true,
            destination: fd,
            sync: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          })
        : pino.destination({ fd, sync: true }),
    });
  }

  if (options.file !== false && level !== 'silent') {
    const file = options.file ?? path.join(paths.logs, 'framework.log');
    mkdirSync(path.dirname(file), { recursive: true });
    streams.push({ level, stream: pino.destination({ dest: file, sync: true, append: true }) });
  }

  const minLevel = [level, consoleLevel].reduce((a, b) => (LEVEL_ORDER[a] <= LEVEL_ORDER[b] ? a : b));

  return pino(
    {
      level: streams.length === 0 ? 'silent' : minLevel,
      base: { pid: process.pid, ...options.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redactSensitive(object),
      },
      hooks: {
        // Also sanitise the message string itself (e.g. "token=abc" in an error message).
        logMethod(args, method) {
          const sanitized = args.map((arg) => redactSensitive(arg)) as Parameters<typeof method>;
          method.apply(this, sanitized);
        },
      },
      serializers: { err: (err: unknown) => redactSensitive(err) },
    },
    streams.length > 0 ? pino.multistream(streams, { dedupe: false }) : undefined,
  );
}

let rootLogger: Logger | undefined;

/**
 * Process-wide root logger configured from environment variables. Config is read
 * from process.env directly (not getConfig) so that logging is available even
 * while configuration loading itself fails.
 */
export function getLogger(): Logger {
  if (!rootLogger) {
    const env = process.env;
    rootLogger = createLogger({
      level: (env.LOG_LEVEL as LevelWithSilent | undefined) ?? 'info',
      consoleLevel: (env.LOG_CONSOLE_LEVEL as LevelWithSilent | undefined) ?? 'warn',
      destination: env.LOG_DESTINATION === 'stderr' ? 'stderr' : 'stdout',
      ...(env.LOG_FILE ? { file: env.LOG_FILE } : {}),
      base: { env: env.TEST_ENV ?? 'local' },
    });
  }
  return rootLogger;
}

/** Overrides the root logger (MCP server uses a stderr logger; unit tests use a silent one). */
export function setLogger(logger: Logger): void {
  rootLogger = logger;
}
