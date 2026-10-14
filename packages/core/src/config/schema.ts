import { z } from 'zod';

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL');

// Strict objects turn typos in keys into errors instead of silently ignored settings.
export const coreConfigSchema = z.object({
  discord: z.object({
    token: z.string().min(1),
  }).strict(),
  database: z.object({
    appUrl: postgresUrl,
    adminUrl: postgresUrl,
  }).strict(),
  // Keys are module package names; a key without settings (YAML null) loads the module with its defaults.
  modules: z.record(z.string(), z.unknown().transform((value): unknown => value ?? {})).default({}),
}).strict();

export type CoreConfig = z.infer<typeof coreConfigSchema>;
