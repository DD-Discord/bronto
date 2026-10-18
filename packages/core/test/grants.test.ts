import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guildModules, guilds } from '../src/db/schema.js';
import { createScopedDb } from '../src/db/scoped.js';
import { widgetCatalog, widgetItems } from './fixtures/widgets/schema.js';
import { asModuleRole, createTestDatabase, errorText, setUpSchema, widgetsDb, type TestDatabase } from './test-db.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values([{ id: 'g1' }, { id: 'g2' }]);
});

afterAll(async () => {
  await t.drop();
});

describe('app role grants', () => {
  it('can read but not change core.guilds, which has no RLS', async () => {
    const app = t.database.appPool;
    const { rows } = await app.query('select id from core.guilds order by id');
    expect(rows.map((row) => row.id)).toEqual(['g1', 'g2']);
    await expect(app.query(`insert into core.guilds (id) values ('g3')`)).rejects.toThrow(/permission denied/);
    await expect(app.query(`update core.guilds set left_at = now()`)).rejects.toThrow(/permission denied/);
    await expect(app.query('delete from core.guilds')).rejects.toThrow(/permission denied/);
    await expect(app.query('truncate core.guilds cascade')).rejects.toThrow(/permission denied/);
    expect(await t.database.admin.select().from(guilds)).toHaveLength(2);
  });

  it('can write guild rows that reference core.guilds', async () => {
    await widgetsDb(t.database, 'g1').run((tx) => tx.insert(widgetItems).values({ id: 'w1', label: 'W' }));
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'w1'));
    expect(row?.guildId).toBe('g1');
  });

  it('can manage core.guild_modules within its guild', async () => {
    const scoped = createScopedDb(t.database.app, 'g1');
    await scoped.run((tx) => tx.insert(guildModules).values({ module: 'widgets', enabled: true }));
    await scoped.run((tx) => tx.update(guildModules).set({ enabled: false }).where(eq(guildModules.module, 'widgets')));
    expect(await scoped.run((tx) => tx.select().from(guildModules))).toMatchObject([
      { guildId: 'g1', module: 'widgets', enabled: false },
    ]);
    await scoped.run((tx) => tx.delete(guildModules));
    expect(await t.database.admin.select().from(guildModules)).toEqual([]);
  });

  it('lets a module role write its own global tables', async () => {
    await widgetsDb(t.database, 'g1').run((tx) => tx.insert(widgetCatalog).values({ id: 'c1', label: 'C' }));
    expect(await t.database.admin.select().from(widgetCatalog)).toHaveLength(1);
  });

  it('keeps core global tables read-only for module roles', async () => {
    const error = await widgetsDb(t.database, 'g1')
      .run((tx) => tx.insert(guilds).values({ id: 'g9' }))
      .catch((e: unknown) => e);
    expect(errorText(error)).toMatch(/permission denied/);
  });

  it('gives a module role use but not alteration of its tables', async () => {
    const asWidgets = (statement: string) => asModuleRole(t.database, 'widgets', (tx) => tx.execute(sql.raw(statement)));
    await expect(asWidgets('select count(*) from widgets.items')).resolves.toBeDefined();
    const error = await asWidgets('drop table widgets.items').catch((caught: unknown) => caught);
    expect(errorText(error)).toMatch(/must be owner/);
  });

  it('gives the app role no access to module schemas', async () => {
    await expect(t.database.appPool.query('select count(*) from widgets.items')).rejects.toThrow(/permission denied/);
    const { rows } = await t.database.adminPool.query<{ usage: boolean }>(
      `select has_schema_privilege($1, 'widgets', 'USAGE') as "usage"`,
      [t.database.appRole],
    );
    expect(rows[0]!.usage).toBe(false);
  });
});
