import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  chromium,
  request as playwrightRequest,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { AuthApiClient } from '../../api/clients/auth-api.client.js';
import { BaseApiClient } from '../../api/clients/base-api.client.js';
import { AuthService } from '../../auth/auth.service.js';
import { StorageStateManager } from '../../auth/storage-state.manager.js';
import { TokenManager } from '../../auth/token.manager.js';
import { getCredentials, type FrameworkConfig } from '../../config/index.js';
import { LoginPage } from '../../ui/pages/login.page.js';
import { fileTimestamp } from '../../utils/date.util.js';
import { paths } from '../../utils/paths.js';
import { maskSensitiveText, sanitizeHeaders, truncate } from '../../utils/sanitizer.js';
import { EnvironmentPolicyError, FrameworkError } from '../exceptions/index.js';

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'spinbutton',
]);

export interface InteractiveElement {
  role: string;
  name: string;
  suggestedLocator: string;
}

export type WorkflowTarget =
  { role: string; name?: string } | { label: string } | { testId: string } | { text: string };
export interface WorkflowStep {
  action: 'goto' | 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'press' | 'expectVisible';
  target?: WorkflowTarget;
  value?: string;
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Parses Playwright's ARIA snapshot YAML into interactive elements with suggested locators. */
export function parseAriaSnapshot(snapshot: string): InteractiveElement[] {
  const elements: InteractiveElement[] = [];
  const seen = new Set<string>();
  for (const line of snapshot.split('\n')) {
    const match = /^\s*- (\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
    if (!match) continue;
    const [, role = '', rawName = ''] = match;
    if (!INTERACTIVE_ROLES.has(role)) continue;
    const name = rawName.replace(/\\"/g, '"');
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({
      role,
      name,
      suggestedLocator:
        (role === 'textbox' || role === 'combobox') && name
          ? `page.getByLabel(${quote(name)})`
          : name
            ? `page.getByRole(${quote(role)}, { name: ${quote(name)} })`
            : `page.getByRole(${quote(role)}) /* no accessible name – add a label or data-testid */`,
    });
  }
  return elements;
}

/**
 * Browser and API inspection used by MCP exploration tools. Every target URL is
 * restricted to the configured environment's origins; API inspection is
 * read-only (GET/HEAD/OPTIONS). Page content is returned sanitised and should be
 * treated as untrusted by callers.
 */
export class AppInspectionService {
  constructor(private readonly config: FrameworkConfig) {}

  resolveUrl(target: string): string {
    const base = this.config.environment.baseUrl;
    const allowedOrigins = new Set([
      new URL(base).origin,
      new URL(this.config.environment.apiBaseUrl).origin,
    ]);
    const url = /^[a-z][a-z0-9+.-]*:/i.test(target)
      ? new URL(target)
      : new URL(target.startsWith('/') ? target : `/${target}`, base);
    if (!allowedOrigins.has(url.origin)) {
      throw new EnvironmentPolicyError(
        `URL origin ${url.origin} is not allowed; permitted: ${[...allowedOrigins].join(', ')}`,
      );
    }
    return url.toString();
  }

  async inspectApplication(target: string, role?: string) {
    return this.withPage(role, async (page, consoleErrors) => {
      await page.goto(this.resolveUrl(target));
      const snapshot = await page.locator('body').ariaSnapshot();
      const counts = await page.evaluate(() => ({
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button, [role=button], input[type=submit]').length,
        inputs: document.querySelectorAll('input, select, textarea').length,
        forms: document.querySelectorAll('form').length,
        iframes: document.querySelectorAll('iframe').length,
        dialogs: document.querySelectorAll('[role=dialog], dialog').length,
      }));
      return {
        url: page.url(),
        title: await page.title(),
        headings: (await page.getByRole('heading').allInnerTexts())
          .slice(0, 30)
          .map((h) => maskSensitiveText(h.trim())),
        landmarks: (
          await page
            .locator('header, nav, main, footer, aside, [role=search], form')
            .evaluateAll((els) =>
              els.map(
                (e) =>
                  `${e.tagName.toLowerCase()}${e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : ''}`,
              ),
            )
        ).slice(0, 30),
        counts,
        consoleErrors,
        ariaSnapshot: truncate(maskSensitiveText(snapshot), 12_000),
      };
    });
  }

  async inspectElements(target: string, role?: string) {
    return this.withPage(role, async (page) => {
      await page.goto(this.resolveUrl(target));
      const elements = parseAriaSnapshot(await page.locator('body').ariaSnapshot());
      const testIds = await page
        .locator('[data-testid]')
        .evaluateAll((els) =>
          els
            .slice(0, 100)
            .map((e) => ({ testId: e.getAttribute('data-testid') ?? '', tag: e.tagName.toLowerCase() })),
        );
      return {
        url: page.url(),
        interactiveElements: elements.slice(0, 200),
        testIds: testIds.map((t) => ({ ...t, suggestedLocator: `page.getByTestId(${quote(t.testId)})` })),
        guidance:
          'Prefer getByRole/getByLabel; use getByTestId when no stable accessible name exists. Avoid CSS/XPath.',
      };
    });
  }

  async exploreWorkflow(startUrl: string, steps: WorkflowStep[], role?: string) {
    const outDir = path.join(paths.reports, 'mcp-exploration', fileTimestamp());
    mkdirSync(outDir, { recursive: true });
    return this.withPage(role, async (page, consoleErrors) => {
      await page.goto(this.resolveUrl(startUrl));
      const results: Array<{
        index: number;
        action: string;
        target?: string;
        ok: boolean;
        url: string;
        error?: string;
        screenshot: string;
      }> = [];
      for (const [index, step] of steps.entries()) {
        const description = step.target ? JSON.stringify(step.target) : undefined;
        let error: string | undefined;
        try {
          await this.performStep(page, step);
        } catch (e) {
          error = maskSensitiveText((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '');
        }
        const screenshot = path.join(outDir, `step-${String(index + 1).padStart(2, '0')}.png`);
        await page.screenshot({ path: screenshot }).catch(() => undefined);
        results.push({
          index: index + 1,
          action: step.action,
          ...(description ? { target: description } : {}),
          ok: !error,
          url: page.url(),
          ...(error ? { error } : {}),
          screenshot: path.relative(paths.root, screenshot),
        });
        if (error) break;
      }
      return {
        completed: results.every((r) => r.ok) && results.length === steps.length,
        steps: results,
        finalUrl: page.url(),
        finalTitle: await page.title(),
        consoleErrors,
        finalAriaSnapshot: truncate(maskSensitiveText(await page.locator('body').ariaSnapshot()), 8000),
        artifactsDir: path.relative(paths.root, outDir),
      };
    });
  }

  async inspectApiEndpoint(
    endpoint: string,
    options: { method: 'GET' | 'HEAD' | 'OPTIONS'; query?: Record<string, string>; role?: string },
  ) {
    const context = await playwrightRequest.newContext();
    try {
      const options_ = {
        baseUrl: this.config.environment.apiBaseUrl,
        config: this.config,
        timeoutMs: 15_000,
      };
      const authApi = new AuthApiClient(context, options_);
      const auth = options.role
        ? new AuthService(this.config, authApi, new TokenManager()).bearerFor(options.role)
        : undefined;
      const client = new BaseApiClient(context, { ...options_, ...(auth ? { auth } : {}) });
      const url = client.buildUrl(endpoint);
      if (url.origin !== new URL(this.config.environment.apiBaseUrl).origin)
        throw new EnvironmentPolicyError('Endpoint must be on the API origin');

      // Read-only by construction: only safe methods reach the network.
      const response = await (options.method === 'GET'
        ? client.get(endpoint, { ...(options.query ? { params: options.query } : {}) })
        : client.send(options.method, endpoint, undefined, {
            ...(options.query ? { params: options.query } : {}),
          }));
      const text = await response.text();
      let shape: Record<string, string> | undefined;
      try {
        const json = JSON.parse(text) as unknown;
        if (json && typeof json === 'object') {
          shape = Object.fromEntries(
            Object.entries(json).map(([k, v]) => [
              k,
              Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v,
            ]),
          );
        }
      } catch {
        // not JSON
      }
      return {
        request: `${options.method} ${url.pathname}${url.search}`,
        status: response.status(),
        durationMs: response.durationMs,
        headers: sanitizeHeaders(response.headers()),
        ...(shape ? { topLevelShape: shape } : {}),
        bodyExcerpt: truncate(maskSensitiveText(text), 4000),
      };
    } finally {
      await context.dispose();
    }
  }

  private async performStep(page: Page, step: WorkflowStep): Promise<void> {
    const timeout = 10_000;
    if (step.action === 'goto') {
      await page.goto(this.resolveUrl(step.value ?? '/'), { timeout });
      return;
    }
    if (!step.target) throw new FrameworkError('INVALID_STEP', `${step.action} requires a target`);
    const locator = this.locatorFor(page, step.target);
    switch (step.action) {
      case 'click':
        return locator.click({ timeout });
      case 'fill':
        return locator.fill(step.value ?? '', { timeout });
      case 'select':
        await locator.selectOption({ label: step.value ?? '' }, { timeout });
        return;
      case 'check':
        return locator.check({ timeout });
      case 'uncheck':
        return locator.uncheck({ timeout });
      case 'press':
        return locator.press(step.value ?? 'Enter', { timeout });
      case 'expectVisible':
        return locator.waitFor({ state: 'visible', timeout });
    }
  }

  private locatorFor(page: Page, target: WorkflowTarget): Locator {
    if ('role' in target) {
      return page
        .getByRole(target.role as Parameters<Page['getByRole']>[0], target.name ? { name: target.name } : {})
        .first();
    }
    if ('label' in target) return page.getByLabel(target.label).first();
    if ('testId' in target) return page.getByTestId(target.testId).first();
    return page.getByText(target.text).first();
  }

  private async withPage<T>(
    role: string | undefined,
    work: (page: Page, consoleErrors: string[]) => Promise<T>,
  ): Promise<T> {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const context = await this.createContext(browser, role);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const consoleErrors: string[] = [];
      page.on(
        'console',
        (m) =>
          m.type() === 'error' &&
          consoleErrors.length < 50 &&
          consoleErrors.push(maskSensitiveText(m.text())),
      );
      page.on(
        'pageerror',
        (e) => consoleErrors.length < 50 && consoleErrors.push(maskSensitiveText(e.message)),
      );
      return await work(page, consoleErrors);
    } finally {
      await browser?.close();
    }
  }

  private async createContext(browser: Browser, role: string | undefined): Promise<BrowserContext> {
    const baseURL = this.config.environment.baseUrl;
    if (!role) return browser.newContext({ baseURL });
    const states = new StorageStateManager(this.config.environment.name);
    if (states.exists(role)) return browser.newContext({ baseURL, storageState: states.pathFor(role) });
    // No stored session: authenticate through the UI with the role's configured credentials.
    const context = await browser.newContext({ baseURL });
    const login = new LoginPage(await context.newPage());
    await login.navigate();
    await login.login(getCredentials(this.config, role));
    await login.verifyLoginSuccess();
    await login.page.close();
    return context;
  }
}
