import { expect, type Locator, type Page } from '@playwright/test';

import { ModalComponent } from '../components/modal.component.js';
import type { DownloadResult, UploadFile } from '../helpers/browser.helpers.js';
import { BasePage } from './base.page.js';

export interface UserRowData {
  name: string;
  email: string;
  role: string;
  status: string;
}

export interface UserEdit {
  firstName?: string;
  lastName?: string;
  role?: 'admin' | 'editor' | 'viewer';
  status?: 'active' | 'inactive';
}

/** User management (list/filter/edit/delete/import/export). APPLICATION-SPECIFIC selectors. */
export class UserManagementPage extends BasePage {
  protected readonly path = '/users';
  readonly heading: Locator;
  readonly filterInput: Locator;
  readonly statusMessage: Locator;
  readonly usersTable: Locator;
  readonly editDialog: ModalComponent;

  constructor(page: Page) {
    super(page);
    this.heading = page.getByRole('heading', { name: 'User Management' });
    this.filterInput = page.getByLabel('Filter users');
    this.statusMessage = page.locator('#users-status');
    this.usersTable = page.getByRole('table', { name: 'Users' });
    this.editDialog = new ModalComponent(page, 'Edit user');
  }

  override async waitUntilLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  rowFor(email: string): Locator {
    return this.usersTable.getByRole('row').filter({ hasText: email });
  }

  async filter(term: string): Promise<void> {
    await this.fill(this.filterInput, term);
    await this.click(this.page.getByRole('button', { name: 'Apply filter' }));
    await expect(this.filterInput).toHaveValue(term);
  }

  async expectUserListed(email: string): Promise<void> {
    await expect(this.rowFor(email), `user ${email} should be listed`).toBeVisible();
  }

  async expectUserNotListed(email: string): Promise<void> {
    await expect(this.rowFor(email)).toHaveCount(0);
  }

  async readRow(email: string): Promise<UserRowData> {
    const cells = this.rowFor(email).getByRole('cell');
    await expect(cells).toHaveCount(5);
    const [name, mail, role, status] = await cells.allInnerTexts();
    return { name: name!.trim(), email: mail!.trim(), role: role!.trim(), status: status!.trim() };
  }

  editButtonFor(fullName: string): Locator {
    return this.page.getByRole('button', { name: `Edit ${fullName}`, exact: true });
  }

  deleteButtonFor(fullName: string): Locator {
    return this.page.getByRole('button', { name: `Delete ${fullName}`, exact: true });
  }

  async editUser(fullName: string, changes: UserEdit): Promise<void> {
    await this.click(this.editButtonFor(fullName));
    await this.editDialog.expectOpen();
    if (changes.firstName !== undefined)
      await this.fill(this.editDialog.field('First name'), changes.firstName);
    if (changes.lastName !== undefined) await this.fill(this.editDialog.field('Last name'), changes.lastName);
    if (changes.role) await this.selectOption(this.editDialog.field('Role'), changes.role);
    if (changes.status) await this.selectOption(this.editDialog.field('Status'), changes.status);
    await this.editDialog.clickButton('Save changes');
  }

  async expectUpdateConfirmed(): Promise<void> {
    await this.editDialog.expectClosed();
    await expect(this.statusMessage).toHaveText('User updated');
  }

  /** Clicks Delete and answers the browser confirm() dialog. Returns the dialog text. */
  async deleteUser(fullName: string, options: { confirm: boolean }): Promise<string> {
    return this.handleDialog(() => this.click(this.deleteButtonFor(fullName)), { accept: options.confirm });
  }

  async exportCsv(): Promise<DownloadResult> {
    return this.download(() => this.click(this.page.getByRole('link', { name: 'Export CSV' })));
  }

  async importCsv(file: UploadFile): Promise<void> {
    await this.upload(this.page.getByLabel('Import users (CSV)'), file);
    await this.click(this.page.getByRole('button', { name: 'Upload' }));
  }
}
