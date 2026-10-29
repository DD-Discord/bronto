import { UserError } from '@bronto/core';
import { createNativeTestClient, FakeDiscordHttp } from '@bronto/core/testing';
import type { GuildTextBasedChannel } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGES } from '../src/limits.js';
import { parseMessageLink, readRange } from '../src/range.js';
import { addHistory, addMoveFixtures, SOURCE } from './harness.js';

const ID = ['100000000000000001', '100000000000000002', '100000000000000003'] as const;

describe('parseMessageLink', () => {
  it('parses discord, ptb, canary and discordapp links', () => {
    const expected = { guildId: ID[0], channelId: ID[1], messageId: ID[2] };
    for (const host of ['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com', 'ptb.discordapp.com']) {
      expect(parseMessageLink(`https://${host}/channels/${ID.join('/')}`)).toEqual(expected);
    }
    expect(parseMessageLink(`  https://discord.com/channels/${ID.join('/')}\n`)).toEqual(expected);
  });

  it('rejects other hosts, @me and malformed ids', () => {
    for (const link of [
      `https://example.com/channels/${ID.join('/')}`,
      `https://notdiscord.com/channels/${ID.join('/')}`,
      `https://discord.com.evil.test/channels/${ID.join('/')}`,
      `http://discord.com/channels/${ID.join('/')}`,
      `https://discord.com/channels/@me/${ID[1]}/${ID[2]}`,
      `https://discord.com/channels/${ID[0]}/${ID[1]}`,
      `https://discord.com/channels/${ID[0]}/abc/${ID[2]}`,
      `https://discord.com/channels/${ID[0]}/${ID[1]}/${ID[2]}x`,
      `see https://discord.com/channels/${ID.join('/')}`,
      '',
    ]) {
      expect(parseMessageLink(link), link).toBeNull();
    }
  });
});

describe('readRange', () => {
  let discord: FakeDiscordHttp;
  let channel: GuildTextBasedChannel;

  beforeEach(async () => {
    discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    const { client } = await createNativeTestClient(discord);
    channel = (await client.channels.fetch(SOURCE)) as GuildTextBasedChannel;
  });

  const fill = (count: number) => addHistory(discord, SOURCE, Array.from({ length: count }, (_, index) => ({ content: `m${index}` })));
  const idsOf = async (from: string, to: string | null) => (await readRange(channel, from, to)).map((message) => message.id);

  it('reads an inclusive range oldest first across pages', async () => {
    const ids = fill(250);
    expect(await idsOf(ids[50]!, ids[199]!)).toEqual(ids.slice(50, 200));
  });

  it('reads a single message without to', async () => {
    const ids = fill(5);
    expect(await idsOf(ids[2]!, null)).toEqual([ids[2]]);
  });

  it('orders reversed from/to', async () => {
    const ids = fill(5);
    expect(await idsOf(ids[3]!, ids[1]!)).toEqual(ids.slice(1, 4));
  });

  it('same from and to is one message', async () => {
    const ids = fill(5);
    expect(await idsOf(ids[2]!, ids[2]!)).toEqual([ids[2]]);
  });

  it('reads exactly the cap and refuses more than 200', async () => {
    const ids = fill(MAX_MESSAGES + 5);
    expect(await idsOf(ids[0]!, ids[MAX_MESSAGES - 1]!)).toHaveLength(MAX_MESSAGES);
    const error = await readRange(channel, ids[0]!, ids[MAX_MESSAGES]!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toContain('200');
  });

  it('refuses a missing end message', async () => {
    const ids = fill(5);
    const missing = String(BigInt(ids[2]!) + 1n);
    for (const [from, to] of [[missing, null], [missing, ids[4]!], [ids[0]!, missing], [ids[0]!, String(BigInt(ids[4]!) + 1_000_000n)]] as const) {
      await expect(readRange(channel, from, to)).rejects.toThrow("That message doesn't exist.");
    }
  });
});
