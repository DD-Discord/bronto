import { z } from 'zod';

export const stickyConfigSchema = z
  .object({
    /** Name sticky posts show, and of the webhooks the module creates. */
    webhookName: z.string().min(1).max(80).default('Sticky'),
    /** Avatar sticky posts show. */
    webhookAvatar: z.url().optional(),
  })
  .strict();

export type StickyConfig = z.infer<typeof stickyConfigSchema>;
