import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';

const globalTables = new WeakSet<object>();

export function markGlobalTable<T extends object>(table: T): T {
  globalTables.add(table);
  return table;
}

/** Names of the tables among a schema file's exports that were declared global (no guild_id, no RLS). */
export function globalTableNames(schemaExports: Record<string, unknown>): string[] {
  return Object.values(schemaExports)
    .filter((value): value is PgTable => is(value, PgTable) && globalTables.has(value))
    .map((table) => getTableConfig(table).name);
}
