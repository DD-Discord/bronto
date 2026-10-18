import { MIGRATIONS_SCHEMA } from './constants.js';
import type { Database, Queryable } from './database.js';
import { moduleRoleName } from './module-roles.js';
import { assertModuleName, quoteIdent } from './names.js';

const CORE = 'core';

/**
 * Gives data access, but no DDL, to the tables that exist in each schema now; run it after every migration. `core`
 * goes to the app role; each module schema goes to that module's role only, and the app role loses all access to it.
 * Module roles get read and write access to every table of their schema, including their global tables (RLS still
 * limits guild tables to one guild). The app role gets read and write access to core's RLS tables and read-only
 * access to core's global tables such as core.guilds. A module whose role does not exist is skipped; checkRoles reports
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
      statements.push(...appRevokes(target, app));
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
    const writesAll = schema !== CORE;
    statements.push(`grant usage on schema ${target} to ${grantee}`);
    for (const { name, rls } of rows) {
      const table = `${target}.${quoteIdent(name)}`;
      // Revoking first keeps the grants exact when a table's RLS setting changes between starts.
      statements.push(`revoke all on ${table} from ${grantee}`);
      statements.push(`grant ${rls || writesAll ? 'select, insert, update, delete' : 'select'} on ${table} to ${grantee}`);
    }
    statements.push(`grant usage, select on all sequences in schema ${target} to ${grantee}`);
    // One simple-protocol query runs as one transaction, so no role sees a table without its grants.
    await admin.query(statements.join(';\n'));
  }
}

/**
 * Takes all access from the app role on the schemas of migrated modules not in `loaded`, so a module removed from the
 * config keeps no app role grants from an earlier start. Same concurrency rule as grantRoles.
 */
export async function revokeUnloadedModules(admin: Queryable, appRole: string, loaded: string[]): Promise<void> {
  const { rows } = await admin.query<{ name: string }>(
    `select t.table_name as "name"
       from information_schema.tables t
       join pg_namespace n on n.nspname = t.table_name
      where t.table_schema = $1 and t.table_name <> $2 and not (t.table_name = any($3::text[]))
      order by t.table_name`,
    [MIGRATIONS_SCHEMA, CORE, loaded],
  );
  const app = quoteIdent(appRole);
  for (const { name } of rows) {
    await admin.query(appRevokes(quoteIdent(name), app).join(';\n'));
  }
}

function appRevokes(schema: string, app: string): string[] {
  return [
    `revoke all on all tables in schema ${schema} from ${app}`,
    `revoke all on all sequences in schema ${schema} from ${app}`,
    `revoke usage on schema ${schema} from ${app}`,
  ];
}
