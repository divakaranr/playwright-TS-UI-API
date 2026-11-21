import { expect, type Locator, type Page } from '@playwright/test';

import type { Credentials } from '../../config/index.js';
import { BasePage } from './base.page.js';

/**
 * Login page.
 * APPLICATION-SPECIFIC: labels/button names reflect the demo app – adapt the
 * locators in the constructor for your application; keep the public API.
 */
export class LoginPage extends BasePage {
  protected readonly path = '/login';
  readonly heading: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly signInButton: Locator;
  readonly errorAlert: Locator;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { name: 'Sign in' });
    this.usernameInput = page.getByLabel(/username/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.signInButton = page.getByRole('button', { name: /sign in|log ?in/i });
    this.errorAlert = page.getByRole('alert');
  }

  override async waitUntilLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  async login(credentials: Credentials): Promise<void> {
    await this.fill(this.usernameInput, credentials.username);
    await this.fill(this.passwordInput, credentials.password);
    await this.click(this.signInButton);
  }

  async verifyLoginSuccess(): Promise<void> {
    await this.waitForUrl(/\/dashboard/);
  }

  async expectError(message: string | RegExp): Promise<void> {
    await expect(this.errorAlert).toContainText(message);
    await expect(this.page).toHaveURL(/\/login/);
  }
}
