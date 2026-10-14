import type { Database, Queryable } from './database.js';
import { assertModuleName, quoteIdent } from './names.js';

/**
 * Gives the app role data access, but no DDL, to the tables that exist in each schema now; run it after every
 * migration. Tables with RLS get read and write access. Tables without RLS (global tables such as core.guilds) are
 * read-only, since writes there are not limited to one guild.
 */
export async function grantAppRole(database: Database, schemas: string[]): Promise<void> {
  await grantAppRoleWith(database.adminPool, database.appRole, schemas);
}

export async function grantAppRoleWith(admin: Queryable, appRole: string, schemas: string[]): Promise<void> {
  const role = quoteIdent(appRole);
  for (const schema of schemas) {
    assertModuleName(schema);
    const target = quoteIdent(schema);
    const { rows } = await admin.query<{ name: string; rls: boolean }>(
      `select c.relname as "name", c.relrowsecurity as "rls"
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
        order by c.relname`,
      [schema],
    );
    const statements = [`grant usage on schema ${target} to ${role}`];
    for (const { name, rls } of rows) {
      const table = `${target}.${quoteIdent(name)}`;
      // Revoking first keeps the grants exact when a table's RLS setting changes between starts.
      statements.push(`revoke all on ${table} from ${role}`);
      statements.push(`grant ${rls ? 'select, insert, update, delete' : 'select'} on ${table} to ${role}`);
    }
    statements.push(`grant usage, select on all sequences in schema ${target} to ${role}`);
    // One simple-protocol query runs as one transaction, so the role never sees a table without its grants.
    await admin.query(statements.join(';\n'));
  }
}
