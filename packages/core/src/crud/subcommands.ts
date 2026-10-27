import { eq, getTableColumns, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { defineSubcommand, type SubcommandDefinition } from '../interactions/commands.js';
import type { CommandContext } from '../interactions/context.js';
import { UserError } from '../interactions/errors.js';
import { batchLines } from '../interactions/format.js';
import type { OptionDefinition, OptionMap } from '../interactions/options.js';
import { entityAutocomplete, type Entity } from './entity.js';

export type CrudAction = 'create' | 'edit' | 'show' | 'list' | 'delete' | 'set' | 'remove';

export interface CrudKey<TName extends string, TValue> {
  /** Option name, e.g. "channel". */
  name: TName;
  /** Declared optional; the generated subcommands decide where it is required. */
  option: OptionDefinition<TValue, false>;
  /** The stored key for an option value, e.g. a channel's ID. */
  toKey: (value: TValue) => string;
  /** How a key appears in messages; `` `key` `` by default. */
  format?: (key: string) => string;
  /**
   * Key `show` uses when the option is omitted, e.g. the current channel. In the `set` style, `set` and `remove` use it
   * too; `create-edit` subcommands always need the option.
   */
  fallback?: (ctx: CommandContext) => string | null;
  /** Generates keys for `create`, which then has no key option. */
  generate?: () => string;
}

export interface CrudField<TValue> {
  /** Declared optional; `create` (and `set` on a missing record) requires fields without a default. */
  option: OptionDefinition<TValue, false>;
  /** Column property the value is written to; fields without one only reach `prepare`. */
  column?: string;
  /** Value `create` uses when the option is omitted. */
  default?: TValue;
  /** Converts the option value to the column value. */
  toColumn?: (value: TValue) => unknown;
}

type FieldValue<F> = F extends CrudField<infer V> ? V : never;

/** Option values hooks receive; omitted options are null (in `create`, defaults are filled in). */
export type CrudValues<TFields, TKeyName extends string, TKeyValue> = { [K in keyof TFields]: FieldValue<TFields[K]> | null } & {
  [K in TKeyName]: TKeyValue | null;
};

export interface CrudHooks<TTable extends PgTable, TValues> {
  /**
   * Runs in `create`, `edit` and `set` outside any transaction and returns extra column values. It runs before `validate` and
   * before the write, which can still fail (e.g. on a duplicate key); side effects it makes are not rolled back.
   */
  prepare?: (
    ctx: CommandContext,
    values: TValues,
    existing: InferSelectModel<TTable> | null,
  ) => Partial<InferInsertModel<TTable>> | void | Promise<Partial<InferInsertModel<TTable>> | void>;
  /** Cross-field checks of the record about to be written; returns messages for the user. */
  validate?: (record: Partial<InferSelectModel<TTable>>) => string[];
  afterWrite?: (ctx: CommandContext, record: InferSelectModel<TTable>, action: 'create' | 'edit') => unknown;
  beforeDelete?: (ctx: CommandContext, record: InferSelectModel<TTable>) => unknown;
}

export interface CrudOptions<
  TTable extends PgTable,
  TKeyName extends string,
  TKeyValue,
  TFields extends Record<string, CrudField<any>>,
> {
  key: CrudKey<TKeyName, TKeyValue>;
  fields: TFields;
  hooks?: CrudHooks<TTable, CrudValues<TFields, TKeyName, TKeyValue>>;
  /** Subcommands to leave out. */
  omit?: CrudAction[];
  /**
   * `create-edit` (default) generates create, edit, show, list and delete. `set` generates set (creates or changes),
   * show, list and remove; `omit`, `override` and `descriptions` use those names.
   */
  style?: 'create-edit' | 'set';
  /** Subcommands to replace entirely. */
  override?: Partial<Record<CrudAction, SubcommandDefinition<any>>>;
  descriptions?: Partial<Record<CrudAction, string>>;
  /** Whether replies are visible only to the user; true by default. */
  ephemeral?: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  for (let current = error; typeof current === 'object' && current !== null; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** Generates create/edit/delete or set/remove subcommands, plus show and list, for one entity. */
export function crudSubcommands<
  TTable extends PgTable,
  TKeyName extends string,
  TKeyValue,
  TFields extends Record<string, CrudField<any>>,
>(entity: Entity<TTable>, options: CrudOptions<TTable, TKeyName, TKeyValue, TFields>): Record<string, SubcommandDefinition<any>> {
  type Row = InferSelectModel<TTable>;
  type Values = CrudValues<TFields, TKeyName, TKeyValue>;
  const { key, fields } = options;
  const hooks = options.hooks ?? {};
  const ephemeral = options.ephemeral ?? true;
  const setStyle = options.style === 'set';
  const columns = getTableColumns(entity.table);
  for (const [name, field] of Object.entries(fields)) {
    if (name === key.name) throw new Error(`CRUD field "${name}" has the same name as the key option.`);
    if (field.column === undefined) continue;
    if (!Object.hasOwn(columns, field.column)) {
      throw new Error(`CRUD field "${name}" names unknown column "${field.column}" of ${entity.displayName.plural}.`);
    }
    if (field.column === entity.key) throw new Error(`CRUD field "${name}" must not write the key column.`);
  }

  const singular = entity.displayName.singular;
  const lower = singular.toLowerCase();
  const pluralLower = entity.displayName.plural.toLowerCase();
  const formatKey = key.format ?? ((value: string) => `\`${value}\``);
  const notFound = (recordKey: string) => `There is no ${lower} for ${formatKey(recordKey)}.`;
  const exists = (recordKey: string) => `${singular} for ${formatKey(recordKey)} already exists.`;

  const keyOption = (required: boolean): OptionDefinition<TKeyValue, boolean> => {
    const suggest =
      key.option.autocomplete ??
      (key.option.kind === 'string' && key.option.choices === undefined ? entityAutocomplete(entity) : undefined);
    return { ...key.option, required, autocomplete: suggest };
  };
  const fieldOptions = (forCreate: boolean): OptionMap =>
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [name, { ...field.option, required: forCreate && field.default === undefined }]),
    );

  const keyFrom = (ctx: CommandContext, values: Record<string, unknown>, allowFallback: boolean): string => {
    const raw = values[key.name];
    if (raw !== null && raw !== undefined) return key.toKey(raw as TKeyValue);
    const fallback = allowFallback ? (key.fallback?.(ctx) ?? null) : null;
    if (fallback === null) throw new UserError(`Name the ${lower} with the \`${key.name}\` option.`);
    return fallback;
  };
  const load = async (ctx: CommandContext, recordKey: string): Promise<Row> => {
    const record = await entity.find(ctx.db, recordKey);
    if (record === null) throw new UserError(notFound(recordKey));
    return record;
  };
  const columnValues = (values: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(fields)) {
      const value = values[name];
      if (field.column === undefined || value === null || value === undefined) continue;
      result[field.column] = field.toColumn === undefined ? value : field.toColumn(value);
    }
    return result;
  };
  const check = (record: Partial<Row>): void => {
    const problems = hooks.validate?.(record) ?? [];
    if (problems.length === 1) throw new UserError(problems[0]!);
    if (problems.length > 1) throw new UserError(problems.map((problem) => `- ${problem}`).join('\n'));
  };

  const createWith = async (ctx: CommandContext, raw: Record<string, unknown>, recordKey: string): Promise<void> => {
    const values: Record<string, unknown> = { ...raw };
    for (const [name, field] of Object.entries(fields)) {
      if (values[name] === null && field.default !== undefined) values[name] = field.default;
    }
    if ((await entity.find(ctx.db, recordKey)) !== null) throw new UserError(exists(recordKey));
    const extra = (await hooks.prepare?.(ctx, values as Values, null)) ?? {};
    const record = { ...columnValues(values), ...extra, [entity.key]: recordKey };
    check(record as Partial<Row>);
    let row: Row;
    try {
      row = await ctx.db.run(async (tx) => {
        const [inserted] = await tx.insert(entity.table).values(record as InferInsertModel<TTable>).returning();
        return inserted as Row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new UserError(exists(recordKey));
      throw error;
    }
    await hooks.afterWrite?.(ctx, row, 'create');
    await ctx.reply({ content: `**${singular} created.**`, embeds: [await entity.formatFull(row, ctx)] });
  };

  const editWith = async (ctx: CommandContext, raw: Record<string, unknown>, recordKey: string, existing: Row): Promise<void> => {
    const nothingToChange = 'Nothing to change; pass at least one option.';
    // Checked before prepare, which may have side effects such as Discord calls.
    if (Object.keys(fields).every((name) => raw[name] === null || raw[name] === undefined)) throw new UserError(nothingToChange);
    const changes: Record<string, unknown> = {
      ...columnValues(raw),
      ...((await hooks.prepare?.(ctx, raw as Values, existing)) ?? {}),
    };
    delete changes[entity.key];
    if (Object.keys(changes).length === 0) throw new UserError(nothingToChange);
    check({ ...existing, ...changes } as Partial<Row>);
    const row = await ctx.db.run(async (tx) => {
      const updated = (await tx
        .update(entity.table)
        .set(changes as Partial<InferInsertModel<TTable>>)
        .where(eq(entity.keyColumn, recordKey))
        .returning()) as Row[];
      return updated[0];
    });
    if (row === undefined) throw new UserError(notFound(recordKey));
    await hooks.afterWrite?.(ctx, row, 'edit');
    await ctx.reply({ content: `**${singular} updated.**`, embeds: [await entity.formatFull(row, ctx)] });
  };

  const create = (ctx: CommandContext, raw: Record<string, unknown>): Promise<void> =>
    createWith(ctx, raw, key.generate === undefined ? keyFrom(ctx, raw, false) : key.generate());

  const edit = async (ctx: CommandContext, raw: Record<string, unknown>): Promise<void> => {
    const recordKey = keyFrom(ctx, raw, false);
    await editWith(ctx, raw, recordKey, await load(ctx, recordKey));
  };

  const set = async (ctx: CommandContext, raw: Record<string, unknown>): Promise<void> => {
    const recordKey = keyFrom(ctx, raw, true);
    const existing = await entity.find(ctx.db, recordKey);
    if (existing !== null) return editWith(ctx, raw, recordKey, existing);
    for (const [name, field] of Object.entries(fields)) {
      if ((raw[name] === null || raw[name] === undefined) && field.default === undefined) {
        throw new UserError(`\`${name}\` is needed to create ${article(lower)}.`);
      }
    }
    return createWith(ctx, raw, recordKey);
  };

  const show = async (ctx: CommandContext, raw: Record<string, unknown>): Promise<void> => {
    const record = await load(ctx, keyFrom(ctx, raw, true));
    await ctx.reply({ embeds: [await entity.formatFull(record, ctx)] });
  };

  const list = async (ctx: CommandContext): Promise<void> => {
    const records = await entity.list(ctx.db);
    if (records.length === 0) {
      await ctx.reply(`There are no ${pluralLower} yet.`);
      return;
    }
    const heading = `**${records.length} ${records.length === 1 ? singular : entity.displayName.plural}**`;
    const lines = [heading, ...records.map((record) => `- ${entity.formatShort(record)}`)];
    for (const chunk of batchLines(lines)) await ctx.reply(chunk);
  };

  const remove = async (ctx: CommandContext, raw: Record<string, unknown>): Promise<void> => {
    const recordKey = keyFrom(ctx, raw, setStyle);
    const record = await load(ctx, recordKey);
    await hooks.beforeDelete?.(ctx, record);
    const deleted = await ctx.db.run(async (tx) => {
      return (await tx.delete(entity.table).where(eq(entity.keyColumn, recordKey)).returning()).length;
    });
    if (deleted === 0) throw new UserError(notFound(recordKey));
    await ctx.reply(`**${singular} deleted:** ${entity.formatShort(record)}`);
  };

  const describe = (action: CrudAction, fallback: string) => options.descriptions?.[action] ?? fallback;
  const keyed = (required: boolean): OptionMap => ({ [key.name]: keyOption(required) });
  const generated: Record<CrudAction, SubcommandDefinition<any>> = {
    set: defineSubcommand({
      description: describe('set', `Creates or changes ${article(lower)}`),
      ephemeral,
      options: { ...keyed(key.fallback === undefined), ...fieldOptions(false) },
      execute: set,
    }),
    remove: defineSubcommand({
      description: describe('remove', `Removes ${article(lower)}`),
      ephemeral,
      options: keyed(key.fallback === undefined),
      execute: remove,
    }),
    create: defineSubcommand({
      description: describe('create', `Creates ${article(lower)}`),
      ephemeral,
      options: { ...(key.generate === undefined ? keyed(true) : {}), ...fieldOptions(true) },
      execute: create,
    }),
    edit: defineSubcommand({
      description: describe('edit', `Changes ${article(lower)}`),
      ephemeral,
      options: { ...keyed(true), ...fieldOptions(false) },
      execute: edit,
    }),
    show: defineSubcommand({
      description: describe('show', `Shows ${article(lower)}`),
      ephemeral,
      options: keyed(key.fallback === undefined),
      execute: show,
    }),
    list: defineSubcommand({ description: describe('list', `Lists all ${pluralLower}`), ephemeral, execute: list }),
    delete: defineSubcommand({
      description: describe('delete', `Deletes ${article(lower)}`),
      ephemeral,
      options: keyed(true),
      execute: remove,
    }),
  };
  const result: Record<string, SubcommandDefinition<any>> = {};
  const actions = setStyle ? (['set', 'show', 'list', 'remove'] as const) : (['create', 'edit', 'show', 'list', 'delete'] as const);
  for (const action of actions) {
    if (options.omit?.includes(action)) continue;
    result[action] = options.override?.[action] ?? generated[action];
  }
  return result;
}
