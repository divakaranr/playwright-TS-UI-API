import * as z from 'zod';

export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.array(z.object({ field: z.string(), message: z.string() }).strict()).optional(),
      })
      .strict(),
  })
  .strict();

export const healthSchema = z
  .object({
    status: z.literal('ok'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    uptimeSeconds: z.number().int().min(0),
  })
  .strict();

/** Password-grant token response (framework-internal auth API of the demo app). */
export const tokenResponseSchema = z
  .object({
    accessToken: z.string().min(16),
    refreshToken: z.string().min(16),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().positive(),
  })
  .strict();

/** RFC 6749 client-credentials token response. */
export const oauthTokenResponseSchema = z.object({
  access_token: z.string().min(16),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});
