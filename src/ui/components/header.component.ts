import { expect, type Locator, type Page } from '@playwright/test';

import { BaseComponent } from './base.component.js';

/** Application header: signed-in user, role and sign-out. APPLICATION-SPECIFIC selectors. */
export class HeaderComponent extends BaseComponent {
  readonly currentUser: Locator;
  readonly currentRole: Locator;
  readonly signOutButton: Locator;

  constructor(page: Page) {
    super(page.getByRole('banner'));
    this.currentUser = this.root.getByTestId('current-user');
    this.currentRole = this.root.getByTestId('current-role');
    this.signOutButton = this.root.getByRole('button', { name: 'Sign out' });
  }

  async expectSignedInAs(displayName: string, role?: string): Promise<void> {
    await expect(this.currentUser).toHaveText(displayName);
    if (role) await expect(this.currentRole).toHaveText(role);
  }

  async signOut(): Promise<void> {
    await this.signOutButton.click();
  }
}
