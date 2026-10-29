import { UserError } from '@bronto/core';
import { createNativeTestClient, FakeDiscordHttp, type RecordedRequest } from '@bronto/core/testing';
import type { GuildTextBasedChannel } from 'discord.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGES } from '../src/limits.js';
import { parseMessageLink, readRange } from '../src/range.js';
import { addHistory, addMoveFixtures, SOURCE } from './harness.js';

const sortedAscending = (ids: string[]) => ids.every((id, index) => index === 0 || BigInt(id) > BigInt(ids[index - 1]!));

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
  let requests: RecordedRequest[];

  beforeEach(async () => {
    discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    const native = await createNativeTestClient(discord);
    const { client } = native;
    requests = native.requests;
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

  const pagesRead = () => requests.filter((request) => request.method === 'GET' && request.path.endsWith(`/channels/${SOURCE}/messages`)).length;

  it('stops reading once the cap is exceeded', async () => {
    const ids = fill(1000);
    await readRange(channel, ids[0]!, ids[999]!).catch(() => undefined);
    expect(pagesRead()).toBe(3);
  });

  it('stops reading after the end of the range', async () => {
    const ids = fill(1000);
    expect(await idsOf(ids[10]!, ids[40]!)).toHaveLength(31);
    expect(pagesRead()).toBe(1);
  });
});

describe('addHistory', () => {
  it('keeps ids increasing across calls', () => {
    const discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    const all = [...addHistory(discord, SOURCE, [{}, {}, {}]), ...addHistory(discord, SOURCE, [{}, {}]), ...addHistory(discord, SOURCE, [{}])];
    expect(sortedAscending(all)).toBe(true);
  });

  it('puts old messages first and rejects an old one after a fresh one', () => {
    const discord = new FakeDiscordHttp();
    addMoveFixtures(discord);
    const first = addHistory(discord, SOURCE, [{ old: true }, { old: true }, {}, {}]);
    const second = addHistory(discord, SOURCE, [{ old: true }, {}]);
    expect(sortedAscending(first)).toBe(true);
    expect(BigInt(second[0]!)).toBeLessThan(BigInt(first[2]!));
    expect(() => addHistory(discord, SOURCE, [{}, { old: true }])).toThrow('old messages must come before');
  });
});
