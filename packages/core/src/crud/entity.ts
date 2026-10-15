import { EmbedBuilder } from 'discord.js';
import { asc, eq, getTableColumns, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ScopedDb } from '../db/scoped.js';
import { plainText, truncate } from '../interactions/format.js';
import type { Autocomplete } from '../interactions/options.js';

const MAX_DESCRIPTION = 4096;

/** A stable color for an ID: FNV-1a hash mapped to a hue at fixed saturation and lightness. */
export function colorFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = (hash >>> 0) % 360;
  const saturation = 0.65;
  const lightness = 0.55;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n: number) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return (Math.round(f(0) * 255) << 16) + (Math.round(f(8) * 255) << 8) + Math.round(f(4) * 255);
}

export interface EntityInput<TTable extends PgTable> {
  table: TTable;
  /** Property of the text column identifying a record within its guild. */
  key: keyof InferSelectModel<TTable> & string;
  displayName: { singular: string; plural: string };
  formatShort: (record: InferSelectModel<TTable>) => string;
  formatFull?: (record: InferSelectModel<TTable>, base: () => EmbedBuilder) => EmbedBuilder;
}

/** Display and lookup metadata for one table, shared by CRUD commands, autocomplete, logs and module APIs. */
export interface Entity<TTable extends PgTable = PgTable> {
  readonly table: TTable;
  readonly key: string;
  readonly keyColumn: PgColumn;
  readonly displayName: { singular: string; plural: string };
  keyOf(record: InferSelectModel<TTable>): string;
  formatShort(record: InferSelectModel<TTable>): string;
  formatFull(record: InferSelectModel<TTable>): EmbedBuilder;
  /** The record with this key in the db's guild, or null. */
  find(db: ScopedDb, key: string): Promise<InferSelectModel<TTable> | null>;
  /** The db guild's records, oldest first. */
  list(db: ScopedDb): Promise<InferSelectModel<TTable>[]>;
}

export function defineEntity<TTable extends PgTable>(input: EntityInput<TTable>): Entity<TTable> {
  type Row = InferSelectModel<TTable>;
  const columns = getTableColumns(input.table) as unknown as Record<string, PgColumn>;
  const keyColumn = columns[input.key];
  if (keyColumn === undefined) throw new Error(`Table of ${input.displayName.plural} has no column "${input.key}".`);
  const createdAt = columns.createdAt;
  const keyOf = (record: Row) => String(record[input.key]);
  const base = (record: Row) => {
    const embed = new EmbedBuilder()
      .setTitle(input.displayName.singular)
      .setDescription(truncate(input.formatShort(record), MAX_DESCRIPTION))
      .setColor(colorFromId(keyOf(record)));
    const created = (record as { createdAt?: unknown }).createdAt;
    if (created instanceof Date) embed.setTimestamp(created);
    return embed;
  };
  return {
    table: input.table,
    key: input.key,
    keyColumn,
    displayName: input.displayName,
    keyOf,
    formatShort: input.formatShort,
    formatFull: (record) => (input.formatFull === undefined ? base(record) : input.formatFull(record, () => base(record))),
    async find(db, key) {
      const rows = await db.run(async (tx) => tx.select().from(input.table as PgTable).where(eq(keyColumn, key)).limit(1));
      return (rows[0] as Row | undefined) ?? null;
    },
    async list(db) {
      const order = createdAt === undefined ? [asc(keyColumn)] : [asc(createdAt), asc(keyColumn)];
      const rows = await db.run(async (tx) => tx.select().from(input.table as PgTable).orderBy(...order));
      return rows as Row[];
    },
  };
}

/** Suggests the guild's records of an entity by their short label; the value is the record key. */
export function entityAutocomplete<TTable extends PgTable>(entity: Entity<TTable>): Autocomplete {
  return async (ctx, query) => {
    const needle = query.toLowerCase();
    return (await entity.list(ctx.db))
      .map((record) => ({ name: plainText(entity.formatShort(record)), value: entity.keyOf(record) }))
      .filter((choice) => choice.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
}
