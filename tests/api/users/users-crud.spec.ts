import { randomUUID } from 'node:crypto';

import { userListSchema, userSchema } from '../../../src/api/schemas/index.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('Users API – CRUD', { tag: [Tags.api] }, () => {
  test(
    'should retrieve a user',
    { tag: [Tags.smoke, Tags.critical] },
    async ({ userApi, userService, testData }) => {
      const created = await userService.create(testData.users.build());

      const response = await userApi.getUser(created.id);

      await expect(response).toHaveStatus(200);
      await expect(response).toMatchSchema(userSchema);
      const body = await response.parse(userSchema);
      expect(body).toMatchObject({ id: created.id, email: created.email, firstName: created.firstName });
    },
  );

  test(
    'lists users with pagination and search',
    { tag: [Tags.regression] },
    async ({ userApi, userService, testData }) => {
      const created = await userService.create(testData.users.build());

      const response = await userApi.listUsers({ search: created.email, page: 1, pageSize: 10 });

      await expect(response).toHaveStatus(200);
      const list = await response.parse(userListSchema);
      expect(list).toMatchObject({ page: 1, pageSize: 10, total: 1 });
      expect(list.data.map((u) => u.id)).toEqual([created.id]);
    },
  );

  test(
    'creates a user (POST)',
    { tag: [Tags.smoke, Tags.critical] },
    async ({ userApi, userService, testData }) => {
      const payload = testData.users.withRole('editor');

      const response = await userApi.createUser(payload);

      await expect(response).toHaveStatus(201);
      const user = await response.parse(userSchema);
      userService.trackForCleanup(user.id, user.email);
      expect(user).toMatchObject({ ...payload, status: 'active' });
      await expect(response).toHaveHeader('location', `/api/users/${user.id}`);
      // Side effect: the resource is retrievable.
      await expect(await userApi.getUser(user.id)).toHaveStatus(200);
    },
  );

  test('replaces a user (PUT)', { tag: [Tags.regression] }, async ({ userApi, userService, testData }) => {
    const user = await userService.create(testData.users.build());
    const replacement = testData.users.withRole('admin');

    const response = await userApi.replaceUser(user.id, replacement);

    await expect(response).toHaveStatus(200);
    const updated = await response.parse(userSchema);
    expect(updated).toMatchObject({ ...replacement, id: user.id, createdAt: user.createdAt });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(user.updatedAt));
  });

  test(
    'partially updates a user (PATCH) without touching other fields',
    { tag: [Tags.regression] },
    async ({ userApi, userService, testData }) => {
      const user = await userService.create(testData.users.build());

      const response = await userApi.updateUser(user.id, { status: 'inactive' });

      await expect(response).toHaveStatus(200);
      const updated = await response.parse(userSchema);
      expect(updated).toEqual({ ...user, status: 'inactive', updatedAt: updated.updatedAt });
    },
  );

  test(
    'deletes a user (DELETE) and it is gone',
    { tag: [Tags.regression, Tags.destructive] },
    async ({ userApi, userService, testData }) => {
      const user = await userService.create(testData.users.build());

      const response = await userApi.deleteUser(user.id);

      await expect(response).toHaveStatus(204);
      expect(await response.text()).toBe('');
      await expect(await userApi.getUser(user.id)).toHaveStatus(404);
    },
  );

  test(
    'returns standard security and diagnostic headers',
    { tag: [Tags.regression] },
    async ({ userApi }) => {
      const correlationId = randomUUID();

      const response = await userApi.listUsers({ pageSize: 1 }, { correlationId });

      await expect(response).toHaveStatus(200);
      await expect(response).toHaveHeader('content-type', /^application\/json/);
      await expect(response).toHaveHeader('cache-control', 'no-store');
      await expect(response).toHaveHeader('x-content-type-options', 'nosniff');
      await expect(response, 'correlation id must be echoed for traceability').toHaveHeader(
        'x-correlation-id',
        correlationId,
      );
      await expect(response).toHaveHeader('x-request-id', /^[0-9a-f-]{36}$/);
    },
  );

  test(
    'responds within the configured threshold',
    { tag: [Tags.regression] },
    async ({ userApi, config }) => {
      const response = await userApi.listUsers({ pageSize: 20 });

      await expect(response).toHaveStatus(200);
      await expect(response).toRespondWithin(config.environment.api.responseTimeThresholdMs);
    },
  );

  test.describe('idempotency', () => {
    test(
      'POST with the same Idempotency-Key does not create duplicates',
      { tag: [Tags.regression] },
      async ({ userApi, userService, testData }) => {
        const payload = testData.users.build();
        const idempotencyKey = randomUUID();

        const first = await userApi.createUser(payload, { idempotencyKey });
        await expect(first).toHaveStatus(201);
        const created = await first.parse(userSchema);
        userService.trackForCleanup(created.id, created.email);

        const replay = await userApi.createUser(payload, { idempotencyKey });

        await expect(replay).toHaveStatus(201);
        await expect(replay).toHaveHeader('idempotent-replayed', 'true');
        expect((await replay.parse(userSchema)).id).toBe(created.id);
        const list = await (await userApi.listUsers({ search: payload.email })).parse(userListSchema);
        expect(list.total, 'exactly one user must exist').toBe(1);
      },
    );

    test(
      'reusing an Idempotency-Key with a different payload is rejected',
      { tag: [Tags.regression, Tags.negative] },
      async ({ userApi, userService, testData }) => {
        const idempotencyKey = randomUUID();
        const first = await userApi.createUser(testData.users.build(), { idempotencyKey });
        await expect(first).toHaveStatus(201);
        const created = await first.parse(userSchema);
        userService.trackForCleanup(created.id, created.email);

        const conflicting = await userApi.createUser(testData.users.build(), { idempotencyKey });

        await expect(conflicting).toHaveStatus(422);
      },
    );

    test(
      'PUT is idempotent and a repeated DELETE returns 404',
      { tag: [Tags.regression] },
      async ({ userApi, userService, testData }) => {
        const user = await userService.create(testData.users.build());
        const replacement = testData.users.build();

        const firstPut = await (await userApi.replaceUser(user.id, replacement)).parse(userSchema);
        const secondPut = await (await userApi.replaceUser(user.id, replacement)).parse(userSchema);
        expect({ ...secondPut, updatedAt: '' }).toEqual({ ...firstPut, updatedAt: '' });

        await expect(await userApi.deleteUser(user.id)).toHaveStatus(204);
        await expect(await userApi.deleteUser(user.id)).toHaveStatus(404);
      },
    );
  });
});
