import { expect, type Locator, type Page } from '@playwright/test';

import { BasePage } from './base.page.js';

export interface RegistrationForm {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword?: string;
  country?: string;
  acceptTerms?: boolean;
}

/** Self-registration form. APPLICATION-SPECIFIC selectors. */
export class RegistrationPage extends BasePage {
  protected readonly path = '/register';
  readonly errors: Locator;
  readonly termsCheckbox: Locator;

  constructor(page: Page) {
    super(page);
    this.errors = page.getByRole('alert', { name: 'Form errors' }).getByRole('listitem');
    this.termsCheckbox = page.getByRole('checkbox', { name: 'I accept the terms and conditions' });
  }

  override async waitUntilLoaded(): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  }

  async fillForm(form: RegistrationForm): Promise<void> {
    await this.fill(this.page.getByLabel('First name'), form.firstName);
    await this.fill(this.page.getByLabel('Last name'), form.lastName);
    await this.fill(this.page.getByLabel('Email'), form.email);
    await this.fill(this.page.getByLabel('Password', { exact: true }), form.password);
    await this.fill(this.page.getByLabel('Confirm password'), form.confirmPassword ?? form.password);
    if (form.country) await this.selectOption(this.page.getByLabel('Country'), form.country);
    if (form.acceptTerms) await this.check(this.termsCheckbox);
    else await this.uncheck(this.termsCheckbox);
  }

  async submit(): Promise<void> {
    await this.click(this.page.getByRole('button', { name: 'Create account' }));
  }

  async register(form: RegistrationForm): Promise<void> {
    await this.fillForm(form);
    await this.submit();
  }

  async expectSuccess(email: string): Promise<void> {
    await expect(this.page.getByRole('heading', { name: 'Registration successful' })).toBeVisible();
    await expect(this.page.getByTestId('registered-email')).toHaveText(email.toLowerCase());
  }

  async expectErrors(expected: Array<string | RegExp>): Promise<void> {
    for (const message of expected) await expect(this.errors.filter({ hasText: message })).toHaveCount(1);
  }
}
