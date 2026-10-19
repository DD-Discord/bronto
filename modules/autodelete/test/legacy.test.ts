import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLegacyImport } from '@bronto/core';
import { SnowflakeUtil } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { FakeAutodeleteDiscord } from './fake-discord.js';
import { GUILD, LOG_THREAD, cooldownRows, postRows, prepareAutodeleteBot, ruleRows, type AutodeleteBot } from './harness.js';

// Made-up files in the older bot's layout; no real server data.
const FIXTURES = new URL('./fixtures/legacy/', import.meta.url);
const CHANNEL_A = '100000000000000210';
const CHANNEL_B = '100000000000000220';
const CHANNEL_C = '100000000000000230';
const WEBHOOK_CHANNEL = '100000000000000211';
const TEXT = 'Hello, I like gardening';
const NAME = 'Fixture Member';

let t: TestDatabase;
let discord: FakeAutodeleteDiscord;
let ab: AutodeleteBot;
let dir: string;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeAutodeleteDiscord();
  ab = await prepareAutodeleteBot(t, discord);
  dir = await mkdtemp(join(tmpdir(), 'autodelete-legacy-'));
  await cp(FIXTURES, dir, { recursive: true });
  // The fixture's webhook for channel A is valid; the one for channel B is not known to Discord.
  discord.webhooks.set('100000000000000300', { channelId: WEBHOOK_CHANNEL, token: 'fixture-secret-token_1' });
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});

function runImport(dryRun = false): Promise<string[]> {
  const runtime = ab.bot.runtimes.find((candidate) => candidate.name === 'autodelete')!;
  return runLegacyImport({ runtime, database: t.database, path: dir, dryRun });
}

const snowflakeTime = (id: string) => new Date(SnowflakeUtil.timestampFrom(id));

describe('importLegacy', () => {
  it('reports counts in a dry run without writing or calling Discord', async () => {
    const lines = await runImport(true);
    expect(lines.slice(0, -1).every((line) => line.includes('would import'))).toBe(true);
    expect(lines.at(-1)).toContain('3 rules');
    expect(lines.at(-1)).toContain('4 posts');
    expect(lines.at(-1)).toContain('dry run');
    expect(discord.calls).toEqual([]);
    expect(await ruleRows(t)).toEqual([]);
  });

  it('imports rules, posts and cooldowns and reuses a valid webhook', async () => {
    const lines = await runImport();
    expect(lines).toEqual([
      `${CHANNEL_A}: rule imported, 2 posts, webhook reused`,
      `${CHANNEL_B}: rule imported, 1 posts, webhook invalid, set log-channel by hand`,
      `${CHANNEL_C}: rule imported, 1 posts, no webhook`,
      '3 rules imported, 0 already imported, 4 posts',
    ]);
    const rules = await ruleRows(t);
    expect(rules).toHaveLength(3);
    expect(rules[0]).toMatchObject({
      guildId: GUILD,
      channelId: CHANNEL_A,
      enabled: true,
      keepLatest: true,
      deleteOnLeave: true,
      cooldownMs: 1_209_600_000,
      graceMs: 0,
      notifyDm: true,
      logChannelId: WEBHOOK_CHANNEL,
      logThreadId: null,
      logWebhookId: '100000000000000300',
      logWebhookToken: 'fixture-secret-token_1',
    });
    expect(rules[1]).toMatchObject({ enabled: false, keepLatest: false, logChannelId: null, logWebhookId: null, logWebhookToken: null });
    expect(rules[2]).toMatchObject({ logChannelId: null, logThreadId: null, logWebhookId: null });
    expect(discord.calls).not.toContain('ensureWebhook');
    expect(discord.calls).not.toContain('deleteWebhook');

    const posts = await postRows(t);
    expect(posts).toHaveLength(4);
    for (const post of posts) expect(post.postedAt).toEqual(snowflakeTime(post.messageId));
    const cooldowns = await cooldownRows(t);
    expect(cooldowns).toHaveLength(4);
    for (const cooldown of cooldowns) expect(cooldown.postedAt).toEqual(snowflakeTime(cooldown.messageId));
  });

  it('logs into the thread when the old webhook had one', async () => {
    discord.webhooks.set('100000000000000301', { channelId: WEBHOOK_CHANNEL, token: 'fixture-secret-token_2' });
    await cp(new URL('../thread/', FIXTURES), join(dir, GUILD), { recursive: true });
    await runImport();
    const rule = (await ruleRows(t)).find((row) => row.channelId === '100000000000000240');
    expect(rule).toMatchObject({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD, logWebhookId: '100000000000000301' });
  });

  it('changes nothing on a second run', async () => {
    await runImport();
    const before = [await ruleRows(t), await postRows(t), await cooldownRows(t)];
    const lines = await runImport();
    expect(lines).toEqual([
      `${CHANNEL_A}: already imported, left as it is`,
      `${CHANNEL_B}: already imported, left as it is`,
      `${CHANNEL_C}: already imported, left as it is`,
      '0 rules imported, 3 already imported, 0 posts',
    ]);
    expect([await ruleRows(t), await postRows(t), await cooldownRows(t)]).toEqual(before);
  });

  it('keeps tokens, URLs, names and texts out of the report and the database', async () => {
    const report = [...(await runImport(true)), ...(await runImport())].join('\n');
    for (const secret of ['fixture-secret-token', '/webhooks/', 'https://', TEXT, NAME]) expect(report).not.toContain(secret);
    const stored = JSON.stringify([await postRows(t), await cooldownRows(t)]);
    expect(stored).not.toContain(TEXT);
    expect(stored).not.toContain(NAME);
  });
});
