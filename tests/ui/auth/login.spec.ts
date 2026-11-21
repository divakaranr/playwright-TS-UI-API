import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('Login', { tag: [Tags.ui] }, () => {
  test.beforeEach(async ({ loginPage }) => {
    await loginPage.navigate();
  });

  test(
    'valid user can log in',
    { tag: [Tags.smoke, Tags.critical] },
    async ({ page, loginPage, dashboardPage, credentials }) => {
      await loginPage.login(credentials('admin'));

      await expect(page).toHaveURL(/\/dashboard/);
      await expect(dashboardPage.welcomeMessage).toHaveText('Welcome, Ada Admin');
      await dashboardPage.header.expectSignedInAs('Ada Admin', 'admin');
    },
  );

  test(
    'wrong password is rejected without revealing which field was wrong',
    { tag: [Tags.negative, Tags.regression] },
    async ({ loginPage, credentials }) => {
      const { username } = credentials('admin');

      await loginPage.login({ username, password: 'Wrong#Password1' });

      await loginPage.expectError('Invalid username or password');
      await expect(loginPage.usernameInput, 'username is preserved for correction').toHaveValue(username);
      await expect(loginPage.passwordInput, 'password is never echoed back').toHaveValue('');
    },
  );

  test(
    'empty credentials show a validation message',
    { tag: [Tags.negative, Tags.regression] },
    async ({ loginPage }) => {
      await loginPage.login({ username: '', password: '' });

      await loginPage.expectError('Username and password are required');
    },
  );

  test(
    'protected pages redirect anonymous users to login and back after sign-in',
    { tag: [Tags.regression] },
    async ({ page, loginPage, credentials }) => {
      await page.goto('/users');
      await expect(page).toHaveURL(/\/login\?next=%2Fusers/);

      await loginPage.login(credentials('admin'));

      await expect(page).toHaveURL(/\/users$/);
    },
  );

  test(
    'user can sign out',
    { tag: [Tags.regression] },
    async ({ page, loginPage, dashboardPage, credentials }) => {
      await loginPage.login(credentials('viewer'));
      await dashboardPage.waitUntilLoaded();

      await dashboardPage.header.signOut();

      await expect(page).toHaveURL(/\/login/);
      await page.goto('/dashboard');
      await expect(page, 'session must be invalidated after sign-out').toHaveURL(/\/login/);
    },
  );
});
