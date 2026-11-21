import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import * as z from 'zod';

import { UserBuilder } from '../../../src/data/builders/user.builder.js';
import { CleanupRegistry } from '../../../src/data/cleanup.registry.js';
import { TEST_EMAIL_DOMAIN, UserFactory } from '../../../src/data/factories/user.factory.js';
import { TestDataService } from '../../../src/data/fixtures/test-data.service.js';
import { userDataSchema, userValidationDataSchema } from '../../../src/data/schemas/test-data.schema.js';
import { SchemaValidationError, TestDataError } from '../../../src/core/exceptions/index.js';

test.describe('UserFactory & UserBuilder', () => {
  test('builds schema-valid users with unique, tagged e-mails', () => {
    const users = UserFactory.buildMany(200);

    for (const user of users) expect(userDataSchema.safeParse(user).success).toBe(true);
    expect(new Set(users.map((u) => u.email)).size).toBe(200);
    expect(users.every((u) => u.email.endsWith(`@${TEST_EMAIL_DOMAIN}`))).toBe(true);
  });

  test('applies overrides and validates them', () => {
    expect(UserFactory.withRole('admin').role).toBe('admin');
    expect(() => UserFactory.build({ email: 'broken' })).toThrow();
  });

  test('generates passwords that satisfy the demo policy', () => {
    for (let i = 0; i < 50; i++)
      expect(UserFactory.password()).toMatch(/^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,64}$/);
  });

  test('builder supports valid and deliberately invalid data', () => {
    const user = new UserBuilder().named('Grace', 'Hopper').withRole('editor').build();
    expect(user).toMatchObject({ firstName: 'Grace', lastName: 'Hopper', role: 'editor' });

    const invalid = new UserBuilder().buildUnchecked((d) => delete d.email);
    expect(invalid).not.toHaveProperty('email');
  });
});

test.describe('TestDataService', () => {
  const schema = z.object({ value: z.string() }).strict();

  function fixtureDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'data-'));
    mkdirSync(path.join(dir, 'common'));
    mkdirSync(path.join(dir, 'qa'));
    writeFileSync(path.join(dir, 'common', 'sample.json'), JSON.stringify({ value: 'common' }));
    writeFileSync(path.join(dir, 'qa', 'sample.json'), JSON.stringify({ value: 'qa' }));
    writeFileSync(path.join(dir, 'common', 'bad.json'), JSON.stringify({ value: 1 }));
    return dir;
  }

  test('prefers environment-specific data and falls back to common', () => {
    const dir = fixtureDir();
    expect(new TestDataService('qa', dir).load('sample', schema).value).toBe('qa');
    expect(new TestDataService('uat', dir).load('sample', schema).value).toBe('common');
  });

  test('validates data and rejects unknown or unsafe names', () => {
    const dir = fixtureDir();
    expect(() => new TestDataService('qa', dir).load('bad', schema)).toThrow(SchemaValidationError);
    expect(() => new TestDataService('qa', dir).load('missing', schema)).toThrow(TestDataError);
    expect(() => new TestDataService('qa', dir).load('../secrets', schema)).toThrow(/Invalid test data name/);
  });

  test('repository test data files are valid', () => {
    expect(
      new TestDataService('local').load('user-validation', userValidationDataSchema).invalidPayloads.length,
    ).toBeGreaterThan(0);
  });
});

test.describe('CleanupRegistry', () => {
  test('runs every task in LIFO order and aggregates failures', async () => {
    const order: string[] = [];
    const registry = new CleanupRegistry();
    registry.register('first', async () => void order.push('first'));
    registry.register('failing', async () => {
      order.push('failing');
      throw new Error('boom');
    });
    registry.register('last', async () => void order.push('last'));

    await expect(registry.runAll()).rejects.toThrow(/failing: boom/);
    expect(order).toEqual(['last', 'failing', 'first']);
    expect(registry.pending).toBe(0);
  });
});
