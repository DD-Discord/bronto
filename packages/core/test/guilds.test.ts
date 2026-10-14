import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteGuildRow, guildsDueForPurge, markGuildLeft, upsertGuild } from '../src/db/guilds.js';
import { guildModules, guilds } from '../src/db/schema.js';
import { widgetItems } from './fixtures/widgets/schema.js';
import { createTestDatabase, setUpSchema, type TestDatabase } from './test-db.js';

const DAY = 86_400_000;
let t: TestDatabase;

async function leftAt(id: string): Promise<Date | null | undefined> {
  const [row] = await t.database.admin.select().from(guilds).where(eq(guilds.id, id));
  return row?.leftAt;
}

beforeAll(async () => {
  t = await createTestDatabase();
  await setUpSchema(t.database);
});

afterAll(async () => {
  await t.drop();
});

describe('guild lifecycle', () => {
  it('creates a guild once and clears left_at when it comes back', async () => {
    await upsertGuild(t.database.admin, 'g1');
    await markGuildLeft(t.database.admin, 'g1', new Date());
    expect(await leftAt('g1')).toBeInstanceOf(Date);
    await upsertGuild(t.database.admin, 'g1');
    expect(await leftAt('g1')).toBeNull();
    expect(await t.database.admin.select().from(guilds).where(eq(guilds.id, 'g1'))).toHaveLength(1);
  });

  it('ignores leaving an unknown guild', async () => {
    await expect(markGuildLeft(t.database.admin, 'unknown')).resolves.toBeUndefined();
  });

  it('finds guilds whose grace period has passed', async () => {
    const now = new Date('2026-10-14T12:00:00Z');
    for (const id of ['old', 'exact', 'recent', 'active']) await upsertGuild(t.database.admin, id);
    await markGuildLeft(t.database.admin, 'old', new Date(now.getTime() - 31 * DAY));
    await markGuildLeft(t.database.admin, 'exact', new Date(now.getTime() - 30 * DAY));
    await markGuildLeft(t.database.admin, 'recent', new Date(now.getTime() - 29 * DAY));
    expect(await guildsDueForPurge(t.database.admin, now)).toEqual(['exact', 'old']);
  });

  it('deletes a guild and everything that references it', async () => {
    await upsertGuild(t.database.admin, 'gone');
    await t.database.admin.insert(widgetItems).values({ id: 'w-gone', guildId: 'gone', label: 'x' });
    await t.database.admin.insert(guildModules).values({ guildId: 'gone', module: 'widgets', enabled: true });
    await deleteGuildRow(t.database.admin, 'gone');
    expect(await t.database.admin.select().from(guilds).where(eq(guilds.id, 'gone'))).toEqual([]);
    expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.guildId, 'gone'))).toEqual([]);
    expect(await t.database.admin.select().from(guildModules).where(eq(guildModules.guildId, 'gone'))).toEqual([]);
  });
});
