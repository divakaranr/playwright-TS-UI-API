import * as z from 'zod';

/**
 * Response/request contracts for the demo application's API. Schemas are strict
 * so that unexpected fields (contract drift, accidental data exposure such as a
 * leaked `password` field) fail tests loudly.
 *
 * APPLICATION-SPECIFIC: adapt these schemas to your system under test.
 */
export const roleSchema = z.enum(['admin', 'editor', 'viewer']);
export const userStatusSchema = z.enum(['active', 'inactive']);

export const userSchema = z
  .object({
    id: z.string().min(1),
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    email: z.email(),
    role: roleSchema,
    status: userStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const userListSchema = z
  .object({
    data: z.array(userSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
  })
  .strict();

export const createUserRequestSchema = z
  .object({
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    email: z.email(),
    role: roleSchema,
    status: userStatusSchema.optional(),
  })
  .strict();

export const updateUserRequestSchema = createUserRequestSchema.partial();
