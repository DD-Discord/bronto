import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterCommit } from '../src/db/context.js';
import { guilds } from '../src/db/schema.js';
import { createScopedDb } from '../src/db/scoped.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, errorText, setUpSchema, type TestDatabase } from './test-db.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
  await t.database.admin.insert(guilds).values([{ id: 'g1' }, { id: 'g2' }]);
  await t.database.admin.insert(widgetItems).values([
    { id: 'a1', guildId: 'g1', label: 'A1' },
    { id: 'b1', guildId: 'g2', label: 'B1' },
  ]);
});

afterAll(async () => {
  await t.drop();
});

const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

describe('createScopedDb', () => {
  it('only sees rows of its guild', async () => {
    const rows = await createScopedDb(t.database.app, 'g1').run((tx) => tx.select().from(widgetItems));
    expect(ids(rows)).toEqual(['a1']);
  });

  it('switches guild with forGuild', async () => {
    const rows = await createScopedDb(t.database.app, 'g1')
      .forGuild('g2')
      .run((tx) => tx.select().from(widgetItems));
    expect(ids(rows)).toEqual(['b1']);
  });

  it('fills guild_id from the scope on insert', async () => {
    await createScopedDb(t.database.app, 'g1').run((tx) => tx.insert(widgetItems).values({ id: 'a2', label: 'A2' }));
    const [row] = await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'a2'));
    expect(row?.guildId).toBe('g1');
  });

  it('rejects writes for another guild', async () => {
    const error = await createScopedDb(t.database.app, 'g1')
      .run((tx) => tx.insert(widgetItems).values({ id: 'x1', guildId: 'g2', label: 'X' }))
      .catch((caught: unknown) => caught);
    expect(errorText(error)).toMatch(/row-level security/);
  });

  it('sees nothing and cannot write without a guild', async () => {
    expect(await t.database.app.select().from(widgetItems)).toEqual([]);
    const error = await t.database.app
      .insert(widgetItems)
      .values({ id: 'x2', guildId: 'g1', label: 'X' })
      .catch((caught: unknown) => caught);
    expect(errorText(error)).toMatch(/row-level security/);
  });

  it('rolls back the whole run when it throws', async () => {
    await expect(
      createScopedDb(t.database.app, 'g1').run(async (tx) => {
        await tx.insert(widgetItems).values({ id: 'a3', label: 'A3' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.id, 'a3'))).toEqual([]);
  });

  it('does not leak the guild to the next use of a connection', async () => {
    const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
    try {
      await createScopedDb(drizzle({ client: pool }), 'g1').run((tx) => tx.select().from(widgetItems));
      const { rows } = await pool.query(`select current_setting('app.guild_id', true) as value`);
      expect([null, '']).toContain(rows[0].value);
    } finally {
      await pool.end();
    }
  });

  it('clears pending events between transactions', async () => {
    const delivered: string[] = [];
    const db = createScopedDb(t.database.app, 'g1');
    await db.run(async () => afterCommit(() => delivered.push('first')));
    await db
      .run(async () => {
        afterCommit(() => delivered.push('rolled back'));
        throw new Error('x');
      })
      .catch(() => undefined);
    await db.run(async () => afterCommit(() => delivered.push('third')));
    expect(delivered).toEqual(['first', 'third']);
  });

  it('delivers at once outside a transaction', () => {
    const delivered: string[] = [];
    afterCommit(() => delivered.push('now'));
    expect(delivered).toEqual(['now']);
  });
});
