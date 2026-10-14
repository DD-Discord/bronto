import { defineConfig } from 'drizzle-kit';
import { MIGRATIONS_SCHEMA } from './constants.js';

export interface ModuleDrizzleConfigOptions {
  /** Module name; also its Postgres schema and migration history table. */
  name: string;
  /** Path to the table definitions, relative to the directory drizzle-kit runs in. */
  schema?: string;
  /** Migrations output folder, relative to the directory drizzle-kit runs in. */
  out?: string;
}

/** drizzle-kit config for one module. Generating needs no database; DATABASE_URL is only used by tools like studio. */
export function defineModuleDrizzleConfig({
  name,
  schema = './src/db/schema.ts',
  out = './drizzle',
}: ModuleDrizzleConfigOptions) {
  const base = {
    dialect: 'postgresql' as const,
    schema,
    out,
    schemaFilter: [name],
    migrations: { schema: MIGRATIONS_SCHEMA, table: name },
  };
  const url = process.env.DATABASE_URL;
  return url ? defineConfig({ ...base, dbCredentials: { url } }) : defineConfig(base);
}
