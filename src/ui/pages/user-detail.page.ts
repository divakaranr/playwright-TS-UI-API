import { expect, type Locator, type Page } from '@playwright/test';

import { BasePage } from './base.page.js';

/** Read-only user profile page (/users/:id). APPLICATION-SPECIFIC selectors. */
export class UserDetailPage extends BasePage {
  protected readonly path = '/users';
  readonly email: Locator;
  readonly role: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    super(page);
    this.email = page.getByTestId('user-email');
    this.role = page.getByTestId('user-role');
    this.status = page.getByTestId('user-status');
  }

  async expectDetails(expected: {
    name: string;
    email: string;
    role: string;
    status?: string;
  }): Promise<void> {
    await expect(this.page.getByRole('heading', { level: 1 })).toHaveText(expected.name);
    await expect(this.email).toHaveText(expected.email);
    await expect(this.role).toHaveText(expected.role);
    if (expected.status) await expect(this.status).toHaveText(expected.status);
  }
}
