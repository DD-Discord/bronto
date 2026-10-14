import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSchemas, formatSchemaProblems } from '../src/db/checks.js';
import { globalTableNames } from '../src/db/registry.js';
import * as coreSchema from '../src/db/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;
const coreExpectation = () => ({ schema: 'core', globalTables: globalTableNames(coreSchema) });

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterAll(async () => {
  await t.drop();
});

describe('checkSchemas', () => {
  it('accepts tables built with guildTable and declared globals', async () => {
    expect(await checkSchemas(t.database, [coreExpectation(), { schema: 'widgets', globalTables: [] }])).toEqual([]);
  });

  it('flags a global table that was not declared global', async () => {
    const problems = await checkSchemas(t.database, [{ schema: 'core', globalTables: [] }]);
    expect(problems).toEqual([
      { schema: 'core', table: 'guilds', problem: 'missing-rls' },
      { schema: 'core', table: 'guilds', problem: 'missing-policy' },
      { schema: 'core', table: 'guilds', problem: 'missing-guild-fk' },
    ]);
  });

  it('flags a table created without guildTable', async () => {
    await t.database.adminPool.query('create table widgets.bad (id text primary key)');
    try {
      const problems = await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }]);
      expect(problems).toEqual([
        { schema: 'widgets', table: 'bad', problem: 'missing-rls' },
        { schema: 'widgets', table: 'bad', problem: 'missing-policy' },
        { schema: 'widgets', table: 'bad', problem: 'missing-guild-fk' },
      ]);
      expect(formatSchemaProblems(problems)).toBe(
        'widgets.bad: missing-rls\nwidgets.bad: missing-policy\nwidgets.bad: missing-guild-fk',
      );
    } finally {
      await t.database.adminPool.query('drop table widgets.bad');
    }
  });

  it('flags RLS without a policy', async () => {
    await t.database.adminPool.query(`
      create table widgets.half (id text primary key, guild_id text not null references core.guilds(id));
      alter table widgets.half enable row level security;
    `);
    try {
      expect(await checkSchemas(t.database, [{ schema: 'widgets', globalTables: [] }])).toEqual([
        { schema: 'widgets', table: 'half', problem: 'missing-policy' },
      ]);
    } finally {
      await t.database.adminPool.query('drop table widgets.half');
    }
  });
});
