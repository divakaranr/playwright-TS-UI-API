import type { Locator } from '@playwright/test';

/**
 * Base for reusable UI widgets. A component is scoped to a root locator so its
 * child locators can never accidentally match elements elsewhere on the page.
 */
export abstract class BaseComponent {
  constructor(readonly root: Locator) {}
}
