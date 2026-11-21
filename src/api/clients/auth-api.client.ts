import type { ApiResponse } from './api-response.js';
import { BaseApiClient } from './base-api.client.js';

/**
 * Raw authentication endpoints. Used by AuthService for token acquisition and
 * directly by negative authentication tests. Paths come from the environment
 * configuration (`auth.*Path`) so they can differ per application.
 */
export class AuthApiClient extends BaseApiClient {
  login(username: string, password: string): Promise<ApiResponse> {
    return this.post(this.options.config.environment.auth.loginPath, { username, password });
  }

  refresh(refreshToken: string): Promise<ApiResponse> {
    return this.post(this.options.config.environment.auth.refreshPath, { refreshToken });
  }

  clientCredentials(clientId: string, clientSecret: string, scope?: string): Promise<ApiResponse> {
    return this.post(this.options.config.environment.auth.tokenPath, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    });
  }
}
