import { readFile } from 'node:fs/promises';

import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('User management', { tag: [Tags.ui] }, () => {
  test.describe('as admin', () => {
    test.use({ role: 'admin' });

    test(
      'filter finds a user created through the API',
      { tag: [Tags.smoke, Tags.critical] },
      async ({ userService, testData, userManagementPage }) => {
        const user = await userService.create(testData.users.build());

        await userManagementPage.navigate();
        await userManagementPage.filter(user.email);

        await userManagementPage.expectUserListed(user.email);
        expect(await userManagementPage.readRow(user.email)).toEqual({
          name: `${user.firstName} ${user.lastName}`,
          email: user.email,
          role: user.role,
          status: 'active',
        });
      },
    );

    test(
      'cancelling the delete confirmation keeps the user',
      { tag: [Tags.regression, Tags.negative] },
      async ({ userService, testData, userManagementPage }) => {
        const user = await userService.create(testData.users.build());
        await userManagementPage.navigate({ q: user.email });

        const message = await userManagementPage.deleteUser(`${user.firstName} ${user.lastName}`, {
          confirm: false,
        });

        expect(message).toBe(`Delete ${user.firstName} ${user.lastName}?`);
        await expect(userManagementPage.statusMessage).toHaveText('Deletion cancelled');
        await userManagementPage.expectUserListed(user.email);
      },
    );

    test(
      'confirming deletion removes the user',
      { tag: [Tags.regression, Tags.destructive] },
      async ({ userService, userApi, testData, userManagementPage }) => {
        const user = await userService.create(testData.users.build());
        await userManagementPage.navigate({ q: user.email });

        await userManagementPage.deleteUser(`${user.firstName} ${user.lastName}`, { confirm: true });

        await expect(userManagementPage.statusMessage).toHaveText('User deleted');
        await userManagementPage.expectUserNotListed(user.email);
        await expect(await userApi.getUser(user.id)).toHaveStatus(404);
      },
    );

    test(
      'users can be exported as CSV',
      { tag: [Tags.regression] },
      async ({ userService, testData, userManagementPage }) => {
        const user = await userService.create(testData.users.build());
        await userManagementPage.navigate();

        const download = await userManagementPage.exportCsv();

        expect(download.suggestedFilename).toBe('users.csv');
        const csv = await readFile(download.savedPath, 'utf8');
        expect(csv.split('\n')[0]).toBe('id,firstName,lastName,email,role,status');
        expect(csv).toContain(user.email);
      },
    );

    test(
      'users can be imported from a CSV upload',
      { tag: [Tags.regression] },
      async ({ userService, testData, userManagementPage }) => {
        const [first, second] = testData.users.buildMany(2);
        const csv = [
          'firstName,lastName,email,role',
          ...[first!, second!].map((u) => `${u.firstName},${u.lastName},${u.email},${u.role}`),
        ].join('\n');
        await userManagementPage.navigate();

        await userManagementPage.importCsv({
          name: 'users.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(csv),
        });

        await expect(userManagementPage.statusMessage).toHaveText('Imported 2 users');
        for (const user of [first!, second!]) {
          expect(
            await userService.trackByEmail(user.email),
            `${user.email} should exist after import`,
          ).toBeDefined();
        }
      },
    );
  });

  test.describe('as viewer', () => {
    test.use({ role: 'viewer' });

    test(
      'read-only role cannot edit, delete or import',
      { tag: [Tags.regression, Tags.negative] },
      async ({ page, userManagementPage }) => {
        await userManagementPage.navigate({ q: 'admin@demo.local' });

        await userManagementPage.expectUserListed('admin@demo.local');
        await expect(page.getByRole('button', { name: /^(Edit|Delete) / })).toHaveCount(0);
        await expect(page.getByLabel('Import users (CSV)')).toHaveCount(0);
      },
    );
  });
});
