import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guildModules, guilds } from '../src/db/schema.js';
import { createScopedDb } from '../src/db/scoped.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

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
    await createScopedDb(t.database.app, 'g1').run((tx) => tx.insert(widgetItems).values({ id: 'w1', label: 'W' }));
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

  it('can use but not alter module tables', async () => {
    await expect(t.database.appPool.query('drop table widgets.items')).rejects.toThrow(/must be owner/);
  });
});
