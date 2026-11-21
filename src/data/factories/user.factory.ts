import { faker } from '@faker-js/faker';

import type { UserRole } from '../../api/models/user.model.js';
import { uniqueId } from '../../utils/random.util.js';
import { userDataSchema, type UserData } from '../schemas/test-data.schema.js';

/** Marker embedded in every generated e-mail so leaked test data is easy to find and purge. */
export const TEST_EMAIL_DOMAIN = 'qa-auto.example.com';

const seed = process.env.FAKER_SEED ? Number(process.env.FAKER_SEED) : undefined;
if (seed !== undefined && Number.isFinite(seed)) faker.seed(seed);

const strip = (value: string) => value.replace(/[^A-Za-z]/g, '') || 'Test';

/**
 * Generates realistic, unique, schema-valid users. Uniqueness comes from
 * `uniqueId()` (worker index + time + randomness), so parallel workers and
 * shards never collide even when FAKER_SEED makes names deterministic.
 */
export const UserFactory = {
  build(overrides: Partial<UserData> = {}): UserData {
    const firstName = strip(faker.person.firstName()).slice(0, 30);
    const lastName = strip(faker.person.lastName()).slice(0, 30);
    const id = uniqueId('u');
    const user: UserData = {
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${id}@${TEST_EMAIL_DOMAIN}`.toLowerCase(),
      role: 'viewer',
      ...overrides,
    };
    return userDataSchema.parse(user);
  },

  buildMany(count: number, overrides: Partial<UserData> = {}): UserData[] {
    return Array.from({ length: count }, () => UserFactory.build(overrides));
  },

  withRole(role: UserRole, overrides: Partial<UserData> = {}): UserData {
    return UserFactory.build({ ...overrides, role });
  },

  /** A password that satisfies the demo app policy (upper, digit, symbol, 8+). */
  password(): string {
    return `${faker.string.alpha({ length: 1, casing: 'upper' })}${faker.string.alphanumeric(8)}#${faker.number.int({ min: 10, max: 99 })}`;
  },
};
