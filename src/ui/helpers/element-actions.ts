import type { Locator, Page } from '@playwright/test';

import { UiActionError } from '../../core/exceptions/index.js';

/**
 * Element interactions with contextual error messages. Each action relies on
 * Playwright's built-in actionability auto-waiting (no sleeps); on failure the
 * original error is preserved as `cause` and wrapped with the action, target
 * locator and current URL. Errors are never swallowed.
 */
export class ElementActions {
  constructor(private readonly page: Page) {}

  async run<T>(
    action: string,
    target: Locator | string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw new UiActionError(
        action,
        { url: this.safeUrl(), target: target === undefined ? undefined : String(target) },
        error,
      );
    }
  }

  click(locator: Locator, options?: Parameters<Locator['click']>[0]): Promise<void> {
    return this.run('click', locator, () => locator.click(options));
  }

  fill(locator: Locator, value: string): Promise<void> {
    return this.run('fill', locator, () => locator.fill(value));
  }

  selectOption(locator: Locator, value: string | { label: string } | { value: string }): Promise<string[]> {
    return this.run('select option', locator, () => locator.selectOption(value));
  }

  setChecked(locator: Locator, checked: boolean): Promise<void> {
    return this.run(checked ? 'check' : 'uncheck', locator, () => locator.setChecked(checked));
  }

  async getText(locator: Locator): Promise<string> {
    return (await this.run('read text', locator, () => locator.innerText())).trim();
  }

  private safeUrl(): string | undefined {
    try {
      return this.page.url();
    } catch {
      return undefined;
    }
  }
}
