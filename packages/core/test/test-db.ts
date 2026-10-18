// Brings the vitest `inject('pgRootUrl')` declaration into every project that uses this helper.
import type {} from './global-setup.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type Database, type Tx } from '../src/db/database.js';
import { formatSchemaProblems, type SchemaExpectation } from '../src/db/checks.js';
import type { MigrationTarget } from '../src/db/migrate.js';
import { moduleRoleName } from '../src/db/module-roles.js';
import { prepareDatabase } from '../src/db/prepare.js';
import { globalTableNames } from '../src/db/registry.js';
import { createScopedDb, type ScopedDb } from '../src/db/scoped.js';
import * as coreSchema from '../src/db/schema.js';
import * as widgetsSchema from './fixtures/widgets/schema.js';

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

/** Expectations for core and the widgets fixture, as a bot would derive them from its schema files. */
export function schemaExpectations(): SchemaExpectation[] {
  return [
    { schema: 'core', globalTables: globalTableNames(coreSchema) },
    { schema: 'widgets', globalTables: globalTableNames(widgetsSchema) },
  ];
}

/** Prepares core and the widgets fixture the way a bot does at startup. */
export async function setUpSchema(database: Database): Promise<void> {
  const problems = await prepareDatabase(database, { modules: [widgetsTarget], expectations: schemaExpectations() });
  if (problems.length > 0) {
    throw new Error(`Test schema has problems:\n${formatSchemaProblems(problems)}`);
  }
}

/** Database access as the widgets fixture module, the way its handlers get it. */
export function widgetsDb(database: Database, guildId: string): ScopedDb {
  return createScopedDb(database.app, guildId, moduleRoleName(database.appRole, 'widgets'));
}

/** Runs `fn` in one transaction as a module's role, without a guild, the way ScopedDb switches roles. */
export function asModuleRole<T>(database: Database, module: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const role = moduleRoleName(database.appRole, module);
  return database.app.transaction(async (tx) => {
    await tx.execute(sql`select set_config('role', ${role}, true)`);
    return fn(tx);
  });
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
