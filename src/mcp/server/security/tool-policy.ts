import { loadConfig, type EnvironmentName, type FrameworkConfig } from '../../../config/index.js';
import { EnvironmentPolicyError } from '../../../core/exceptions/index.js';

/**
 * Governance for MCP tools:
 *  - tool allowlist (MCP_ENABLED_TOOLS; empty = all built-in tools)
 *  - environment allowlist (MCP_ALLOWED_ENVIRONMENTS; prod is rejected at config load)
 * Disabled tools are not registered at all, so clients cannot even discover them.
 */
export class ToolPolicy {
  private readonly configs = new Map<EnvironmentName, FrameworkConfig>();

  constructor(
    readonly config: FrameworkConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.configs.set(config.environment.name, config);
  }

  isToolEnabled(name: string): boolean {
    const enabled = this.config.mcp.enabledTools;
    return enabled.length === 0 || enabled.includes(name);
  }

  assertEnvironmentAllowed(environment: EnvironmentName): void {
    if (!this.config.mcp.allowedEnvironments.includes(environment)) {
      throw new EnvironmentPolicyError(
        `Environment "${environment}" is not permitted for MCP tools (allowed: ${this.config.mcp.allowedEnvironments.join(', ')})`,
      );
    }
  }

  /** Validated configuration for another (allowed) environment. */
  configFor(environment: EnvironmentName | undefined): FrameworkConfig {
    const target = environment ?? this.config.environment.name;
    this.assertEnvironmentAllowed(target);
    let config = this.configs.get(target);
    if (!config) {
      // BASE_URL/API_BASE_URL overrides belong to the server's own environment only.
      const { BASE_URL: _b, API_BASE_URL: _a, ...rest } = this.env;
      config = loadConfig({ env: { ...rest, TEST_ENV: target } });
      this.configs.set(target, config);
    }
    return config;
  }
}
