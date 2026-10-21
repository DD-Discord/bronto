import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { CHANNEL, GUILD, insertSticky, prepareStickyBot, QUIET_CHANNEL, ready, stickyRows, type StickyBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let sb: StickyBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  await sb.bot.stop();
  await t.drop();
});

async function templateRows(): Promise<{ id: string; name: string; content: string; embed: unknown }[]> {
  return (await t.database.adminPool.query('select id, name, content, embed from templates.templates order by name')).rows;
}

describe('moving stickies to templates', () => {
  it('adopts a legacy sticky into a template in a newly created forum', async () => {
    sb = await prepareStickyBot(t, discord);
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL, content: 'Hello', embeds: [{ title: 'Rules' }] });
    await ready(sb);
    const rows = await templateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: sticky.templateId, content: 'Hello', embed: { title: 'Rules' } });
    expect(rows[0]!.name).toMatch(/^Sticky #\S+$/);
    expect((await t.database.adminPool.query('select count(*)::int as n from templates.forums')).rows[0].n).toBe(1);
    expect(await stickyRows(t)).toMatchObject([{ channelId: CHANNEL, templateId: sticky.templateId, content: null, embeds: null }]);
  });

  it('reuses the template when an earlier run created it but did not clear the columns', async () => {
    sb = await prepareStickyBot(t, discord);
    await insertSticky(t, discord, { channelId: CHANNEL, content: 'Hello', embeds: [] });
    await sb.bot.start();
    sb.native.ready();
    await sb.bot.idle();
    // Undo the clearing the first start did, as if the process died right after the create.
    await t.database.adminPool.query("update sticky.stickies set content = 'Hello', embeds = '[]'");
    const runtime = sb.bot.runtimes.find((entry) => entry.name === 'sticky')!;
    const { adoptLegacyStickies } = await import('../src/migrate.js');
    const adopted = await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', async (ctx) => adoptLegacyStickies(ctx as never));
    expect(adopted.ok).toBe(true);
    expect(await templateRows()).toHaveLength(1);
    expect(await stickyRows(t)).toMatchObject([{ content: null, embeds: null }]);
  });

  it('keeps the stored copy and warns when the template cannot be created', async () => {
    sb = await prepareStickyBot(t, discord);
    discord.addGuild(GUILD, { community: false });
    await insertSticky(t, discord, { channelId: CHANNEL, content: 'Hello', embeds: [] });
    await ready(sb);
    expect(await templateRows()).toEqual([]);
    expect(await stickyRows(t)).toMatchObject([{ content: 'Hello', embeds: [] }]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 40, channelId: CHANNEL, err: expect.anything() }));
  });

  it('moves every sticky and logs the extra embeds it drops', async () => {
    sb = await prepareStickyBot(t, discord);
    await insertSticky(t, discord, { channelId: CHANNEL, content: 'A', embeds: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] });
    await insertSticky(t, discord, { channelId: QUIET_CHANNEL, content: 'B', embeds: [] });
    await ready(sb);
    expect(await templateRows()).toHaveLength(2);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 30, channelId: CHANNEL, dropped: 2 }));
    expect((await templateRows()).find((row) => row.content === 'A')?.embed).toEqual({ title: 'One' });
  });
});
