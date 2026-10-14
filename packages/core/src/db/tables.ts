import { sql, type BuildExtraConfigColumns } from 'drizzle-orm';
import {
  index,
  pgPolicy,
  text,
  type PgColumnBuilderBase,
  type PgSchema,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { auditColumns } from './audit.js';
import { currentGuildId } from './context.js';
import { guilds } from './core-schema.js';
import { markGlobalTable } from './registry.js';

function guildColumns() {
  return {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' })
      .$defaultFn(() => {
        const guildId = currentGuildId();
        if (guildId === null) {
          throw new Error('guild_id must be set explicitly outside a guild scope');
        }
        return guildId;
      }),
    ...auditColumns(),
  };
}

/** Joins module and helper columns; a module column must not silently replace a helper column. */
function withHelperColumns<TColumns extends object, THelpers extends object>(
  schema: PgSchema<string>,
  name: string,
  columns: TColumns,
  helpers: THelpers,
): TColumns & THelpers {
  for (const key of Object.keys(helpers)) {
    if (Object.hasOwn(columns, key)) {
      throw new Error(`Table ${schema.schemaName}.${name} must not declare column "${key}"; it is added automatically.`);
    }
  }
  return { ...columns, ...helpers };
}

type GuildColumns = ReturnType<typeof guildColumns>;
type AuditColumns = ReturnType<typeof auditColumns>;

/**
 * A table of per-guild data. Adds guild_id (FK to core.guilds, cascade), its index, an RLS policy limiting rows to
 * `app.guild_id`, and audit columns.
 */
export function guildTable<
  TSchema extends string,
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  schema: PgSchema<TSchema>,
  name: TName,
  columns: TColumns,
  extra?: (self: BuildExtraConfigColumns<TName, TColumns & GuildColumns, 'pg'>) => PgTableExtraConfigValue[],
) {
  return schema
    .table(name, withHelperColumns(schema, name, columns, guildColumns()), (t) => [
      index(`${name}_guild_id_idx`).on(t.guildId),
      pgPolicy(`${name}_guild_isolation`, {
        as: 'permissive',
        for: 'all',
        using: sql`${t.guildId} = current_setting('app.guild_id', true)`,
        withCheck: sql`${t.guildId} = current_setting('app.guild_id', true)`,
      }),
      ...(extra?.(t) ?? []),
    ])
    .enableRLS();
}

/** A table shared by all guilds: audit columns only, no guild_id and no RLS. Use sparingly. */
export function globalTable<
  TSchema extends string,
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  schema: PgSchema<TSchema>,
  name: TName,
  columns: TColumns,
  extra?: (self: BuildExtraConfigColumns<TName, TColumns & AuditColumns, 'pg'>) => PgTableExtraConfigValue[],
) {
  return markGlobalTable(schema.table(name, withHelperColumns(schema, name, columns, auditColumns()), extra));
}
