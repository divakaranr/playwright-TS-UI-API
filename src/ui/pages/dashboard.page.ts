import { expect, type Locator, type Page } from '@playwright/test';

import { HeaderComponent } from '../components/header.component.js';
import { ModalComponent } from '../components/modal.component.js';
import { NavigationComponent } from '../components/navigation.component.js';
import { BasePage } from './base.page.js';

/** Dashboard. APPLICATION-SPECIFIC selectors. */
export class DashboardPage extends BasePage {
  protected readonly path = '/dashboard';
  readonly header: HeaderComponent;
  readonly navigation: NavigationComponent;
  readonly announcement: ModalComponent;
  readonly heading: Locator;
  readonly welcomeMessage: Locator;
  readonly totalUsersStat: Locator;
  private readonly helpWidget: Locator;

  constructor(page: Page) {
    super(page);
    this.header = new HeaderComponent(page);
    this.navigation = new NavigationComponent(page);
    this.announcement = new ModalComponent(page, 'Announcement');
    this.heading = page.getByRole('heading', { name: 'Dashboard', level: 1 });
    this.welcomeMessage = page.getByTestId('welcome-message');
    this.totalUsersStat = page.getByTestId('stat-total-users');
    this.helpWidget = page.getByTitle('Help widget');
  }

  override async waitUntilLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  async totalUsers(): Promise<number> {
    return Number(await this.getText(this.totalUsersStat));
  }

  async openAnnouncement(): Promise<void> {
    await this.click(this.page.getByRole('button', { name: 'Show announcement' }));
    await this.announcement.expectOpen();
  }

  async acknowledgeAnnouncement(): Promise<void> {
    await this.announcement.clickButton('Acknowledge');
    await this.announcement.expectClosed();
  }

  /** Interacts with content inside the help <iframe> and returns the status text. */
  async contactSupport(): Promise<string> {
    const frame = this.frame(this.helpWidget);
    await frame.getByRole('button', { name: 'Contact support' }).click();
    const status = frame.getByRole('status');
    await expect(status).toHaveText('Support request sent');
    return status.innerText();
  }

  /** Opens release notes (target=_blank) and returns the new tab. */
  async openReleaseNotes(): Promise<Page> {
    return this.openInNewTab(() => this.click(this.page.getByRole('link', { name: 'Open release notes' })));
  }
}
