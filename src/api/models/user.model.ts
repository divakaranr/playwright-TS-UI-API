import type * as z from 'zod';

import type {
  apiErrorSchema,
  createUserRequestSchema,
  roleSchema,
  updateUserRequestSchema,
  userListSchema,
  userSchema,
} from '../schemas/index.js';

/** Types are derived from schemas so contracts and types can never drift apart. */
export type User = z.infer<typeof userSchema>;
export type UserList = z.infer<typeof userListSchema>;
export type UserRole = z.infer<typeof roleSchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export interface ListUsersQuery {
  search?: string;
  role?: UserRole;
  page?: number;
  pageSize?: number;
}
