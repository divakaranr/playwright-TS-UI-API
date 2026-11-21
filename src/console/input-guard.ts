import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Input validation & sanitisation for the Test Console.
 *
 * Defence in depth – these checks run on the SERVER before anything reaches the
 * LLM or the browser (the UI mirrors a subset for convenience only):
 *   URL    : strict regex → WHATWG parse → policy (scheme, credentials, length,
 *            host syntax, private/loopback/metadata addresses incl. after DNS).
 *   Prompt : Unicode normalisation, removal of invisible/control characters,
 *            length limits, deny-lists (markup/script, prompt-injection phrases,
 *            shell/code, secrets), off-site URLs, and a testing-scope check.
 * Deny-lists cannot catch everything; they are combined with a hardened system
 * prompt, tool allow-lists, the origin guard and output redaction.
 */

export const URL_MAX_LENGTH = 2048;
export const PROMPT_MIN_LENGTH = 10;
export const PROMPT_MAX_LENGTH = 2000;

/**
 * http(s)://host[:port][/path][?query][#fragment] – ASCII only, no user-info (`user:pass@`),
 * no whitespace, no IPv6 literals (use a hostname). IDNs must be given in punycode.
 */
export const URL_PATTERN =
  /^https?:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*(?::\d{1,5})?(?:\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*)?(?:\?[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?(?:#[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*)?$/;

export interface UrlPolicy {
  /** Allow localhost / private (RFC 1918) targets – for testing local or intranet apps. */
  allowPrivateNetwork: boolean;
  /** Optional hostname allowlist (exact match or "*.example.com"). Empty = any public host. */
  allowedHosts: readonly string[];
}

export type GuardResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

/** True for loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast, reserved. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      /^ff/.test(lower)
    );
  }
  return false;
}

/**
 * Addresses that are never legitimate test targets, even with CONSOLE_ALLOW_PRIVATE_NETWORK:
 * link-local (cloud metadata 169.254.169.254, fe80::/10), "this network" 0.0.0.0/8, unspecified,
 * multicast and reserved ranges.
 */
export function isAlwaysBlockedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || a >= 224 || (a === 169 && b === 254);
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isAlwaysBlockedAddress(mapped[1]!);
    return lower === '::' || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return false;
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((pattern) =>
    pattern.startsWith('*.')
      ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
      : hostname === pattern,
  );
}

type Lookup = (hostname: string) => Promise<string[]>;
const defaultLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true })).map((r) => r.address);

/** Validates and normalises the target URL. Returns the canonical URL without fragment. */
export async function validateTargetUrl(
  raw: unknown,
  policy: UrlPolicy,
  lookup: Lookup = defaultLookup,
): Promise<GuardResult<string>> {
  if (typeof raw !== 'string') return { ok: false, errors: ['URL must be text'] };
  const input = raw.trim();
  if (input.length === 0) return { ok: false, errors: ['URL is required'] };
  if (input.length > URL_MAX_LENGTH)
    return { ok: false, errors: [`URL must be at most ${URL_MAX_LENGTH} characters`] };
  if (!URL_PATTERN.test(input)) {
    return {
      ok: false,
      errors: [
        'URL must look like https://example.com/path (http/https only, no spaces, no user:password@, ASCII host)',
      ],
    };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, errors: ['URL could not be parsed'] };
  }
  const errors: string[] = [];
  if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.push('only http and https are allowed');
  if (url.username || url.password) errors.push('credentials in the URL are not allowed');
  const port = url.port ? Number(url.port) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) errors.push('port must be between 1 and 65535');

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || isAlwaysBlockedAddress(hostname)) {
    errors.push('link-local, metadata, multicast and reserved addresses are never allowed');
  }
  const isLocalName = hostname === 'localhost' || hostname.endsWith('.localhost') || !hostname.includes('.');
  if (!policy.allowPrivateNetwork && (isLocalName || isPrivateAddress(hostname))) {
    errors.push(
      'local/private network addresses are blocked (set CONSOLE_ALLOW_PRIVATE_NETWORK=true to test local apps)',
    );
  }
  if (!hostAllowed(hostname, policy.allowedHosts))
    errors.push(`host ${hostname} is not in CONSOLE_ALLOWED_HOSTS`);
  if (errors.length > 0) return { ok: false, errors };

  // Resolve names and check where they really point (SSRF / DNS tricks). Always-blocked ranges are
  // rejected in every mode; private ranges only when private networks are not allowed.
  if (isIP(hostname) === 0) {
    let addresses: string[];
    try {
      addresses = await lookup(hostname);
    } catch {
      return { ok: false, errors: [`host ${hostname} could not be resolved`] };
    }
    if (addresses.some(isAlwaysBlockedAddress)) {
      return {
        ok: false,
        errors: [`host ${hostname} resolves to a link-local/metadata or reserved address`],
      };
    }
    if (!policy.allowPrivateNetwork && addresses.some(isPrivateAddress)) {
      return { ok: false, errors: [`host ${hostname} resolves to a private network address`] };
    }
  }

  url.hash = '';
  return { ok: true, value: url.toString() };
}

