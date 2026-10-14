import type { Database } from './database.js';
import { assertModuleName, quoteIdent } from './names.js';

/** Gives the app role data access, but no DDL, to each schema, including tables created later. */
export async function grantAppRole(database: Database, schemas: string[]): Promise<void> {
  const role = quoteIdent(database.appRole);
  for (const schema of schemas) {
    assertModuleName(schema);
    const target = quoteIdent(schema);
    await database.adminPool.query(`
      grant usage on schema ${target} to ${role};
      grant select, insert, update, delete on all tables in schema ${target} to ${role};
      grant usage, select on all sequences in schema ${target} to ${role};
      alter default privileges in schema ${target} grant select, insert, update, delete on tables to ${role};
      alter default privileges in schema ${target} grant usage, select on sequences to ${role};
    `);
  }
}
