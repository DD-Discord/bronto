import { z } from 'zod';

export const autodeleteConfigSchema = z
  .object({
    /** Name of the report webhooks the module creates. */
    webhookName: z.string().min(1).max(80).default('Auto-delete'),
  })
  .strict();

export type AutodeleteConfig = z.infer<typeof autodeleteConfigSchema>;
