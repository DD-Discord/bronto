import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInScope } from '../src/db/context.js';
import { guilds } from '../src/db/schema.js';
import type { ScopedDb } from '../src/db/scoped.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, widgetsDb, type TestDatabase } from './test-db.js';

let t: TestDatabase;
let scoped: ScopedDb;

async function read(id: string) {
  const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, id));
  if (!row) throw new Error(`row ${id} not found`);
  return row;
}

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values({ id: 'g1' });
  scoped = widgetsDb(t.database, 'g1');
});

afterAll(async () => {
  await t.drop();
});

describe('audit columns', () => {
  it('record the acting user on insert', async () => {
    await runInScope({ actorId: 'u1' }, () =>
      scoped.run((tx) => tx.insert(widgetItems).values({ id: 'i1', label: 'one' })),
    );
    const row = await read('i1');
    expect(row.createdBy).toBe('u1');
    expect(row.updatedBy).toBe('u1');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('record the updater and change updated_at on update', async () => {
    const before = await read('i1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runInScope({ actorId: 'u2' }, () =>
      scoped.run((tx) => tx.update(widgetItems).set({ label: 'two' }).where(eq(widgetItems.id, 'i1'))),
    );
    const after = await read('i1');
    expect(after.createdBy).toBe('u1');
    expect(after.updatedBy).toBe('u2');
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.updatedAt.getTime()).not.toBe(before.updatedAt.getTime());
  });

  it('use null when no user is acting', async () => {
    await scoped.run((tx) => tx.update(widgetItems).set({ label: 'three' }).where(eq(widgetItems.id, 'i1')));
    expect((await read('i1')).updatedBy).toBeNull();
  });

  it('apply on upsert', async () => {
    await runInScope({ actorId: 'u3' }, () =>
      scoped.run((tx) =>
        tx
          .insert(widgetItems)
          .values({ id: 'i1', label: 'four' })
          .onConflictDoUpdate({ target: widgetItems.id, set: { label: 'four' } }),
      ),
    );
    const row = await read('i1');
    expect(row.label).toBe('four');
    expect(row.createdBy).toBe('u1');
    expect(row.updatedBy).toBe('u3');
  });

  it('apply to core tables too', async () => {
    await runInScope({ actorId: 'u9' }, async () => {
      await t.database.admin.insert(guilds).values({ id: 'g9' });
    });
    const [guild] = await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g9'));
    expect(guild?.createdBy).toBe('u9');
  });
});
