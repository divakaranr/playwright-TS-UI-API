import { StaticTokenProvider } from '../../../src/api/auth/auth-provider.js';
import {
  apiErrorSchema,
  oauthTokenResponseSchema,
  tokenResponseSchema,
  userListSchema,
} from '../../../src/api/schemas/index.js';
import { test, expect, Tags } from '../../fixtures/framework.fixture.js';

test.describe('Authentication', { tag: [Tags.api] }, () => {
  test(
    'password grant returns a valid token pair',
    { tag: [Tags.smoke, Tags.critical] },
    async ({ authApi, credentials }) => {
      const { username, password } = credentials('admin');

      const response = await authApi.login(username, password);

      await expect(response).toHaveStatus(200);
      await expect(response).toMatchSchema(tokenResponseSchema);
    },
  );

  test(
    'wrong password is rejected',
    { tag: [Tags.negative, Tags.regression] },
    async ({ authApi, credentials }) => {
      const response = await authApi.login(credentials('admin').username, 'Not-The-Password1!');

      await expect(response).toHaveStatus(401);
      expect((await response.parse(apiErrorSchema)).error.code).toBe('INVALID_CREDENTIALS');
    },
  );

  test(
    'requests without credentials are rejected with a challenge',
    { tag: [Tags.negative, Tags.regression] },
    async ({ apiClient }) => {
      const response = await apiClient.get('/users');

      await expect(response).toHaveStatus(401);
      await expect(response).toHaveHeader('www-authenticate', /^Bearer/);
    },
  );

  test(
    'an invalid bearer token is rejected',
    { tag: [Tags.negative, Tags.regression] },
    async ({ apiClient }) => {
      const response = await apiClient.get('/users', {
        auth: new StaticTokenProvider('forged-token-value-123456'),
      });

      await expect(response).toHaveStatus(401);
    },
  );

  test(
    'refresh tokens rotate and cannot be reused',
    { tag: [Tags.regression] },
    async ({ authApi, credentials }) => {
      const { username, password } = credentials('admin');
      const initial = await (await authApi.login(username, password)).parse(tokenResponseSchema);

      const refreshed = await authApi.refresh(initial.refreshToken);
      await expect(refreshed).toHaveStatus(200);
      const rotated = await refreshed.parse(tokenResponseSchema);
      expect(rotated.accessToken).not.toBe(initial.accessToken);
      expect(rotated.refreshToken).not.toBe(initial.refreshToken);

      await expect(
        await authApi.refresh(initial.refreshToken),
        'used refresh token must be rejected',
      ).toHaveStatus(401);
    },
  );

  test(
    'OAuth2 client credentials grant authorises API access',
    { tag: [Tags.regression] },
    async ({ authApi, apiClient, authService, config }) => {
      const tokenResponse = await authApi.clientCredentials(
        config.apiClient.clientId!,
        config.apiClient.clientSecret!,
      );
      await expect(tokenResponse).toHaveStatus(200);
      await expect(tokenResponse).toMatchSchema(oauthTokenResponseSchema);

      const response = await apiClient
        .withAuth(authService.clientCredentials())
        .get('/users', { params: { pageSize: 1 } });

      await expect(response).toHaveStatus(200);
      await expect(response).toMatchSchema(userListSchema);
    },
  );

  test(
    'OAuth2 rejects an invalid client secret',
    { tag: [Tags.negative, Tags.regression] },
    async ({ authApi, config }) => {
      const response = await authApi.clientCredentials(config.apiClient.clientId!, 'wrong-secret');

      await expect(response).toHaveStatus(401);
      expect(await response.json()).toEqual({ error: 'invalid_client' });
    },
  );

  test(
    'HTTP Basic authentication is supported',
    { tag: [Tags.regression] },
    async ({ apiClient, authService }) => {
      const response = await apiClient
        .withAuth(authService.basicFor('viewer'))
        .get('/users', { params: { pageSize: 1 } });

      await expect(response).toHaveStatus(200);
    },
  );
});
