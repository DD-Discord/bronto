import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';
import { createDatabase, type Database } from '../src/db/database.js';
import { grantAppRole } from '../src/db/grants.js';
import { coreMigrationTarget, migrateAll, type MigrationTarget } from '../src/db/migrate.js';

export interface TestDatabase {
  database: Database;
  adminUrl: string;
  appUrl: string;
  drop(): Promise<void>;
}

export const widgetsTarget: MigrationTarget = {
  name: 'widgets',
  folder: fileURLToPath(new URL('./fixtures/widgets/drizzle', import.meta.url)),
};

/** Creates an empty database on the shared container; each test file gets its own. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const rootUrl = inject('pgRootUrl');
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  await withClient(rootUrl, (client) => client.query(`create database ${name}`));
  const adminUrl = withPath(rootUrl, name);
  const appUrl = withCredentials(adminUrl, 'bot_app', 'bot_app');
  const database = createDatabase({ adminUrl, appUrl });
  return {
    database,
    adminUrl,
    appUrl,
    async drop() {
      await database.end();
      await withClient(rootUrl, (client) => client.query(`drop database ${name} with (force)`));
    },
  };
}

/** Migrates core and the widgets fixture, then grants the app role. */
export async function setUpSchema(database: Database): Promise<void> {
  await migrateAll(database, [coreMigrationTarget, widgetsTarget]);
  await grantAppRole(database, ['core', 'widgets']);
}

/** Message of an error and its cause; drizzle wraps driver errors. */
export function errorText(error: unknown): string {
  const { message, cause } = error as { message?: string; cause?: { message?: string } };
  return `${message ?? ''} ${cause?.message ?? ''}`;
}

async function withClient(url: string, fn: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

function withPath(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}
