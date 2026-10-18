import type { Database, Queryable } from './database.js';
import { moduleRoleName } from './module-roles.js';

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

interface RoleState {
  admin: string;
  exists: boolean;
  super: boolean;
  bypass: boolean;
  member: boolean;
  /** Whether the app role may SET ROLE to it; only read for module roles. */
  switchable: boolean;
  /** Whether the app role holds its privileges without SET ROLE; only read for module roles. */
  inherited: boolean;
}

/**
 * Finds app role and module role setups that would make RLS ineffective or block module work. `modules` names the
 * loaded modules that have a database. Returns one message per problem.
 */
export async function checkRoles(database: Database, modules: string[] = []): Promise<string[]> {
  const role = database.appRole;
  const state = await roleState(database, role, role);
  if (!state.exists) return [`App role "${role}" does not exist.`];
  const problems: string[] = [];
  if (state.admin === role) problems.push(`App role "${role}" is the admin role; use a separate role for the app.`);
  problems.push(...privilegeProblems('App role', role, state));
  for (const module of modules) {
    const moduleRole = moduleRoleName(role, module);
    const moduleState = await roleState(database, moduleRole, role);
    if (!moduleState.exists) {
      problems.push(`Module role "${moduleRole}" does not exist.`);
      continue;
    }
    problems.push(...privilegeProblems('Module role', moduleRole, moduleState));
    if (!moduleState.switchable) problems.push(`App role "${role}" cannot switch to module role "${moduleRole}".`);
    // An inheriting membership gives the plain app role the module's table privileges.
    if (moduleState.inherited) {
      problems.push(`App role "${role}" inherits module role "${moduleRole}"; grant it WITH INHERIT FALSE.`);
    }
  }
  return problems;
}

async function roleState(database: Database, role: string, appRole: string): Promise<RoleState> {
  const { rows } = await database.adminPool.query<RoleState>(
    `select current_user as "admin",
            r.rolname is not null as "exists",
            coalesce(r.rolsuper, false) as "super",
            coalesce(r.rolbypassrls, false) as "bypass",
            coalesce(r.rolname <> current_user
                     and pg_has_role(r.oid, (select oid from pg_roles where rolname = current_user), 'MEMBER'),
                     false) as "member",
            coalesce((select pg_has_role(a.oid, r.oid, 'SET') from pg_roles a where a.rolname = $2), false)
              as "switchable",
            coalesce((select pg_has_role(a.oid, r.oid, 'USAGE') from pg_roles a where a.rolname = $2), false)
              as "inherited"
       from (select 1) as one
       left join pg_roles r on r.rolname = $1`,
    [role, appRole],
  );
  return rows[0]!;
}

function privilegeProblems(kind: string, role: string, state: RoleState): string[] {
  const problems: string[] = [];
  if (state.super) problems.push(`${kind} "${role}" is a superuser, which bypasses RLS.`);
  if (state.bypass) problems.push(`${kind} "${role}" has BYPASSRLS.`);
  // Members of the owning role pass ownership checks, and table owners are not subject to RLS.
  // Skip this check if already a superuser, since superusers already bypass RLS completely.
  if (state.member && !state.super) {
    problems.push(
      `${kind} "${role}" is a member of the admin role "${state.admin}", so it bypasses RLS on the admin role's tables.`,
    );
  }
  return problems;
}
