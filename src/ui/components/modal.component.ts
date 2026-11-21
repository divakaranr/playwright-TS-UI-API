import { expect, type Locator, type Page } from '@playwright/test';

import { BaseComponent } from './base.component.js';

/**
 * Generic accessible modal dialog (role="dialog" with an accessible name).
 * Works for any modal: pass its title.
 */
export class ModalComponent extends BaseComponent {
  constructor(page: Page, title: string | RegExp) {
    super(page.getByRole('dialog', { name: title }));
  }

  field(label: string | RegExp): Locator {
    return this.root.getByLabel(label);
  }

  button(name: string | RegExp): Locator {
    return this.root.getByRole('button', { name });
  }

  get errorMessage(): Locator {
    return this.root.getByRole('alert');
  }

  async expectOpen(): Promise<void> {
    await expect(this.root).toBeVisible();
  }

  async expectClosed(): Promise<void> {
    await expect(this.root).toBeHidden();
  }

  async clickButton(name: string | RegExp): Promise<void> {
    await this.button(name).click();
  }
}
