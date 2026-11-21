import { test, expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

import { ElementActions } from '../helpers/element-actions.js';
import {
  captureDownload,
  frameOf,
  handleNextDialog,
  uploadFiles,
  waitForNewTab,
  type DialogOptions,
  type DownloadResult,
  type UploadFile,
} from '../helpers/browser.helpers.js';

/**
 * Base class for page objects. Deliberately small: it provides navigation and a
 * thin, consistently-named facade over reusable helpers (ElementActions and
 * browser.helpers). Application behaviour belongs in concrete pages; reusable
 * widgets belong in components.
 */
export abstract class BasePage {
  /** Path relative to baseURL, e.g. '/login'. */
  protected abstract readonly path: string;
  protected readonly actions: ElementActions;

  constructor(readonly page: Page) {
    this.actions = new ElementActions(page);
  }

  /** Navigates to this page and waits until it is ready. */
  async navigate(query?: Record<string, string>): Promise<void> {
    const target = query ? `${this.path}?${new URLSearchParams(query).toString()}` : this.path;
    await this.actions.run('navigate', target, () => this.page.goto(target));
    await this.waitUntilLoaded();
  }

  /** Override to assert a page-specific readiness signal (e.g. heading visible). */
  async waitUntilLoaded(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded');
  }

  // ---- element interactions ---------------------------------------------------------
  protected click(locator: Locator): Promise<void> {
    return this.actions.click(locator);
  }

  protected fill(locator: Locator, value: string): Promise<void> {
    return this.actions.fill(locator, value);
  }

  protected selectOption(locator: Locator, label: string): Promise<string[]> {
    return this.actions.selectOption(locator, { label });
  }

  protected check(locator: Locator): Promise<void> {
    return this.actions.setChecked(locator, true);
  }

  protected uncheck(locator: Locator): Promise<void> {
    return this.actions.setChecked(locator, false);
  }

  protected getText(locator: Locator): Promise<string> {
    return this.actions.getText(locator);
  }

  // ---- web-first verifications ------------------------------------------------------
  async expectVisible(locator: Locator, message?: string): Promise<void> {
    await expect(locator, message).toBeVisible();
  }

  async expectEnabled(locator: Locator, message?: string): Promise<void> {
    await expect(locator, message).toBeEnabled();
  }

  async waitForUrl(url: string | RegExp): Promise<void> {
    await expect(this.page).toHaveURL(url);
  }

  // ---- browser features ---------------------------------------------------------------
  protected handleDialog(action: () => Promise<void>, options: DialogOptions): Promise<string> {
    return handleNextDialog(this.page, action, options);
  }

  protected frame(iframe: Locator): FrameLocator {
    return frameOf(iframe);
  }

  protected openInNewTab(action: () => Promise<void>): Promise<Page> {
    return waitForNewTab(this.page, action);
  }

  protected download(action: () => Promise<void>, targetDir?: string): Promise<DownloadResult> {
    return captureDownload(this.page, action, targetDir ?? test.info().outputPath('downloads'));
  }

  protected upload(input: Locator, files: UploadFile): Promise<void> {
    return this.actions.run('upload files', input, () => uploadFiles(input, files));
  }

  /** Captures a screenshot and attaches it to the current test report. */
  async screenshot(name: string, options: { fullPage?: boolean } = {}): Promise<Buffer> {
    const body = await this.page.screenshot({ fullPage: options.fullPage ?? true });
    await test.info().attach(name, { body, contentType: 'image/png' });
    return body;
  }
}
