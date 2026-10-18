import type { Database, Queryable } from './database.js';
import { moduleRoleName } from './module-roles.js';
import { assertModuleName, quoteIdent } from './names.js';

const CORE = 'core';

/**
 * Gives data access, but no DDL, to the tables that exist in each schema now; run it after every migration. `core`
 * goes to the app role; each module schema goes to that module's role only, and the app role loses all access to it.
 * Tables with RLS get read and write access. Tables without RLS (global tables such as core.guilds) are read-only,
 * since writes there are not limited to one guild. A module whose role does not exist is skipped; checkRoles reports
 * it. Not safe to run concurrently: at startup use prepareDatabase, which runs it under the migration lock.
 */
export async function grantAppRole(database: Database, modules: string[]): Promise<void> {
  await grantRoles(database.adminPool, database.appRole, modules);
}

export async function grantRoles(admin: Queryable, appRole: string, modules: string[]): Promise<void> {
  const app = quoteIdent(appRole);
  for (const schema of modules) {
    assertModuleName(schema);
    const target = quoteIdent(schema);
    const statements: string[] = [];
    let grantee = app;
    if (schema !== CORE) {
      statements.push(
        `revoke all on all tables in schema ${target} from ${app}`,
        `revoke all on all sequences in schema ${target} from ${app}`,
        `revoke usage on schema ${target} from ${app}`,
      );
      const role = moduleRoleName(appRole, schema);
      const { rows } = await admin.query('select 1 from pg_roles where rolname = $1', [role]);
      if (rows.length === 0) {
        await admin.query(statements.join(';\n'));
        continue;
      }
      grantee = quoteIdent(role);
    }
    const { rows } = await admin.query<{ name: string; rls: boolean }>(
      `select c.relname as "name", c.relrowsecurity as "rls"
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
        order by c.relname`,
      [schema],
    );
    statements.push(`grant usage on schema ${target} to ${grantee}`);
    for (const { name, rls } of rows) {
      const table = `${target}.${quoteIdent(name)}`;
      // Revoking first keeps the grants exact when a table's RLS setting changes between starts.
      statements.push(`revoke all on ${table} from ${grantee}`);
      statements.push(`grant ${rls ? 'select, insert, update, delete' : 'select'} on ${table} to ${grantee}`);
    }
    statements.push(`grant usage, select on all sequences in schema ${target} to ${grantee}`);
    // One simple-protocol query runs as one transaction, so no role sees a table without its grants.
    await admin.query(statements.join(';\n'));
  }
}
