import { isScriptPayload } from '../console/input-guard.js';

/**
 * Static safety checks for model-written test code before it is saved and executed.
 * Generated tests may only import @playwright/test and must not touch the process,
 * filesystem, network modules or dynamic code evaluation. This is a guard-rail
 * against prompt injection from page content – not a sandbox.
 */
export function validateGeneratedTestCode(code: string, targetUrl?: string): string[] {
  const problems: string[] = [];
  if (code.length > 60_000) problems.push('file is larger than 60 000 characters');
  // Hidden characters could disguise code from the human reviewer.
  if (/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(code))
    problems.push('invisible/bidi Unicode characters are not allowed');
  const imports = [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
  for (const source of imports) {
    if (source !== '@playwright/test')
      problems.push(`import from "${source}" is not allowed (only @playwright/test)`);
  }
  const forbidden: Array<[RegExp, string]> = [
    [/\brequire\s*\(/, 'require()'],
    [/\bimport\s*\(/, 'dynamic import()'],
    [/\bimport\s+['"]/, 'side-effect imports'],
    [/\bprocess\s*[.[]/, 'process access'],
    [/\b(eval|Function)\s*\(|\bsetTimeout\s*\(\s*['"`]/, 'dynamic code evaluation'],
    [/child_process|node:|\bglobalThis\b|__dirname|__filename|\bBuffer\b/, 'Node.js internals'],
    [/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/, 'direct network access'],
    [
      /\.\s*(evaluate|evaluateHandle|evaluateAll|\$eval|\$\$eval|addInitScript|addScriptTag|addStyleTag|exposeFunction|exposeBinding)\s*\(/,
      'injecting code into the page',
    ],
    [
      /\.\s*(route|routeFromHAR|routeWebSocket|setExtraHTTPHeaders|setHTTPCredentials|grantPermissions)\s*\(/,
      'network interception or credential/permission changes',
    ],
    [
      /\b(request|playwright|browserType|chromium|firefox|webkit)\s*\.\s*(newContext|launch|connect|get|post|put|patch|delete|fetch)\s*\(/,
      'additional browsers or API request contexts',
    ],
    [/\.\s*(setInputFiles|saveAs|storageState)\s*\(|\bpath\s*:\s*['"`]/, 'file system access'],
    [/waitForTimeout\s*\(/, 'fixed sleeps (use web-first assertions)'],
  ];
  for (const [pattern, label] of forbidden) if (pattern.test(code)) problems.push(`${label} is not allowed`);

  // Absolute URLs must stay on the target site (relative page.goto('/…') is preferred).
  if (targetUrl) {
    const origin = new URL(targetUrl).origin;
    for (const match of code.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi)) {
      let other: string | undefined;
      try {
        other = new URL(match[0]).origin === origin ? undefined : match[0];
      } catch {
        other = match[0];
      }
      if (other) problems.push(`URL ${other} is outside the target site ${origin}`);
    }
  }
  if (isScriptPayload(code.replace(/<\/?\s*(main|header|nav)\b/gi, '')))
    problems.push('script/markup payloads are not allowed');
  if (!/\btest\s*\(/.test(code)) problems.push('no test(...) found');
  return [...new Set(problems)];
}
