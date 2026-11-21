import type { CreateUserRequest, ListUsersQuery, UpdateUserRequest } from '../models/user.model.js';
import type { ApiResponse } from './api-response.js';
import { BaseApiClient, type RequestOptions } from './base-api.client.js';

/**
 * Domain client for the /users resource. Methods return raw ApiResponse objects
 * so tests can assert positive and negative behaviour alike; typed convenience
 * (parse + cleanup registration) lives in UserService.
 *
 * APPLICATION-SPECIFIC: endpoint paths reflect the demo application.
 */
export class UserApiClient extends BaseApiClient {
  listUsers(query: ListUsersQuery = {}, options?: RequestOptions): Promise<ApiResponse> {
    return this.get('/users', { ...options, params: { ...query } });
  }

  getUser(userId: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.get(`/users/${encodeURIComponent(userId)}`, options);
  }

  createUser(
    payload: CreateUserRequest | Record<string, unknown>,
    options: RequestOptions & { idempotencyKey?: string } = {},
  ): Promise<ApiResponse> {
    const { idempotencyKey, ...rest } = options;
    return this.post('/users', payload, {
      ...rest,
      headers: { ...rest.headers, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    });
  }

  replaceUser(
    userId: string,
    payload: CreateUserRequest | Record<string, unknown>,
    options?: RequestOptions,
  ) {
    return this.put(`/users/${encodeURIComponent(userId)}`, payload, options);
  }

  updateUser(userId: string, changes: UpdateUserRequest | Record<string, unknown>, options?: RequestOptions) {
    return this.patch(`/users/${encodeURIComponent(userId)}`, changes, options);
  }

  deleteUser(userId: string, options?: RequestOptions): Promise<ApiResponse> {
    return this.delete(`/users/${encodeURIComponent(userId)}`, options);
  }
}
