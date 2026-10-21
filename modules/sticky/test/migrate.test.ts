import { defineModule } from '@bronto/core';
import type { TemplatesApi } from '@bronto/templates';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { createStickyModule } from '../src/index.js';
import { CHANNEL, GUILD, insertSticky, prepareStickyBot, QUIET_CHANNEL, ready, setState, stickyRows, type StickyBot } from './harness.js';

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

// Runs its guildReady after sticky's, so it shows when sticky let the guild start.
let probeReady = false;
const probe = defineModule({
  name: 'probe',
  dependsOn: [createStickyModule()],
  hooks: {
    guildReady: (ctx) => {
      if (ctx.guildId === GUILD) probeReady = true;
    },
  },
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

  it('moves stickies in the background, so a slow Discord does not hold the guild', async () => {
    probeReady = false;
    sb = await prepareStickyBot(t, discord, { extra: [{ packageName: '@test/probe', definition: probe, config: {} }] });
    await insertSticky(t, discord, { channelId: CHANNEL, content: 'Hello', embeds: [] });
    const held = Promise.withResolvers<void>();
    const path = `/guilds/${GUILD}/channels`;
    discord.override('POST', path, async (request) => {
      await held.promise;
      discord.clearOverride('POST', path);
      return discord.answer(request);
    });
    try {
      await sb.bot.start();
      sb.native.ready();
      await vi.waitFor(() => expect(probeReady).toBe(true));
      expect(await templateRows()).toEqual([]);
    } finally {
      held.resolve();
    }
    await sb.bot.idle();
    expect(await templateRows()).toHaveLength(1);
    expect(await stickyRows(t)).toMatchObject([{ channelId: CHANNEL, content: null, embeds: null }]);
  });
});

describe('stickies whose template is gone', () => {
  it('deletes them at start-up, with their post, and keeps stickies whose template exists', async () => {
    sb = await prepareStickyBot(t, discord);
    // Its template was deleted while sticky was switched off.
    const orphan = await insertSticky(t, discord, { channelId: CHANNEL, content: null, embeds: null });
    const post = '100000000000009001';
    discord.addMessage(CHANNEL, post, { content: 'old sticky', webhookId: orphan.webhookId });
    await setState(t, CHANNEL, { lastMessageId: post });
    await insertSticky(t, discord, { channelId: QUIET_CHANNEL, content: 'Hello', embeds: [] });
    await ready(sb);
    expect(await stickyRows(t)).toMatchObject([{ channelId: QUIET_CHANNEL, content: null, embeds: null }]);
    expect(await templateRows()).toHaveLength(1);
    expect(discord.messages.has(post)).toBe(false);
    expect(discord.webhooks.has(orphan.webhookId)).toBe(false);
    expect(sb.lines).toContainEqual(
      expect.objectContaining({ level: 30, msg: 'Deleted a sticky whose template was deleted', channelId: CHANNEL, templateId: orphan.templateId }),
    );
  });

  it('keeps a sticky and warns when looking up its template fails', async () => {
    sb = await prepareStickyBot(t, discord);
    const sticky = await insertSticky(t, discord, { channelId: CHANNEL, content: null, embeds: null });
    const api = sb.bot.runtimes.find((entry) => entry.name === 'templates')!.api as TemplatesApi;
    vi.spyOn(api, 'get').mockRejectedValue(new Error('database down'));
    await ready(sb);
    expect(await stickyRows(t)).toMatchObject([{ channelId: CHANNEL, templateId: sticky.templateId }]);
    expect(sb.lines).toContainEqual(expect.objectContaining({ level: 40, channelId: CHANNEL, templateId: sticky.templateId, err: expect.anything() }));
  });
});
