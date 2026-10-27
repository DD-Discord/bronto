import { z } from 'zod';

export const mediaonlyConfigSchema = z
  .object({
    /** Name of the report webhooks the module creates. */
    webhookName: z.string().min(1).max(80).default('Media only'),
  })
  .strict();

export type MediaonlyConfig = z.infer<typeof mediaonlyConfigSchema>;
