import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';

import type { AgentTool, ToolOutcome } from '../agent/types.js';
import { isAlwaysBlockedAddress, isPrivateAddress } from '../console/input-guard.js';

/**
 * In-process browser tools for the hosted (serverless) Test Console, built on
 * playwright-core instead of a separate Playwright MCP process. Tool names and
 * semantics mirror the official Playwright MCP (aria snapshot with [ref=eN],
 * actions by ref), so the same hardened system prompt applies.
 *
 * Network guard (independent of the model): main-frame navigation is locked to
 * the target origin; every request to localhost, private, link-local or cloud
 * metadata addresses is aborted (DNS-resolved, cached); only http(s) is allowed.
 */

export type BrowserLauncher = () => Promise<Browser>;

/** Serverless Chromium on Vercel/AWS Lambda, Playwright's installed Chromium elsewhere. */
export const launchBrowser: BrowserLauncher = async () => {
  const { chromium } = await import('playwright-core');
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const serverless = (await import('@sparticuz/chromium')).default;
    serverless.setGraphicsMode = false;
    return chromium.launch({
      executablePath: await serverless.executablePath(),
      args: serverless.args,
      headless: true,
    });
  }
  return chromium.launch({ headless: true });
};

export interface BrowserSessionOptions {
  targetUrl: string;
  /** Tests only: allow localhost/private targets (the hosted app never sets this). */
  allowPrivateNetwork?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_SNAPSHOT_CHARS = 14_000;
const ACTION_TIMEOUT_MS = 10_000;
const NAV_TIMEOUT_MS = 30_000;

const refSchema = z.string().regex(/^[a-z0-9]{1,16}$/, 'ref must come from the latest snapshot (e.g. e12)');
const elementSchema = z.string().max(200).optional();

export class BrowserSession {
  private context?: BrowserContext;
  page?: Page;
  private readonly origin: string;
  private readonly hostChecks = new Map<string, Promise<boolean>>();

  constructor(
    private readonly browser: Browser,
    private readonly options: BrowserSessionOptions,
  ) {
    this.origin = new URL(options.targetUrl).origin;
  }

