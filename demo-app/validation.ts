import { ROLES, STATUSES, type Role, type Status } from './store.js';

export interface FieldError {
  field: string;
  message: string;
}

export interface UserInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: Role;
  status?: Status;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ALLOWED_FIELDS = new Set(['firstName', 'lastName', 'email', 'role', 'status']);
export const NAME_MAX = 50;
export const EMAIL_MAX = 254;

/**
 * Validates a user payload. `mode` controls which fields are mandatory:
 * create/replace require firstName, lastName, email, role; patch requires at least one field.
 */
export function validateUser(
  body: unknown,
  mode: 'create' | 'replace' | 'patch',
): { ok: true; value: UserInput } | { ok: false; errors: FieldError[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, errors: [{ field: '(body)', message: 'Request body must be a JSON object' }] };
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push({ field: key, message: 'Unknown field' });
  }

  const required = mode === 'patch' ? [] : ['firstName', 'lastName', 'email', 'role'];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      errors.push({ field, message: 'Field is required' });
    }
  }

  const value: UserInput = {};
  for (const field of ['firstName', 'lastName'] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') errors.push({ field, message: 'Must be a string' });
    else if (raw.trim().length === 0 || raw.trim().length > NAME_MAX) {
      errors.push({ field, message: `Must be between 1 and ${NAME_MAX} characters` });
    } else value[field] = raw.trim();
  }

  if (input.email !== undefined && input.email !== null && input.email !== '') {
    if (typeof input.email !== 'string' || !EMAIL.test(input.email) || input.email.length > EMAIL_MAX) {
      errors.push({ field: 'email', message: 'Must be a valid e-mail address' });
    } else value.email = input.email.trim().toLowerCase();
  }
  if (input.role !== undefined && input.role !== null && input.role !== '') {
    if (!ROLES.includes(input.role as Role)) {
      errors.push({ field: 'role', message: `Must be one of: ${ROLES.join(', ')}` });
    } else value.role = input.role as Role;
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status as Status)) {
      errors.push({ field: 'status', message: `Must be one of: ${STATUSES.join(', ')}` });
    } else value.status = input.status as Status;
  }
  if (mode === 'patch' && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({ field: '(body)', message: 'At least one updatable field is required' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export const PASSWORD_RULE = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,64}$/;
