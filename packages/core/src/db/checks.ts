import type { Database, Queryable } from './database.js';

export interface SchemaExpectation {
  schema: string;
  /** Tables declared with globalTable; they are exempt from guild isolation. */
  globalTables: string[];
}

export type SchemaProblemKind =
  | 'missing-rls'
  | 'missing-policy'
  | 'missing-guild-fk'
  | 'guild-fk-not-cascade'
  | 'view-bypasses-rls';

export interface SchemaProblem {
  schema: string;
  table: string;
  problem: SchemaProblemKind;
}

interface RelationState {
  table: string;
  view: boolean;
  rls: boolean;
  policy: boolean;
  guildFk: boolean;
  guildFkCascades: boolean;
}

/**
 * Finds relations that break guild isolation: every non-global table needs RLS, a policy and an FK to core.guilds
 * that cascades on delete. Views are owned by the admin role and would bypass RLS, so none are allowed.
 */
export async function checkSchemas(database: Database, expectations: SchemaExpectation[]): Promise<SchemaProblem[]> {
  return checkSchemasWith(database.adminPool, expectations);
}

export async function checkSchemasWith(admin: Queryable, expectations: SchemaExpectation[]): Promise<SchemaProblem[]> {
  const problems: SchemaProblem[] = [];
  for (const { schema, globalTables } of expectations) {
    const { rows } = await admin.query<RelationState>(
      `select c.relname as "table",
              c.relkind in ('v', 'm') as "view",
              c.relrowsecurity as "rls",
              exists (select 1 from pg_policy p where p.polrelid = c.oid) as "policy",
              exists (select 1 from pg_constraint k
                      where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'core.guilds'::regclass) as "guildFk",
              not exists (select 1 from pg_constraint k
                          where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'core.guilds'::regclass
                            and k.confdeltype <> 'c') as "guildFkCascades"
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')
        order by c.relname`,
      [schema],
    );
    for (const row of rows) {
      if (row.view) {
        problems.push({ schema, table: row.table, problem: 'view-bypasses-rls' });
        continue;
      }
      if (globalTables.includes(row.table)) continue;
      if (!row.rls) problems.push({ schema, table: row.table, problem: 'missing-rls' });
      if (!row.policy) problems.push({ schema, table: row.table, problem: 'missing-policy' });
      if (!row.guildFk) problems.push({ schema, table: row.table, problem: 'missing-guild-fk' });
      else if (!row.guildFkCascades) problems.push({ schema, table: row.table, problem: 'guild-fk-not-cascade' });
    }
  }
  return problems;
}

export function formatSchemaProblems(problems: SchemaProblem[]): string {
  return problems.map(({ schema, table, problem }) => `${schema}.${table}: ${problem}`).join('\n');
}

/** Finds app role setups that would make RLS ineffective. Returns one message per problem. */
export async function checkRoles(database: Database): Promise<string[]> {
  const role = database.appRole;
  const { rows } = await database.adminPool.query<{ admin: string; exists: boolean; super: boolean; bypass: boolean }>(
    `select current_user as "admin",
            r.rolname is not null as "exists",
            coalesce(r.rolsuper, false) as "super",
            coalesce(r.rolbypassrls, false) as "bypass"
       from (select 1) as one
       left join pg_roles r on r.rolname = $1`,
    [role],
  );
  const state = rows[0];
  if (state === undefined || !state.exists) return [`App role "${role}" does not exist.`];
  const problems: string[] = [];
  if (state.admin === role) problems.push(`App role "${role}" is the admin role; use a separate role for the app.`);
  if (state.super) problems.push(`App role "${role}" is a superuser, which bypasses RLS.`);
  if (state.bypass) problems.push(`App role "${role}" has BYPASSRLS.`);
  return problems;
}
