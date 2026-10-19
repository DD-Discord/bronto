import { captureLog } from '@bronto/core/testing';
import { UnknownWebhookError } from '@bronto/core';
import { DiscordAPIError } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/core/test/test-db.js';
import { autodeleteConfigSchema } from '../config.js';
import type { Rule } from '../db/schema.js';
import type { AutodeleteContext, MemberInfo, Removal } from '../tracker.js';
import { FakeAutodeleteDiscord } from '../../test/fake-discord.js';
import { autodeleteDb, CHANNEL, GUILD, insertRule, LOG_CHANNEL, LOG_THREAD, MEMBER, prepareAutodeleteBot, ruleRows, type AutodeleteBot } from '../../test/harness.js';
import { createNotifier } from './notifier.js';

const NEXT = new Date('2026-03-15T12:00:00Z');
const member: MemberInfo = { id: MEMBER, displayName: 'Alex', avatarUrl: 'https://cdn.example/alex.png', joinedAt: null };

let t: TestDatabase;
let discord: FakeAutodeleteDiscord;
let lines: ReturnType<typeof captureLog>['lines'];
let ctx: AutodeleteContext;
let ab: AutodeleteBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeAutodeleteDiscord();
  // Preparing the bot migrates the database and creates the module's role.
  ab = await prepareAutodeleteBot(t, discord);
  const captured = captureLog();
  lines = captured.lines;
  ctx = {
    guildId: GUILD,
    db: autodeleteDb(t),
    log: captured.log,
    config: autodeleteConfigSchema.parse({ webhookName: 'Reports' }),
  } as unknown as AutodeleteContext;
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});

const notifier = () => createNotifier(() => discord);

const removal = (overrides: Partial<Removal> = {}): Removal => ({
  messageId: '100000000000000600',
  postedAt: new Date('2026-03-01T12:00:00Z'),
  post: { content: 'old text', attachmentCount: 0 },
  outcome: 'deleted',
  ...overrides,
});

async function ruleWithLog(values: Partial<Rule> = {}): Promise<Rule> {
  const webhook = discord.addWebhook(LOG_CHANNEL);
  return insertRule(t, { channelId: CHANNEL, logChannelId: LOG_CHANNEL, logWebhookId: webhook.id, logWebhookToken: webhook.token, ...values });
}

const newPost = { messageId: '100000000000000700', content: 'new text' };

