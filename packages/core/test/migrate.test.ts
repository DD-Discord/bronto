import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantRoles } from '../src/db/grants.js';
import { coreMigrationTarget, migrateAll } from '../src/db/migrate.js';
import { ensureModuleRoles, moduleRoleName } from '../src/db/module-roles.js';
import { createTestDatabase, widgetsTarget, type TestDatabase } from './test-db.js';

const targets = [coreMigrationTarget, widgetsTarget];
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

describe('migrateAll', () => {
  it('applies core and module migrations with separate histories', async () => {
    await migrateAll(t.database, targets);
    const histories = await t.database.adminPool.query(
      `select table_name from information_schema.tables where table_schema = 'migrations' order by 1`,
    );
    expect(histories.rows.map((row) => row.table_name)).toEqual(['core', 'widgets']);
    const tables = await t.database.adminPool.query(
      `select table_schema || '.' || table_name as name from information_schema.tables
       where table_schema in ('core', 'widgets') order by 1`,
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['core.guild_modules', 'core.guilds', 'widgets.catalog', 'widgets.items']);
  });

  it('does nothing when run again', async () => {
    await migrateAll(t.database, targets);
    expect(await historyCount(t, 'widgets')).toBe(2);
  });

  it('applies migrations exactly once when two processes start together', async () => {
    const other = await createTestDatabase();
    try {
      await Promise.all([migrateAll(other.database, targets), migrateAll(other.database, targets)]);
      expect(await historyCount(other, 'core')).toBe(1);
      expect(await historyCount(other, 'widgets')).toBe(2);
    } finally {
      await other.drop();
    }
  });

  it('rejects unsafe module names before running any SQL', async () => {
    await expect(migrateAll(t.database, [{ name: 'x; drop schema core', folder: '.' }])).rejects.toThrow(
      /^Invalid module name/,
    );
  });
});

describe('grantRoles', () => {
  it('moves module schema access from the app role to the module role', async () => {
    const app = t.database.appRole;
    const role = moduleRoleName(app, 'widgets');
    await ensureModuleRoles(t.database.adminPool, app, ['widgets']);
    await t.database.adminPool.query(
      `grant usage on schema widgets to ${app}; grant all on all tables in schema widgets to ${app};
       grant all on all sequences in schema widgets to ${app}`,
    );
    await grantRoles(t.database.adminPool, app, ['core', 'widgets']);
    // has_table_privilege with a list is true when any of the privileges is held.
    const { rows } = await t.database.adminPool.query<{ app: boolean; module: boolean }>(
      `select has_schema_privilege($1, 'widgets', 'USAGE')
                or has_table_privilege($1, 'widgets.items', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                as "app",
              has_schema_privilege($2, 'widgets', 'USAGE')
                and has_table_privilege($2, 'widgets.items', 'SELECT')
                and has_table_privilege($2, 'widgets.items', 'INSERT')
                and has_table_privilege($2, 'widgets.items', 'UPDATE')
                and has_table_privilege($2, 'widgets.items', 'DELETE')
                as "module"`,
      [app, role],
    );
    expect(rows).toEqual([{ app: false, module: true }]);
    await expect(t.database.appPool.query('select count(*) from widgets.items')).rejects.toThrow(/permission denied/);
  });
});
