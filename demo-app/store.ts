/**
 * In-memory data store for the demo application. State lives for the lifetime of
 * the process; tests must never rely on records they did not create themselves
 * (except the two seeded accounts).
 */
export const ROLES = ['admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const STATUSES = ['active', 'inactive'] as const;
export type Status = (typeof STATUSES)[number];

export interface UserRecord {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: Role;
  status: Status;
  createdAt: string;
  updatedAt: string;
  /** Seeded accounts cannot be deleted. Never serialised. */
  builtIn?: boolean;
  /** Only seeded / registered accounts can sign in. Never serialised. */
  password?: string;
}

export type PublicUser = Omit<UserRecord, 'password' | 'builtIn'>;

export const toPublic = ({ password: _password, builtIn: _builtIn, ...user }: UserRecord): PublicUser => user;

const users = new Map<string, UserRecord>();
let sequence = 0;

const now = () => new Date().toISOString();

export function createUser(input: Omit<UserRecord, 'id' | 'createdAt' | 'updatedAt'>): UserRecord {
  sequence += 1;
  const timestamp = now();
  const user: UserRecord = { ...input, id: String(sequence), createdAt: timestamp, updatedAt: timestamp };
  users.set(user.id, user);
  return user;
}

export function updateUser(
  id: string,
  changes: Partial<Omit<UserRecord, 'id' | 'createdAt'>>,
): UserRecord | undefined {
  const existing = users.get(id);
  if (!existing) return undefined;
  const updated: UserRecord = { ...existing, ...changes, id, updatedAt: now() };
  users.set(id, updated);
  return updated;
}

export const getUser = (id: string): UserRecord | undefined => users.get(id);
export const deleteUser = (id: string): boolean => users.delete(id);
export const findByEmail = (email: string): UserRecord | undefined =>
  [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());

export function listUsers(filter: { search?: string; role?: string } = {}): UserRecord[] {
  const term = filter.search?.trim().toLowerCase();
  return [...users.values()]
    .filter((u) => (filter.role ? u.role === filter.role : true))
    .filter((u) => (term ? `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(term) : true))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export const countUsers = (): number => users.size;

// Seeded accounts (demo credentials – documented in .env.example; not real secrets).
createUser({
  firstName: 'Ada',
  lastName: 'Admin',
  email: 'admin@demo.local',
  role: 'admin',
  status: 'active',
  password: process.env.DEMO_ADMIN_PASSWORD ?? 'Admin#12345',
  builtIn: true,
});
createUser({
  firstName: 'Victor',
  lastName: 'Viewer',
  email: 'viewer@demo.local',
  role: 'viewer',
  status: 'active',
  password: process.env.DEMO_VIEWER_PASSWORD ?? 'Viewer#12345',
  builtIn: true,
});
