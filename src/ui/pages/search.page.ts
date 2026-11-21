import { expect, type Locator, type Page } from '@playwright/test';

import { BasePage } from './base.page.js';

/** Global search. APPLICATION-SPECIFIC selectors. */
export class SearchPage extends BasePage {
  protected readonly path = '/search';
  readonly searchInput: Locator;
  readonly resultCount: Locator;
  readonly results: Locator;

  constructor(page: Page) {
    super(page);
    this.searchInput = page.getByRole('searchbox', { name: 'Search' });
    this.resultCount = page.getByTestId('result-count');
    this.results = page.getByRole('list', { name: 'Search results' }).getByRole('listitem');
  }

  override async waitUntilLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();
  }

  async search(term: string): Promise<void> {
    await this.fill(this.searchInput, term);
    await this.click(this.page.getByRole('button', { name: 'Search', exact: true }));
    await expect(this.resultCount).toBeVisible();
  }

  async expectResultCount(count: number): Promise<void> {
    await expect(this.results).toHaveCount(count);
    await expect(this.resultCount).toHaveText(`${count} ${count === 1 ? 'result' : 'results'}`);
  }

  async openResult(name: string): Promise<void> {
    await this.click(this.page.getByRole('link', { name, exact: true }));
  }
}
