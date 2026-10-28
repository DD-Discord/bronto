import { FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { CHANNEL, channelOption, createTemplate, OTHER_CHANNEL, prepareAutothreadBot, ready, ruleRows, runCommand, USER, type AutothreadBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let ab: AutothreadBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  ab = await prepareAutothreadBot(t, discord);
  await ready(ab);
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});

interface Payload {
  content?: string;
  embeds?: { toJSON(): unknown }[];
}
const payloads = (fake: FakeInteraction) => fake.responses.map((response) => response.payload as Payload);
const contents = (fake: FakeInteraction) => payloads(fake).map((payload) => payload.content);
const embedJson = (fake: FakeInteraction) => JSON.stringify(payloads(fake).flatMap((payload) => payload.embeds ?? []).map((embed) => embed.toJSON()));
const say = (subcommand: string, options: Record<string, unknown> = {}, channelId = CHANNEL) => runCommand(ab, 'autothread', subcommand, options, channelId);

type CommandJson = { name: string; options: { name: string; options?: { name: string; channel_types?: number[] }[] }[] };
const channelTypesOf = (subcommand: string) => {
  const registered = (ab.requests.findLast((r) => r.method === 'PUT' && r.path.endsWith('/commands'))!.body as CommandJson[]).find((c) => c.name === 'autothread')!;
  return registered.options.find((o) => o.name === subcommand)!.options!.find((o) => o.name === 'channel')!.channel_types!.sort((a, b) => a - b);
};

describe('/autothread set', () => {
  it('creates with defaults', async () => {
    expect(contents(await say('set'))).toEqual(['**Autothread rule created.**']);
    expect(await ruleRows(t)).toEqual([
      expect.objectContaining({
        channelId: CHANNEL,
        enabled: true,
        ignoreBots: true,
        nameFormat: '[Comments] {user.display}',
        slowmodeSeconds: 0,
        templateId: null,
        rename: false,
        createdBy: USER,
      }),
    ]);
  });

  it('stores the options and changes only the ones given', async () => {
    await say('set', { 'name-format': 'Talk: {user.name}', slowmode: '1m 30s', rename: true });
    expect(await ruleRows(t)).toEqual([expect.objectContaining({ nameFormat: 'Talk: {user.name}', slowmodeSeconds: 90, rename: true })]);
    expect(contents(await say('set', { 'ignore-bots': false, enabled: false }))).toEqual(['**Autothread rule updated.**']);
    expect(await ruleRows(t)).toEqual([
      expect.objectContaining({ nameFormat: 'Talk: {user.name}', slowmodeSeconds: 90, rename: true, ignoreBots: false, enabled: false }),
    ]);
    await say('set', { slowmode: '0s' });
    expect((await ruleRows(t))[0]!.slowmodeSeconds).toBe(0);
  });

  it('refuses a slowmode over six hours and a name format over 100 characters', async () => {
    expect(contents(await say('set', { slowmode: '7h' }))[0]).toContain('between');
    expect(await ruleRows(t)).toEqual([]);
    const registered = (ab.requests.findLast((r) => r.method === 'PUT' && r.path.endsWith('/commands'))!.body as {
      name: string;
      options: { name: string; options?: { name: string; max_length?: number }[] }[];
    }[]).find((c) => c.name === 'autothread')!;
    const option = registered.options.find((o) => o.name === 'set')!.options!.find((o) => o.name === 'name-format')!;
    expect(option.max_length).toBe(100);
  });

  it('sets another channel', async () => {
    await say('set', { channel: channelOption(OTHER_CHANNEL) });
    expect((await ruleRows(t)).map((row) => row.channelId)).toEqual([OTHER_CHANNEL]);
  });

  it('set with an unknown template is refused', async () => {
    const reply = await say('set', { 'auto-message': '00000000-0000-4000-8000-000000000000' });
    expect(contents(reply)).toEqual(["That template doesn't exist."]);
    expect(await ruleRows(t)).toEqual([]);
  });

  it('stores the template, then remove-auto-message clears it', async () => {
    const template = await createTemplate(ab, 'Welcome', 'Hi');
    await say('set', { 'auto-message': template });
    expect((await ruleRows(t))[0]!.templateId).toBe(template);
    expect(embedJson(await say('show'))).toContain('Welcome');
    expect(contents(await say('set', { 'remove-auto-message': true }))).toEqual(['**Autothread rule updated.**']);
    expect((await ruleRows(t))[0]!.templateId).toBeNull();
    await say('set', { 'auto-message': template });
    await say('set', { 'remove-auto-message': false, rename: true });
    expect((await ruleRows(t))[0]!.templateId).toBe(template);
  });

  it('refuses a template and its removal together', async () => {
    const template = await createTemplate(ab, 'Welcome', 'Hi');
    expect(contents(await say('set', { 'auto-message': template, 'remove-auto-message': true }))[0]).toContain('not both');
    expect(await ruleRows(t)).toEqual([]);
  });

  it('refuses threads and forums', () => {
    for (const subcommand of ['set', 'show', 'remove']) {
      const types = channelTypesOf(subcommand);
      expect(types).toEqual([ChannelType.GuildText, ChannelType.GuildAnnouncement].sort((a, b) => a - b));
    }
  });
});

describe('show, list and remove', () => {
  it('shows the options', async () => {
    await say('set', { slowmode: '30s', rename: true });
    const shown = embedJson(await say('show'));
    expect(shown).toContain('[Comments] {user.display}');
    expect(shown).toContain('30s');
  });

  it('lists the rules', async () => {
    await say('set');
    await say('set', { channel: channelOption(OTHER_CHANNEL) });
    const listed = contents(await say('list')).join('\n');
    expect(listed).toContain(`<#${CHANNEL}>`);
    expect(listed).toContain(`<#${OTHER_CHANNEL}>`);
  });

  it('removes the rule so that posts get no thread', async () => {
    await say('set');
    expect(contents(await say('remove'))[0]).toContain('deleted');
    expect(await ruleRows(t)).toEqual([]);
    expect(contents(await say('show'))[0]).toContain('no');
  });
});
