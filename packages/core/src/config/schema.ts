import { z } from 'zod';

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'must be a postgres:// URL');

export const coreConfigSchema = z.object({
  discord: z.object({
    token: z.string().min(1),
  }),
  database: z.object({
    appUrl: postgresUrl,
    adminUrl: postgresUrl,
  }),
  // Keys are module package names; a key without settings (YAML null) loads the module with its defaults.
  modules: z.record(z.string(), z.unknown().transform((value): unknown => value ?? {})).default({}),
});

export type CoreConfig = z.infer<typeof coreConfigSchema>;
