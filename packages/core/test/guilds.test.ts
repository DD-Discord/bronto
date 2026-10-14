import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteGuildRow, guildsDueForPurge, markGuildLeft, purgeGuildIfDue, upsertGuild } from '../src/db/guilds.js';
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

  describe('purgeGuildIfDue', () => {
    const now = new Date('2026-10-14T12:00:00Z');

    it('deletes a guild whose grace period has passed', async () => {
      await upsertGuild(t.database.admin, 'due');
      await t.database.admin.insert(widgetItems).values({ id: 'w-due', guildId: 'due', label: 'x' });
      await markGuildLeft(t.database.admin, 'due', new Date(now.getTime() - 30 * DAY));
      expect(await purgeGuildIfDue(t.database.admin, 'due', now)).toBe(true);
      expect(await leftAt('due')).toBeUndefined();
      expect(await t.database.admin.select().from(widgetItems).where(eq(widgetItems.guildId, 'due'))).toEqual([]);
    });

    it('keeps a guild that came back after it was found due', async () => {
      await upsertGuild(t.database.admin, 'back');
      await markGuildLeft(t.database.admin, 'back', new Date(now.getTime() - 31 * DAY));
      expect(await guildsDueForPurge(t.database.admin, now)).toContain('back');
      await upsertGuild(t.database.admin, 'back');
      expect(await purgeGuildIfDue(t.database.admin, 'back', now)).toBe(false);
      expect(await leftAt('back')).toBeNull();
    });

    it('keeps a guild that left recently', async () => {
      await upsertGuild(t.database.admin, 'fresh');
      await markGuildLeft(t.database.admin, 'fresh', new Date(now.getTime() - 29 * DAY));
      expect(await purgeGuildIfDue(t.database.admin, 'fresh', now)).toBe(false);
      expect(await leftAt('fresh')).toBeInstanceOf(Date);
    });
  });
});
