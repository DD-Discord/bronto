import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreMigrationTarget } from '../src/db/migrate.js';
import { prepareDatabase } from '../src/db/prepare.js';
import { asModuleRole, createTestDatabase, errorText, schemaExpectations, widgetsTarget, type TestDatabase } from './test-db.js';

let t: TestDatabase;

/** Runs `query` as the widgets module role through the app connection, the way a widgets handler would. */
function asWidgets(query: string) {
  return asModuleRole(t.database, 'widgets', (tx) => tx.execute(sql.raw(query)));
}

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

  it('migrates core and modules, grants the roles and checks the schemas', async () => {
    expect(await prepareDatabase(t.database, options())).toEqual([]);
    expect(await historyCount(t, 'core')).toBe(1);
    expect(await historyCount(t, 'widgets')).toBe(2);
    await expect(asWidgets('select count(*) from widgets.items')).resolves.toBeDefined();
    await expect(t.database.appPool.query('select count(*) from widgets.items')).rejects.toThrow(/permission denied/);
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
      const refused = await asWidgets('select * from widgets.later').catch((e: unknown) => e);
      expect(errorText(refused)).toMatch(/permission denied/);
      expect(await prepareDatabase(t.database, options())).toEqual([]);
      await expect(asWidgets('select * from widgets.later')).resolves.toBeDefined();
    } finally {
      await t.database.adminPool.query('drop table widgets.later');
    }
  });

  it('takes the app role off the schema of a module that is no longer loaded', async () => {
    expect(await prepareDatabase(t.database, options())).toEqual([]);
    const app = t.database.appRole;
    await t.database.adminPool.query(
      `grant usage on schema widgets to ${app}; grant all on all tables in schema widgets to ${app}`,
    );
    const coreOnly = { modules: [], expectations: schemaExpectations().filter(({ schema }) => schema === 'core') };
    expect(await prepareDatabase(t.database, coreOnly)).toEqual([]);
    const { rows } = await t.database.adminPool.query<{ usage: boolean; select: boolean }>(
      `select has_schema_privilege($1, 'widgets', 'USAGE') as "usage",
              has_table_privilege($1, 'widgets.items', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') as "select"`,
      [app],
    );
    expect(rows).toEqual([{ usage: false, select: false }]);
    expect(await prepareDatabase(t.database, options())).toEqual([]);
  });

  it('prepares a fresh database once when two processes start together', async () => {
    const other = await createTestDatabase();
    try {
      const results = await Promise.all([prepareDatabase(other.database, options()), prepareDatabase(other.database, options())]);
      expect(results).toEqual([[], []]);
      expect(await historyCount(other, 'core')).toBe(1);
      expect(await historyCount(other, 'widgets')).toBe(2);
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
