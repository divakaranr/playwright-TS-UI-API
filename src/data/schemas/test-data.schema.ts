import * as z from 'zod';

import { roleSchema } from '../../api/schemas/index.js';

/** A user as produced by factories (no server-generated fields). */
export const userDataSchema = z
  .object({
    firstName: z.string().min(1).max(50),
    lastName: z.string().min(1).max(50),
    email: z.email(),
    role: roleSchema,
  })
  .strict();
export type UserData = z.infer<typeof userDataSchema>;

/** Data-driven negative scenarios stored in test-data/<env|common>/user-validation.json */
export const userValidationDataSchema = z
  .object({
    invalidPayloads: z
      .array(
        z
          .object({
            name: z.string().min(1),
            payload: z.record(z.string(), z.unknown()),
            expectedStatus: z.number().int().min(400).max(499),
            expectedFields: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1),
    boundaries: z
      .object({
        nameMaxLength: z.number().int().positive(),
        pageSizeMax: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type UserValidationData = z.infer<typeof userValidationDataSchema>;

/** Registration form data used by UI tests. */
export const registrationDataSchema = z
  .object({
    countries: z.array(z.string().min(1)).min(1),
    weakPasswords: z.array(z.string()).min(1),
  })
  .strict();
export type RegistrationData = z.infer<typeof registrationDataSchema>;
