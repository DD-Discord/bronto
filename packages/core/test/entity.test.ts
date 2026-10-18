import type { Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { entityAutocomplete, defineEntity } from '../src/crud/entity.js';
import { upsertGuild } from '../src/db/guilds.js';
import { createModuleRuntimes } from '../src/runtime/context.js';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { ModuleEnablement } from '../src/runtime/enablement.js';
import { KeyedQueue } from '../src/runtime/queue.js';
import { captureLog } from '../src/testing/log.js';
import { widgetsModule } from './fixtures/widgets/module.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, widgetsDb, type TestDatabase } from './test-db.js';

let t: TestDatabase;

const widgets = defineEntity({
  table: widgetItems,
  key: 'id',
  displayName: { singular: 'Widget', plural: 'Widgets' },
  formatShort: (widget) => `**${widget.label}**`,
});

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await upsertGuild(t.database.admin, 'g1');
  await upsertGuild(t.database.admin, 'g2');
  const g1 = widgetsDb(t.database, 'g1');
  for (const [id, label] of [['b', 'Banana'], ['a', 'Apple'], ['c', 'Cherry']] as const) {
    await g1.run(async (tx) => {
      await tx.insert(widgetItems).values({ id, label });
    });
  }
  await widgetsDb(t.database, 'g2').run(async (tx) => {
    await tx.insert(widgetItems).values({ id: 'x', label: 'Apricot' });
  });
});

afterAll(async () => {
  await t.drop();
});

describe('entity data access', () => {
  it('finds one record of the guild', async () => {
    const g1 = widgetsDb(t.database, 'g1');
    expect((await widgets.find(g1, 'a'))?.label).toBe('Apple');
    expect(await widgets.find(g1, 'x')).toBeNull();
  });

  it('lists the guild records in creation order', async () => {
    const rows = await widgets.list(widgetsDb(t.database, 'g1'));
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('suggests matching records of the guild by label', async () => {
    const runtimes = createModuleRuntimes([{ packageName: '@test/widgets', definition: widgetsModule(), config: {} }], {
      client: {} as Client,
      database: t.database,
      log: captureLog().log,
    });
    const dispatcher = new Dispatcher({
      runtimes,
      database: t.database,
      enablement: new ModuleEnablement(t.database.admin),
      queue: new KeyedQueue(() => undefined),
    });
    const suggest = entityAutocomplete(widgets);
    let choices: unknown;
    await dispatcher.runHandler(runtimes[0]!, 'g1', 'u1', 'test', async (ctx) => {
      choices = await suggest(ctx, 'AP');
    });
    expect(choices).toEqual([{ name: 'Apple', value: 'a' }]);
    await dispatcher.runHandler(runtimes[0]!, 'g1', 'u1', 'test', async (ctx) => {
      choices = await suggest(ctx, '');
    });
    expect(choices).toEqual([
      { name: 'Apple', value: 'a' },
      { name: 'Banana', value: 'b' },
      { name: 'Cherry', value: 'c' },
    ]);
  });
});