describe('createNotifier', () => {
  it('sends the DM before the report', async () => {
    const rule = await ruleWithLog({ notifyDm: true });
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(discord.calls.filter((call) => call === 'sendDm' || call === 'send')).toEqual(['sendDm', 'send']);
    expect(discord.dms).toHaveLength(1);
    expect(discord.dms[0]!.userId).toBe(MEMBER);
    expect(discord.reports).toHaveLength(1);
  });

  it('sends the report as the member', async () => {
    const rule = await ruleWithLog();
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports[0]!.options).toEqual({ username: 'Alex', avatarUrl: 'https://cdn.example/alex.png' });
  });

  it('sends into the log thread', async () => {
    discord.threads.set(LOG_THREAD, LOG_CHANNEL);
    const rule = await ruleWithLog({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
    await notifier().left(ctx, rule, member, removal());
    expect(discord.reports[0]!.target.threadId).toBe(LOG_THREAD);
  });

  it('notes closed DMs in the report', async () => {
    discord.dmsClosed = true;
    const rule = await ruleWithLog({ notifyDm: true });
    await notifier().rejected(ctx, rule, member, removal(), { messageId: '100000000000000650', post: { content: 'current', attachmentCount: 0 } }, NEXT);
    expect(JSON.stringify(discord.reports[0]!.message)).toContain('their DMs are closed');
    expect(JSON.stringify(discord.reports[0]!.message)).not.toContain('got a copy by DM');
  });

  it('says in the report that a copy was sent', async () => {
    const rule = await ruleWithLog({ notifyDm: true, cooldownMs: 3_600_000 });
    await notifier().rejected(ctx, rule, member, removal(), null, NEXT);
    expect(JSON.stringify(discord.reports[0]!.message)).toContain('got a copy by DM');
    expect(JSON.stringify(discord.dms[0]!.message)).toContain('1h');
  });

  it('sends no DM when notify_dm is off or for a member who left', async () => {
    const off = await ruleWithLog({ notifyDm: false });
    await notifier().replaced(ctx, off, member, removal(), newPost);
    const on = await ruleWithLog({ channelId: '100000000000000020', notifyDm: true });
    await notifier().left(ctx, on, member, removal());
    expect(discord.dms).toHaveLength(0);
    expect(discord.reports).toHaveLength(2);
  });

  it('sends no DM for a post that could not be fetched or deleted', async () => {
    const rule = await ruleWithLog({ notifyDm: true });
    await notifier().replaced(ctx, rule, member, removal({ post: null, outcome: 'gone' }), newPost);
    await notifier().replaced(ctx, rule, member, removal({ outcome: 'forbidden' }), newPost);
    expect(discord.dms).toHaveLength(0);
    const json = discord.reports.map((report) => JSON.stringify(report.message)).join('\n');
    expect(json).toContain('already gone');
    expect(json).toContain('Manage Messages');
  });

  it('sends no report without a log webhook', async () => {
    const rule = await insertRule(t, { channelId: CHANNEL, notifyDm: true });
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(0);
    expect(discord.dms).toHaveLength(1);
  });

  it('replaces a deleted webhook once, stores it and resends', async () => {
    const rule = await ruleWithLog();
    discord.webhooks.delete(rule.logWebhookId!);
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(1);
    const [row] = await ruleRows(t);
    expect(row!.logWebhookId).not.toBe(rule.logWebhookId);
    expect(row).toMatchObject({ logWebhookId: discord.reports[0]!.target.id, logWebhookToken: discord.reports[0]!.target.token });
    expect(discord.calls.filter((call) => call === 'ensureWebhook')).toHaveLength(1);
  });

  it('gives up after the replacement fails too, without logging the token', async () => {
    const rule = await ruleWithLog();
    let sends = 0;
    discord.send = async () => {
      sends += 1;
      throw new UnknownWebhookError();
    };
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(sends).toBe(2);
    expect(lines.some((line) => line.level === 40)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(rule.logWebhookToken!);
  });

  it('drops the report when the webhook cannot be recreated', async () => {
    const rule = await ruleWithLog();
    discord.webhooks.delete(rule.logWebhookId!);
    discord.missingWebhookPermission = true;
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(0);
    expect(lines.some((line) => line.level === 40)).toBe(true);
  });

  it('resends once without the username when Discord rejects it', async () => {
    const rule = await ruleWithLog();
    const sent: unknown[] = [];
    discord.send = async (_target, _message, options) => {
      sent.push(options);
      if (options?.username !== undefined) throw new DiscordAPIError({ message: 'Invalid Form Body', code: 50035 }, 50035, 400, 'POST', 'url', {});
      return '1';
    };
    await notifier().replaced(ctx, rule, { ...member, displayName: 'Discord fan' }, removal(), newPost);
    expect(sent).toEqual([{ username: 'Discord fan', avatarUrl: member.avatarUrl }, { avatarUrl: member.avatarUrl }]);
  });

  it('does not split a character when cutting a long name', async () => {
    const rule = await ruleWithLog();
    await notifier().replaced(ctx, rule, { ...member, displayName: '\u{1F600}'.repeat(90) }, removal(), newPost);
    expect(Array.from(discord.reports[0]!.options!.username!)).toHaveLength(80);
  });

  it('warns and skips the report when the log channel is gone on the first send', async () => {
    const rule = await ruleWithLog();
    discord.send = async () => {
      throw new DiscordAPIError({ message: 'Unknown Channel', code: 10003 }, 10003, 404, 'POST', 'url', {});
    };
    await notifier().replaced(ctx, rule, member, removal(), newPost);
    expect(lines.filter((line) => line.level === 40)).toEqual([expect.objectContaining({ channelId: LOG_CHANNEL })]);
    expect(JSON.stringify(lines)).not.toContain(rule.logWebhookToken!);
    expect(discord.calls).not.toContain('ensureWebhook');
  });
});
