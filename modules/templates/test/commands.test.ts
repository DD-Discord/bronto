import { fakeCommand, FakeDiscordHttp } from '@bronto/core/testing';
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forums, templates } from '../src/db/schema.js';
import { createTemplatesModule } from '../src/index.js';
import { FORUM, GUILD, prepareTemplatesBot, ready, templatesDb, USER, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let tb: TemplatesBot;

interface Reply {
  content: string;
  ephemeral: boolean;
}

async function list(): Promise<Reply[]> {
  const fake = fakeCommand({ command: 'templates', subcommand: 'list', guildId: GUILD, channelId: FORUM, userId: USER, options: {} });
  tb.client.emit(Events.InteractionCreate, fake);
  await tb.bot.idle();
  return fake.responses.map((response) => {
    const payload = response.payload as { content?: string; flags?: number };
    return { content: payload.content ?? '', ephemeral: ((payload.flags ?? 0) & MessageFlags.Ephemeral) !== 0 };
  });
}

async function seed(names: string[], withForum = true): Promise<void> {
  await templatesDb(t).run(async (tx) => {
    if (withForum) await tx.insert(forums).values({ forumChannelId: FORUM });
    if (names.length === 0) return;
    await tx.insert(templates).values(names.map((name, index) => ({ name, threadId: String(200000000000000000n + BigInt(index)), previewMessageId: '1' })));
  });
}

const link = (name: string, index: number) => `[${name}](https://discord.com/channels/${GUILD}/${200000000000000000n + BigInt(index)})`;

beforeEach(async () => {
  t = await createTestDatabase();
  tb = await prepareTemplatesBot(t, new FakeDiscordHttp());
  await ready(tb);
});

afterEach(async () => {
  await tb.bot.stop();
  await t.drop();
});

describe('/templates list', () => {
  it('lists templates by name, ignoring case, as an ephemeral reply', async () => {
    await seed(['beta', 'Alpha', 'Charlie']);
    expect(await list()).toEqual([{ content: [link('Alpha', 1), link('beta', 0), link('Charlie', 2)].join('\n'), ephemeral: true }]);
  });

  it('escapes characters that break links', async () => {
    await seed(['a [b] (c) \\d']);
    const [reply] = await list();
    expect(reply!.content).toBe(`[a \\[b\\] \\(c\\) \\\\d](https://discord.com/channels/${GUILD}/200000000000000000)`);
  });

  it('points to the forum when there are no templates', async () => {
    await seed([]);
    expect(await list()).toEqual([{ content: `No templates yet. Create a post in <#${FORUM}>.`, ephemeral: true }]);
  });

  it('points to /templates init when the server has no forum', async () => {
    expect(await list()).toEqual([{ content: 'No templates yet. Run /templates init to create the template forum.', ephemeral: true }]);
  });

  it('ends with the number of templates left out', async () => {
    const names = Array.from({ length: 53 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    await seed(names);
    const [reply] = await list();
    const lines = reply!.content.split('\n');
    const shown = lines.length - 1;
    expect(reply!.content.length).toBeLessThanOrEqual(2000);
    expect(lines[0]).toBe(link('t00', 0));
    expect(lines[shown - 1]).toBe(link(names[shown - 1]!, shown - 1));
    expect(lines[shown]).toBe(`…and ${53 - shown} more`);
  });

  it('stays under the 2000 character limit with long names', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(98)}`);
    await seed(names);
    const [reply] = await list();
    expect(reply!.content.length).toBeLessThanOrEqual(2000);
    const lines = reply!.content.split('\n');
    const shown = lines.length - 1;
    expect(shown).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe(`…and ${50 - shown} more`);
    expect(lines[0]).toBe(link(names[0]!, 0));
  });
});

describe('module permissions', () => {
  it('declares the bot permissions the module needs', () => {
    expect(createTemplatesModule().botPermissions).toEqual([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.EmbedLinks,
    ]);
  });
});
