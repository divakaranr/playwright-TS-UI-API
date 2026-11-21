import { LoginPage } from '../../src/ui/index.js';
import { test, expect } from './framework.fixture.js';

/**
 * Setup project: logs in through the real UI once per role and stores the
 * browser session (storage state) under .auth/<env>/<role>.json. Browser
 * projects depend on this project, and tests opt into a session with
 * `test.use({ role: 'admin' })`. Each test still gets its own isolated context.
 *
 * STORAGE_STATE_MAX_AGE_MIN > 0 reuses recent state files across local runs.
 */
const maxAgeMs = Number(process.env.STORAGE_STATE_MAX_AGE_MIN ?? 0) * 60_000;

test.describe('authentication setup', () => {
  test('store authenticated sessions for all configured roles', async ({
    config,
    storageStates,
    browser,
    credentials,
  }) => {
    for (const role of config.environment.roles) {
      await test.step(`authenticate as ${role}`, async () => {
        if (storageStates.isFresh(role, maxAgeMs)) return;
        const context = await browser.newContext({ baseURL: config.environment.baseUrl });
        try {
          const page = await context.newPage();
          const loginPage = new LoginPage(page);
          await loginPage.navigate();
          await loginPage.login(credentials(role));
          await loginPage.verifyLoginSuccess();
          await expect(page.getByTestId('current-role')).toHaveText(role);
          await storageStates.save(context, role);
        } finally {
          await context.close();
        }
      });
    }
  });
});