// ---------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Zero-width, bidi overrides, word joiners, BOM, tag characters – used to hide instructions. */
const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

interface DenyRule {
  category: string;
  message: string;
  pattern: RegExp;
}

const DENY_RULES: DenyRule[] = [
  // Markup / script injection
  {
    category: 'markup',
    message: 'HTML/script markup is not allowed',
    pattern:
      /<\s*\/?\s*(script|iframe|object|embed|style|svg|img|link|meta|base|form|input|textarea|body|html|frame|video|audio|math)\b/i,
  },
  {
    category: 'markup',
    message: 'javascript:/vbscript:/data: URLs are not allowed',
    pattern: /\b(javascript|vbscript|livescript)\s*:|data\s*:\s*[a-z]+\/[a-z0-9.+-]+[;,]/i,
  },
  {
    category: 'markup',
    message: 'inline event handlers are not allowed',
    pattern: /\bon[a-z]{3,20}\s*=\s*["'`]?/i,
  },
  {
    category: 'markup',
    message: 'HTML entities / encoded markup are not allowed',
    pattern: /&#x?[0-9a-f]{2,6};|%3c\s*\/?\s*script|\\u003c/i,
  },
  {
    category: 'markup',
    message: 'template expressions are not allowed',
    pattern: /\$\{[^}]*\}|\{\{[^}]*\}\}|<%[\s\S]*?%>|<\?php/i,
  },
  // Prompt injection / role manipulation
  {
    category: 'injection',
    message: 'attempts to override instructions are not allowed',
    pattern:
      /\b(ignore|disregard|forget|override|bypass|skip)\b[\w\s,'"-]{0,40}\b(instructions?|rules?|prompts?|guidelines|guard ?rails|restrictions|polic(y|ies)|system)\b/i,
  },
  {
    category: 'injection',
    message: 'requests to reveal instructions or secrets are not allowed',
    pattern:
      /\b(reveal|show|print|display|repeat|output|leak|tell me|what (is|are))\b[\w\s,'"-]{0,40}\b(system ?prompt|instructions|api[ _-]?keys?|secrets?|tokens?|credentials|passwords?|\.env|env(ironment)? variables?)\b/i,
  },
  {
    category: 'injection',
    message: 'role or persona changes are not allowed',
    pattern:
      /\b(you are (now|no longer)|from now on,? you|pretend (to be|you are)|roleplay|jail ?break|DAN mode|developer mode|god mode|unfiltered|uncensored)\b/i,
  },
  {
    category: 'injection',
    message: 'chat-role markers are not allowed',
    pattern:
      /^\s*(system|assistant|developer|tool)\s*[:>]|<\|?\s*(im_start|im_end|endoftext|system|assistant)\s*\|?>|\[\/?(INST|SYS)\]|<<\/?SYS>>|#{2,}\s*(system|instruction)/im,
  },
  {
    category: 'injection',
    message: 'framework delimiter tags are not allowed',
    pattern: /<\/?\s*untrusted\b|<\/?\s*test_request\b/i,
  },
  // Code / shell / system access
  {
    category: 'code',
    message: 'shell commands are not allowed',
    pattern:
      /\b(rm\s+-[rf]+|sudo\b|chmod\s|chown\s|powershell|pwsh|cmd(\.exe)?\s*\/c|bash\s+-c|sh\s+-c|curl\s+-|wget\s|Invoke-(WebRequest|Expression)|nc\s+-|netcat|mkfifo)\b/i,
  },
  {
    category: 'code',
    message: 'code execution constructs are not allowed',
    pattern:
      /\b(child_process|require\s*\(|import\s*\(|process\.(env|exit|kill)|eval\s*\(|new\s+Function|exec(Sync)?\s*\(|spawn\s*\(|__proto__|constructor\s*\[)/i,
  },
  {
    category: 'code',
    message: 'local file or system paths are not allowed',
    pattern: /\bfile:\/\/|(^|\s)(\/etc\/|\/proc\/|~\/\.ssh|[a-z]:\\(windows|users)\\)|\.\.\/\.\.\//i,
  },
  // Abuse that is not functional testing
  {
    category: 'abuse',
    message: 'attacks, load tests and scanning are out of scope',
    pattern:
      /\b(ddos|dos attack|denial of service|brute[- ]?force|credential stuffing|load test|stress test|flood|spam|scrape (all|every)|exfiltrat\w*|sql ?injection payload|xss payload|port scan|crawl the (whole|entire) (site|internet))\b/i,
  },
];

/** Vocabulary that indicates a browser-testing task (at least one term must be present). */
const TESTING_SCOPE =
  /\b(test(s|ing|ed)?|verify|validate|validation|check|ensure|assert|confirm|explore|navigate|navigation|click|login|log ?in|sign ?(in|up|out)|log ?out|register|registration|form|forms|page|pages|button|link|links|menu|search|field|fields|input|submit|flow|journey|scenario|scenarios|error|errors|message|smoke|regression|ui|e2e|checkout|cart|filter|sort|upload|download|table|dialog|modal|tab|dropdown|accessib\w*|responsive|header|footer|title|heading)\b/i;

export interface SanitizedPrompt {
  prompt: string;
  /** Characters removed during normalisation (invisible/control). */
  removedCharacters: number;
}

/**
 * Normalises and validates the user's test request.
 * Rejects (does not silently rewrite) anything suspicious, so the user sees why.
 */
export function sanitizePrompt(raw: unknown, targetUrl: string): GuardResult<SanitizedPrompt> {
  if (typeof raw !== 'string') return { ok: false, errors: ['prompt must be text'] };
  const normalized = raw.normalize('NFKC').replace(/\r\n?/g, '\n');
  const cleaned = normalized
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const removedCharacters =
    normalized.length - normalized.replace(INVISIBLE_CHARS, '').replace(CONTROL_CHARS, '').length;

  const errors: string[] = [];
  if (cleaned.length < PROMPT_MIN_LENGTH)
    errors.push(`prompt must be at least ${PROMPT_MIN_LENGTH} characters`);
  if (cleaned.length > PROMPT_MAX_LENGTH)
    errors.push(`prompt must be at most ${PROMPT_MAX_LENGTH} characters`);
  if ((cleaned.match(/\n/g) ?? []).length > 40) errors.push('prompt has too many lines (max 40)');

  const seen = new Set<string>();
  for (const rule of DENY_RULES) {
    if (rule.pattern.test(cleaned) && !seen.has(rule.message)) {
      seen.add(rule.message);
      errors.push(rule.message);
    }
  }
  // Secrets must never be sent to the model.
  if (
    /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\b(password|passwd|pwd|api[_-]?key|token|secret)\s*[:=]\s*\S+/i.test(
      cleaned,
    )
  ) {
    errors.push('remove credentials, tokens or API keys from the prompt (use fake test data)');
  }
  // URLs in the prompt must stay on the target site.
  const targetOrigin = new URL(targetUrl).origin;
  for (const match of cleaned.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi)) {
    try {
      if (new URL(match[0]).origin !== targetOrigin)
        errors.push(`URL ${match[0]} is outside the target site ${targetOrigin}`);
    } catch {
      errors.push(`invalid URL in prompt: ${match[0]}`);
    }
  }
  if (errors.length === 0 && !TESTING_SCOPE.test(cleaned)) {
    errors.push(
      'describe what should be tested on the website (e.g. "test the login form with invalid input")',
    );
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { prompt: cleaned, removedCharacters } };
}

/** Text typed into the page by the agent must not carry script payloads. */
export function isScriptPayload(text: string): boolean {
  return DENY_RULES.filter((r) => r.category === 'markup').some((r) =>
    r.pattern.test(text.normalize('NFKC')),
  );
}

/**
 * Removes known secret values (API keys, passwords, tokens from the environment)
 * from any text leaving the server – a last line of defence against exfiltration.
 */
export class SecretRedactor {
  private readonly secrets: string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.secrets = Object.entries(env)
      .filter(
        ([key, value]) => value && value.length >= 6 && /(KEY|SECRET|TOKEN|PASSWORD|PASSWD)$/i.test(key),
      )
      .map(([, value]) => value!)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }

  contains(text: string): boolean {
    return this.secrets.some((secret) => text.includes(secret));
  }

  /** Deep-redacts all strings of a JSON-serialisable value. */
  redactValue<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value))) as T;
  }
}
