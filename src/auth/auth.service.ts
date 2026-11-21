import { getCredentials, type FrameworkConfig } from '../config/index.js';
import { AuthenticationError, ConfigurationError } from '../core/exceptions/index.js';
import { BasicAuthProvider, BearerTokenProvider, type AuthProvider } from '../api/auth/auth-provider.js';
import type { AuthApiClient } from '../api/clients/auth-api.client.js';
import type { ApiResponse } from '../api/clients/api-response.js';
import { oauthTokenResponseSchema, tokenResponseSchema } from '../api/schemas/index.js';
import type { TokenFetcher, TokenManager, TokenSet } from './token.manager.js';

/**
 * High-level authentication facade. Produces AuthProviders for API clients:
 *
 * - `bearerFor(role)`      password grant + refresh-token rotation (per role)
 * - `clientCredentials()`  OAuth2 client-credentials grant (service-to-service)
 * - `basicFor(role)`       HTTP Basic (for APIs that support it)
 *
 * APPLICATION-SPECIFIC: token response parsing reflects the demo app; adapt
 * `toTokenSet` / schemas to your identity provider.
 */
export class AuthService {
  constructor(
    private readonly config: FrameworkConfig,
    private readonly authApi: AuthApiClient,
    private readonly tokens: TokenManager,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  bearerFor(role: string): AuthProvider {
    const credentials = getCredentials(this.config, role, this.env);
    const fetcher: TokenFetcher = {
      acquire: async () =>
        this.toTokenSet(
          await this.authApi.login(credentials.username, credentials.password),
          `role "${role}"`,
        ),
      refresh: async (refreshToken) =>
        this.toTokenSet(await this.authApi.refresh(refreshToken), `refresh for "${role}"`),
    };
    return new BearerTokenProvider(
      () => this.tokens.getAccessToken(`password:${role}`, fetcher),
      `bearer(${role})`,
    );
  }

  clientCredentials(scope?: string): AuthProvider {
    const { clientId, clientSecret } = this.config.apiClient;
    if (!clientId || !clientSecret) {
      throw new ConfigurationError('OAuth2 client credentials require API_CLIENT_ID and API_CLIENT_SECRET');
    }
    const fetcher: TokenFetcher = {
      acquire: async () => {
        const response = await this.authApi.clientCredentials(clientId, clientSecret, scope);
        await this.ensureOk(response, 'client credentials grant');
        const body = await response.parse(oauthTokenResponseSchema);
        return { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      },
    };
    return new BearerTokenProvider(
      () => this.tokens.getAccessToken(`client:${clientId}:${scope ?? ''}`, fetcher),
      'oauth2-client-credentials',
    );
  }

  basicFor(role: string): AuthProvider {
    return new BasicAuthProvider(getCredentials(this.config, role, this.env));
  }

  private async toTokenSet(response: ApiResponse, subject: string): Promise<TokenSet> {
    await this.ensureOk(response, subject);
    const body = await response.parse(tokenResponseSchema);
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    };
  }

  private async ensureOk(response: ApiResponse, subject: string): Promise<void> {
    if (response.ok()) return;
    // Response body is not included: it may echo credentials on some systems.
    await response.raw.dispose().catch(() => undefined);
    throw new AuthenticationError(`Authentication failed for ${subject}: HTTP ${response.status()}`, {
      details: { status: response.status(), correlationId: response.correlationId },
    });
  }
}
