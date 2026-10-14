import { getTableConfig, integer, pgSchema, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { runInScope } from './context.js';
import { guilds } from './core-schema.js';
import { assertModuleName, quoteIdent } from './names.js';
import { globalTableNames } from './registry.js';
import * as coreSchema from './schema.js';
import { globalTable, guildTable } from './tables.js';

const demo = pgSchema('demo');
const items = guildTable(demo, 'items', { id: text('id').primaryKey(), count: integer('count').notNull() });
const shared = globalTable(demo, 'shared', { id: text('id').primaryKey() });

describe('guildTable', () => {
  const config = getTableConfig(items);

  it('adds guild and audit columns', () => {
    expect(config.columns.map((column) => column.name).sort()).toEqual([
      'count', 'created_at', 'created_by', 'guild_id', 'id', 'updated_at', 'updated_by',
    ]);
  });

  it('references core.guilds with cascade', () => {
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.reference().foreignTable).toBe(guilds);
    expect(config.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('indexes guild_id and enables RLS with a guild policy', () => {
    expect(config.indexes.map((index) => index.config.name)).toEqual(['items_guild_id_idx']);
    expect(config.policies.map((policy) => policy.name)).toEqual(['items_guild_isolation']);
    expect(config.enableRLS).toBe(true);
  });

  it('defaults guild_id to the scoped guild and refuses outside a scope', () => {
    const guildId = config.columns.find((column) => column.name === 'guild_id');
    expect(runInScope({ guildId: 'g1' }, () => guildId?.defaultFn?.())).toBe('g1');
    expect(() => guildId?.defaultFn?.()).toThrow(/guild scope/);
  });
});

describe('globalTable', () => {
  it('has audit columns but no guild_id and no RLS', () => {
    const config = getTableConfig(shared);
    expect(config.columns.map((column) => column.name).sort()).toEqual([
      'created_at', 'created_by', 'id', 'updated_at', 'updated_by',
    ]);
    expect(config.enableRLS).toBe(false);
    expect(config.policies).toEqual([]);
  });
});

describe('globalTableNames', () => {
  it('lists only tables declared global', () => {
    expect(globalTableNames({ items, shared, other: 1 })).toEqual(['shared']);
    expect(globalTableNames(coreSchema)).toEqual(['guilds']);
  });
});

describe('audit actor', () => {
  it('reads the actor from the scope', () => {
    const createdBy = getTableConfig(items).columns.find((column) => column.name === 'created_by');
    expect(runInScope({ actorId: 'u1' }, () => createdBy?.defaultFn?.())).toBe('u1');
    expect(createdBy?.defaultFn?.()).toBeNull();
  });
});

describe('module names', () => {
  it('accepts safe identifiers', () => {
    expect(() => assertModuleName('sticky')).not.toThrow();
    expect(() => assertModuleName('role_pools2')).not.toThrow();
  });

  it.each(['Sticky', 'sticky-bot', '1sticky', '', 'migrations', 'public', 'pg_x', 'a"; drop schema core; --'])(
    'rejects %j',
    (name) => {
      expect(() => assertModuleName(name)).toThrow(/^Invalid module name/);
    },
  );

  it('quotes identifiers', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});
