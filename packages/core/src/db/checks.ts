import type { Database } from './database.js';

export interface SchemaExpectation {
  schema: string;
  /** Tables declared with globalTable; they are exempt from guild isolation. */
  globalTables: string[];
}

export type SchemaProblemKind = 'missing-rls' | 'missing-policy' | 'missing-guild-fk';

export interface SchemaProblem {
  schema: string;
  table: string;
  problem: SchemaProblemKind;
}

interface TableState {
  table: string;
  rls: boolean;
  policy: boolean;
  guildFk: boolean;
}

/** Finds tables that break guild isolation: every non-global table needs RLS, a policy and an FK to core.guilds. */
export async function checkSchemas(database: Database, expectations: SchemaExpectation[]): Promise<SchemaProblem[]> {
  const problems: SchemaProblem[] = [];
  for (const { schema, globalTables } of expectations) {
    const { rows } = await database.adminPool.query<TableState>(
      `select c.relname as "table",
              c.relrowsecurity as "rls",
              exists (select 1 from pg_policy p where p.polrelid = c.oid) as "policy",
              exists (select 1 from pg_constraint k
                      where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'core.guilds'::regclass) as "guildFk"
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p')
        order by c.relname`,
      [schema],
    );
    for (const row of rows) {
      if (globalTables.includes(row.table)) continue;
      if (!row.rls) problems.push({ schema, table: row.table, problem: 'missing-rls' });
      if (!row.policy) problems.push({ schema, table: row.table, problem: 'missing-policy' });
      if (!row.guildFk) problems.push({ schema, table: row.table, problem: 'missing-guild-fk' });
    }
  }
  return problems;
}

export function formatSchemaProblems(problems: SchemaProblem[]): string {
  return problems.map(({ schema, table, problem }) => `${schema}.${table}: ${problem}`).join('\n');
}
