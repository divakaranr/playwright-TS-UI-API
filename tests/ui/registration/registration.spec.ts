import { getConfig } from '../../../src/config/index.js';
import { TestDataService } from '../../../src/data/fixtures/test-data.service.js';
import { registrationDataSchema } from '../../../src/data/schemas/test-data.schema.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

// Data-driven cases must be known at collection time, so load them outside the fixtures.
const { weakPasswords } = new TestDataService(getConfig().environment.name).load(
  'registration',
  registrationDataSchema,
);

test.describe('Registration', { tag: [Tags.ui] }, () => {
  test.beforeEach(async ({ registrationPage }) => {
    await registrationPage.navigate();
  });

  test(
    'a visitor can create an account and sign in',
    { tag: [Tags.smoke, Tags.mobile] },
    async ({ page, registrationPage, loginPage, dashboardPage, userService, testData }) => {
      const user = testData.users.build();
      const password = testData.users.password();
      const { countries } = testData.load('registration', registrationDataSchema);

      await registrationPage.register({ ...user, password, country: countries[0], acceptTerms: true });

      await registrationPage.expectSuccess(user.email);
      await userService.trackByEmail(user.email); // created through the UI -> clean up via API

      await page.getByRole('link', { name: 'Sign in' }).click();
      await loginPage.login({ username: user.email, password });
      await expect(dashboardPage.welcomeMessage).toHaveText(`Welcome, ${user.firstName} ${user.lastName}`);
    },
  );

  test(
    'all validation rules are reported together',
    { tag: [Tags.regression, Tags.negative] },
    async ({ registrationPage, testData }) => {
      const user = testData.users.build();

      await registrationPage.register({
        firstName: '',
        lastName: user.lastName,
        email: 'invalid-email',
        password: 'weak',
        confirmPassword: 'different',
        acceptTerms: false,
      });

      await registrationPage.expectErrors([
        'First name: Field is required',
        'Email: Must be a valid e-mail address',
        /^Password: Must be 8-64 characters/,
        'Confirm password: Passwords do not match',
        'Country: Select a country',
        'Terms: You must accept the terms and conditions',
      ]);
    },
  );

  for (const weak of weakPasswords) {
    test(
      `password policy rejects "${weak}"`,
      { tag: [Tags.regression, Tags.negative] },
      async ({ registrationPage, testData }) => {
        const user = testData.users.build();

        await registrationPage.register({ ...user, password: weak, country: 'India', acceptTerms: true });

        await registrationPage.expectErrors([/^Password: Must be 8-64 characters/]);
        await expect(registrationPage.errors).toHaveCount(1);
      },
    );
  }
});
