/**
 * Generates a schema-valid batch of users for exploratory/manual testing or
 * bulk import (CSV + JSON).  npm run data:generate -- [count] [role]
 *
 * Output goes to test-data/generated/ (git-ignored). Generated users carry the
 * qa-auto marker e-mail domain so leaked data is easy to identify and purge.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { roleSchema } from '../src/api/schemas/index.js';
import { UserFactory } from '../src/data/factories/user.factory.js';
import { ensureDir } from '../src/utils/file.util.js';
import { fileTimestamp } from '../src/utils/date.util.js';
import { paths } from '../src/utils/paths.js';

const count = Number(process.argv[2] ?? 10);
if (!Number.isInteger(count) || count < 1 || count > 10_000) {
  console.error('count must be an integer between 1 and 10000');
  process.exit(2);
}
const role = roleSchema.parse(process.argv[3] ?? 'viewer');

const users = UserFactory.buildMany(count, { role });
const dir = ensureDir(path.join(paths.testData, 'generated'));
const stamp = fileTimestamp();
const jsonFile = path.join(dir, `users-${stamp}.json`);
const csvFile = path.join(dir, `users-${stamp}.csv`);

writeFileSync(jsonFile, `${JSON.stringify(users, null, 2)}\n`);
writeFileSync(
  csvFile,
  [
    'firstName,lastName,email,role',
    ...users.map((u) => `${u.firstName},${u.lastName},${u.email},${u.role}`),
  ].join('\n') + '\n',
);

console.log(
  `generated ${count} ${role} users:\n  ${path.relative(paths.root, jsonFile)}\n  ${path.relative(paths.root, csvFile)}`,
);
