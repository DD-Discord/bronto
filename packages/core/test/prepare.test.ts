import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreMigrationTarget } from '../src/db/migrate.js';
import { prepareDatabase } from '../src/db/prepare.js';
import { createTestDatabase, schemaExpectations, widgetsTarget, type TestDatabase } from './test-db.js';

let t: TestDatabase;

async function historyCount(test: TestDatabase, module: string): Promise<number> {
  const { rows } = await test.database.adminPool.query(`select count(*)::int as n from migrations.${module}`);
  return rows[0].n;
}

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe('prepareDatabase', () => {
  const options = () => ({ modules: [widgetsTarget], expectations: schemaExpectations() });

  it('migrates core and modules, grants the app role and checks the schemas', async () => {
    expect(await prepareDatabase(t.database, options())).toEqual([]);
    expect(await historyCount(t, 'core')).toBe(1);
    expect(await historyCount(t, 'widgets')).toBe(1);
    await expect(t.database.appPool.query('select count(*) from widgets.items')).resolves.toBeDefined();
  });

  it('returns the problems the checks find', async () => {
    await t.database.adminPool.query('create table widgets.bad (id text primary key)');
    try {
      expect(await prepareDatabase(t.database, options())).toEqual([
        { schema: 'widgets', table: 'bad', problem: 'missing-rls' },
        { schema: 'widgets', table: 'bad', problem: 'missing-policy' },
        { schema: 'widgets', table: 'bad', problem: 'missing-guild-fk' },
      ]);
    } finally {
      await t.database.adminPool.query('drop table widgets.bad');
    }
  });

  it('grants access to tables created since the last start', async () => {
    await t.database.adminPool.query(`
      create table widgets.later (id text primary key, guild_id text not null references core.guilds(id) on delete cascade);
      alter table widgets.later enable row level security;
      create policy later_guild_isolation on widgets.later using (guild_id = current_setting('app.guild_id', true));
    `);
    try {
      await expect(t.database.appPool.query('select * from widgets.later')).rejects.toThrow(/permission denied/);
      expect(await prepareDatabase(t.database, options())).toEqual([]);
      await expect(t.database.appPool.query('select * from widgets.later')).resolves.toBeDefined();
    } finally {
      await t.database.adminPool.query('drop table widgets.later');
    }
  });

  it('prepares a fresh database once when two processes start together', async () => {
    const other = await createTestDatabase();
    try {
      const results = await Promise.all([prepareDatabase(other.database, options()), prepareDatabase(other.database, options())]);
      expect(results).toEqual([[], []]);
      expect(await historyCount(other, 'core')).toBe(1);
      expect(await historyCount(other, 'widgets')).toBe(1);
    } finally {
      await other.drop();
    }
  });

  it('refuses a module target named core', async () => {
    await expect(prepareDatabase(t.database, { modules: [coreMigrationTarget], expectations: [] })).rejects.toThrow(
      /core/,
    );
  });

  it('rejects unsafe module names before running any SQL', async () => {
    await expect(
      prepareDatabase(t.database, { modules: [{ name: 'x; drop schema core', folder: '.' }], expectations: [] }),
    ).rejects.toThrow(/^Invalid module name/);
  });
});
