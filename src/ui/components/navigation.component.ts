import type { Page } from '@playwright/test';

import { BaseComponent } from './base.component.js';

export type NavigationTarget = 'Dashboard' | 'Users' | 'Search';

/** Primary navigation bar. APPLICATION-SPECIFIC link names. */
export class NavigationComponent extends BaseComponent {
  constructor(page: Page) {
    super(page.getByRole('navigation', { name: 'Main' }));
  }

  async goTo(target: NavigationTarget): Promise<void> {
    await this.root.getByRole('link', { name: target, exact: true }).click();
  }
}
