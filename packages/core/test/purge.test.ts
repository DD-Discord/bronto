import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreMigrationTarget, migrateAll } from '../src/db/migrate.js';
import { listMigratedModules, purgeModuleSchema } from '../src/db/purge.js';
import { createTestDatabase, setUpSchema, widgetsTarget, type TestDatabase } from './test-db.js';

let t: TestDatabase;

async function schemaExists(name: string): Promise<boolean> {
  const { rows } = await t.database.adminPool.query('select 1 from pg_namespace where nspname = $1', [name]);
  return rows.length === 1;
}

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterAll(async () => {
  await t.drop();
});

describe('module purge', () => {
  it('lists modules with a migration history', async () => {
    expect(await listMigratedModules(t.database)).toEqual(['core', 'widgets']);
  });

  it('drops the schema and its history', async () => {
    await purgeModuleSchema(t.database, 'widgets');
    expect(await schemaExists('widgets')).toBe(false);
    expect(await listMigratedModules(t.database)).toEqual(['core']);
  });

  it('recreates a purged module from scratch on the next migration', async () => {
    await migrateAll(t.database, [coreMigrationTarget, widgetsTarget]);
    expect(await schemaExists('widgets')).toBe(true);
    expect(await listMigratedModules(t.database)).toEqual(['core', 'widgets']);
  });

  it('refuses to purge core', async () => {
    await expect(purgeModuleSchema(t.database, 'core')).rejects.toThrow(/core/);
    expect(await schemaExists('core')).toBe(true);
  });

  it('rejects unsafe names before running any SQL', async () => {
    await expect(purgeModuleSchema(t.database, 'widgets; drop schema core cascade')).rejects.toThrow(
      /^Invalid module name/,
    );
    expect(await schemaExists('core')).toBe(true);
  });
});
