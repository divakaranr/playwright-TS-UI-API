/**
 * Sensitive-data sanitisation used by logging, reporting, MCP responses and
 * every payload sent to an LLM. Centralised so that the rules are tested once
 * and applied consistently.
 */

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always replaced, regardless of content. */
const SENSITIVE_KEY_PATTERN =
  /^(pass(word|wd)?|pwd|secret|client[-_]?secret|api[-_]?key|x-api-key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|proxy-authorization|cookie|set-cookie|session|private[-_]?key|credentials?)$/i;

/** Additional keys considered PII and masked (not fully removed) when PII masking is on. */
const PII_KEY_PATTERN = /^(email|e-mail|phone|mobile|ssn|dob|date[-_]?of[-_]?birth)$/i;

const TEXT_RULES: ReadonlyArray<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // Authorization headers / bearer & basic credentials
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // Provider API keys (OpenAI / Anthropic / OpenRouter style)
  [/\b(sk|rk|pk)-(ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // key=value / "key": "value" pairs with sensitive key names
  [
    /(["']?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access_token|refresh_token|token)["']?\s*[:=]\s*)(["']?)([^"'&\s,}]+)\2/gi,
    (_m, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  ],
];

const EMAIL_PATTERN = /\b([A-Za-z0-9._%+-])([A-Za-z0-9._%+-]*)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

export interface SanitizeOptions {
  /** Mask e-mail addresses and PII keys (default true). */
  maskPii?: boolean;
  /** Truncate long strings to this many characters (default: no truncation). */
  maxStringLength?: number;
  /** Maximum object depth before values are replaced by a marker (default 8). */
  maxDepth?: number;
}

/** Masks an e-mail address while keeping it recognisable: `j***@example.com`. */
export function maskEmail(email: string): string {
  return email.replace(
    EMAIL_PATTERN,
    (_m, first: string, _rest: string, domain: string) => `${first}***@${domain}`,
  );
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Removes terminal colour codes (Playwright error messages contain them). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Removes credentials, tokens and (optionally) PII from free text. Also strips ANSI codes. */
export function maskSensitiveText(text: string, options: SanitizeOptions = {}): string {
  let result = stripAnsi(text);
  for (const [pattern, replacement] of TEXT_RULES) {
    result =
      typeof replacement === 'string'
        ? result.replace(pattern, replacement)
        : result.replace(pattern, replacement);
  }
  if (options.maskPii !== false) result = maskEmail(result);
  return options.maxStringLength ? truncate(result, options.maxStringLength) : result;
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Deep-sanitises any value. Never mutates the input. Handles cycles, Errors,
 * Maps/Sets and arrays. Safe to call on arbitrary untrusted structures.
 */
export function redactSensitive<T>(value: T, options: SanitizeOptions = {}): T {
  const maxDepth = options.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(key))
      return input === undefined || input === null ? input : REDACTED;
    if (typeof input === 'string') {
      if (key !== undefined && options.maskPii !== false && PII_KEY_PATTERN.test(key)) {
        return input.includes('@') ? maskEmail(input) : REDACTED;
      }
      return maskSensitiveText(input, options);
    }
    if (input === null || typeof input !== 'object') return input;
    if (depth >= maxDepth) return '[MaxDepth]';
    if (seen.has(input)) return '[Circular]';
    seen.add(input);

    if (input instanceof Error) {
      return {
        name: input.name,
        message: maskSensitiveText(input.message, options),
        stack: input.stack ? maskSensitiveText(input.stack, options) : undefined,
      };
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input instanceof Map) {
      return Object.fromEntries(
        [...input.entries()].map(([k, v]) => [String(k), walk(v, depth + 1, String(k))]),
      );
    }
    if (input instanceof Set) return [...input].map((item) => walk(item, depth + 1));
    if (input instanceof Date) return input.toISOString();

    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) output[k] = walk(v, depth + 1, k);
    return output;
  };

  return walk(value, 0) as T;
}

/** Sanitises HTTP headers (case-insensitive) for logging. */
export function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, isSensitiveKey(k) ? REDACTED : maskSensitiveText(v)]),
  );
}

/**
 * Wraps untrusted content (web pages, API responses, documents) before it is
 * placed in an LLM prompt. The markers plus the system-prompt instruction form
 * the framework's prompt-injection defence: the model is told that anything
 * inside the markers is data, never instructions.
 */
export function wrapUntrusted(label: string, content: string, maxLength = 20_000): string {
  const safeLabel = label.replace(/[^A-Za-z0-9 _-]/g, '');
  const cleaned = maskSensitiveText(content, { maxStringLength: maxLength })
    // Neutralise attempts to close the wrapper from inside the content.
    .replace(/<\/?untrusted[^>]*>/gi, '[marker-removed]');
  return `<untrusted source="${safeLabel}">\n${cleaned}\n</untrusted>`;
}
