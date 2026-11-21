import type { CleanupRegistry } from '../../data/cleanup.registry.js';
import type { UserData } from '../../data/schemas/test-data.schema.js';
import { ApiRequestError } from '../../core/exceptions/index.js';
import type { UserApiClient } from '../clients/user-api.client.js';
import type { User } from '../models/user.model.js';
import { userListSchema, userSchema } from '../schemas/index.js';

/**
 * Business-level user operations used for test *setup and verification*
 * (e.g. hybrid tests). Every created user is registered for cleanup immediately,
 * so data is removed even when the test fails.
 */
export class UserService {
  constructor(
    private readonly api: UserApiClient,
    private readonly cleanup: CleanupRegistry,
  ) {}

  /** Creates a user via API, validates the response and schedules deletion. */
  async create(data: UserData): Promise<User> {
    const response = await this.api.createUser(data);
    if (response.status() !== 201) {
      throw new ApiRequestError(`Test setup failed: ${response.describe()} – ${await response.text()}`);
    }
    const user = await response.parse(userSchema);
    this.trackForCleanup(user.id, user.email);
    return user;
  }

  /** Registers deletion of a user created by other means (e.g. through the UI). */
  trackForCleanup(userId: string, label = userId): void {
    this.cleanup.register(`delete user ${label}`, async () => {
      const response = await this.api.deleteUser(userId);
      // 404 is fine: the test itself may have deleted the user.
      if (![204, 404].includes(response.status())) {
        throw new ApiRequestError(`Cleanup ${response.describe()}`);
      }
    });
  }

  /** Finds users created through the UI by e-mail and schedules their deletion. */
  async trackByEmail(email: string): Promise<User | undefined> {
    const user = await this.findByEmail(email);
    if (user) this.trackForCleanup(user.id, user.email);
    return user;
  }

  async get(userId: string): Promise<User> {
    const response = await this.api.getUser(userId);
    if (!response.ok()) throw new ApiRequestError(`Lookup failed: ${response.describe()}`);
    return response.parse(userSchema);
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const response = await this.api.listUsers({ search: email, pageSize: 100 });
    if (!response.ok()) throw new ApiRequestError(`Search failed: ${response.describe()}`);
    const list = await response.parse(userListSchema);
    return list.data.find((u) => u.email.toLowerCase() === email.toLowerCase());
  }
}