  async open(): Promise<Page> {
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false,
      userAgent: undefined,
    });
    this.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await this.context.route('**/*', async (route) => {
      const request = route.request();
      const verdict = await this.checkRequest(
        request.url(),
        request.isNavigationRequest() && request.frame() === this.page?.mainFrame(),
      );
      if (verdict) await route.abort('blockedbyclient');
      else await route.continue();
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
  }

  /** Returns a reason when the request must be blocked. */
  async checkRequest(url: string, isMainNavigation: boolean): Promise<string | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'invalid url';
    }
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return undefined;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'protocol';
    if (isMainNavigation && parsed.origin !== this.origin) return 'off-origin navigation';
    if (this.options.allowPrivateNetwork) return undefined;
    return (await this.isPublicHost(parsed.hostname)) ? undefined : 'private address';
  }

  private isPublicHost(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    let check = this.hostChecks.get(host);
    if (!check) {
      check = (async () => {
        if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
        const addresses = isIP(host)
          ? [host]
          : await (
              this.options.resolve ?? (async (h) => (await lookup(h, { all: true })).map((a) => a.address))
            )(host).catch(() => []);
        return (
          addresses.length > 0 && addresses.every((a) => !isPrivateAddress(a) && !isAlwaysBlockedAddress(a))
        );
      })();
      this.hostChecks.set(host, check);
    }
    return check;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('browser not open');
    return this.page;
  }

  async snapshot(): Promise<string> {
    const page = this.requirePage();
    const tree = await page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
    const header = `Page URL: ${page.url()}\nPage title: ${await page.title()}\n\n`;
    return (
      header +
      (tree.length > MAX_SNAPSHOT_CHARS
        ? `${tree.slice(0, MAX_SNAPSHOT_CHARS)}\n… (snapshot truncated)`
        : tree)
    );
  }

  async screenshot(): Promise<string> {
    const buffer = await this.requirePage().screenshot({
      type: 'jpeg',
      quality: 55,
      timeout: ACTION_TIMEOUT_MS,
    });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }

  /** Agent tools bound to this session. `onVisual` receives a screenshot after page-changing actions. */
  tools(onVisual: (caption: string) => Promise<void>): AgentTool[] {
    const withSnapshot = async (caption: string, action: () => Promise<void>): Promise<ToolOutcome> => {
      try {
        await action();
        await this.requirePage()
          .waitForLoadState('domcontentloaded', { timeout: 5000 })
          .catch(() => undefined);
        await onVisual(caption);
        return { text: await this.snapshot() };
      } catch (error) {
        return { text: `Action failed: ${(error as Error).message.split('\n')[0]}`, isError: true };
      }
    };
    const locate = (ref: string) => this.requirePage().locator(`aria-ref=${ref}`);
    const tool = <S extends z.ZodType<Record<string, unknown>>>(
      name: string,
      description: string,
      schema: S,
      parameters: Record<string, unknown>,
      run: (args: z.infer<S>) => Promise<ToolOutcome>,
    ): AgentTool => ({
      spec: { name, description, parameters },
      execute: async (raw) => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success)
          return {
            text: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
            isError: true,
          };
        return run(parsed.data);
      },
    });
    const refParams = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
      type: 'object',
      properties: {
        element: { type: 'string', description: 'Human-readable element description' },
        ref: { type: 'string', description: 'Exact element ref from the latest snapshot, e.g. e12' },
        ...extra,
      },
      required: ['ref', ...required],
      additionalProperties: false,
    });

    return [
      tool(
        'browser_navigate',
        'Navigate to a URL on the target website and return the page snapshot.',
        z.object({ url: z.string().max(2048) }).strict(),
        {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          additionalProperties: false,
        },
        async ({ url }) => {
          let absolute: URL;
          try {
            absolute = new URL(url, this.origin);
          } catch {
            return { text: 'Invalid URL', isError: true };
          }
          if (absolute.origin !== this.origin)
            return { text: `Navigation blocked: only ${this.origin} may be visited.`, isError: true };
          return withSnapshot(`navigate ${absolute.pathname}`, async () => {
            await this.requirePage().goto(absolute.toString(), { waitUntil: 'domcontentloaded' });
          });
        },
      ),
      tool(
        'browser_snapshot',
        'Accessibility snapshot of the current page with element refs ([ref=eN]). Use it to find elements.',
        z.object({}).strict(),
        { type: 'object', properties: {}, additionalProperties: false },
        async () => ({ text: await this.snapshot() }),
      ),
      tool(
        'browser_click',
        'Click an element identified by its ref from the latest snapshot.',
        z.object({ element: elementSchema, ref: refSchema }).strict(),
        refParams(),
        async ({ ref, element }) => withSnapshot(`click ${element ?? ref}`, () => locate(ref).click()),
      ),
      tool(
        'browser_type',
        'Type text into an editable element (replaces its value). Set submit=true to press Enter afterwards.',
        z
          .object({
            element: elementSchema,
            ref: refSchema,
            text: z.string().max(2000),
            submit: z.boolean().optional(),
          })
          .strict(),
        refParams({ text: { type: 'string' }, submit: { type: 'boolean' } }, ['text']),
        async ({ ref, element, text, submit }) =>
          withSnapshot(`type into ${element ?? ref}`, async () => {
            await locate(ref).fill(text);
            if (submit) await locate(ref).press('Enter');
          }),
      ),
      tool(
        'browser_select_option',
        'Select option(s) in a dropdown identified by ref.',
        z
          .object({
            element: elementSchema,
            ref: refSchema,
            values: z.array(z.string().max(200)).min(1).max(10),
          })
          .strict(),
        refParams({ values: { type: 'array', items: { type: 'string' } } }, ['values']),
        async ({ ref, element, values }) =>
          withSnapshot(`select in ${element ?? ref}`, async () => {
            await locate(ref).selectOption(values);
          }),
      ),
      tool(
        'browser_hover',
        'Hover over an element identified by ref.',
        z.object({ element: elementSchema, ref: refSchema }).strict(),
        refParams(),
        async ({ ref, element }) => withSnapshot(`hover ${element ?? ref}`, () => locate(ref).hover()),
      ),
      tool(
        'browser_press_key',
        'Press a keyboard key on the focused element, e.g. Enter, Tab, Escape, ArrowDown.',
        z
          .object({ key: z.string().regex(/^[A-Za-z0-9+]{1,30}$/, 'key name such as Enter or Shift+Tab') })
          .strict(),
        {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
        async ({ key }) => withSnapshot(`press ${key}`, () => this.requirePage().keyboard.press(key)),
      ),
      tool(
        'browser_navigate_back',
        'Go back to the previous page.',
        z.object({}).strict(),
        { type: 'object', properties: {}, additionalProperties: false },
        async () =>
          withSnapshot('back', async () => {
            await this.requirePage().goBack();
          }),
      ),
      tool(
        'browser_wait_for',
        'Wait until a text appears on the page (max 10 s).',
        z.object({ text: z.string().min(1).max(200) }).strict(),
        {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        async ({ text }) =>
          withSnapshot(`wait for "${text}"`, async () => {
            await this.requirePage().getByText(text).first().waitFor({ state: 'visible', timeout: 10_000 });
          }),
      ),
      tool(
        'browser_take_screenshot',
        'Capture a screenshot for the human reviewer (the image is not returned to you).',
        z.object({ caption: z.string().max(120).optional() }).strict(),
        { type: 'object', properties: { caption: { type: 'string' } }, additionalProperties: false },
        async ({ caption }) => {
          await onVisual(caption ?? 'screenshot');
          return { text: 'Screenshot captured for the report.' };
        },
      ),
    ];
  }
}
