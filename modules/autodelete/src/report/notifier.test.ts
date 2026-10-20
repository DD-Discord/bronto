import { captureLog } from '@bronto/core/testing';
import { ChannelType, MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/core/test/test-db.js';
import { autodeleteConfigSchema } from '../config.js';
import type { Rule } from '../db/schema.js';
import type { AutodeleteContext, MemberInfo, Removal } from '../tracker.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import { autodeleteDb, CHANNEL, GUILD, insertRule, LOG_CHANNEL, LOG_THREAD, MEMBER, prepareAutodeleteBot, ruleRows, type AutodeleteBot } from '../../test/harness.js';
import { notifyReplaced, notifyRejected, notifyLeft } from './notifier.js';

const NEXT = new Date('2026-03-15T12:00:00Z');
const member: MemberInfo = { id: MEMBER, displayName: 'Alex', avatarUrl: 'https://cdn.example/alex.png', joinedAt: null };

let t: TestDatabase;
let discord: FakeDiscordHttp;
let lines: ReturnType<typeof captureLog>['lines'];
let ctx: AutodeleteContext;
let ab: AutodeleteBot;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  // Preparing the bot migrates the database and creates the module's role.
  ab = await prepareAutodeleteBot(t, discord);
  const captured = captureLog();
  lines = captured.lines;
  ctx = {
    guildId: GUILD,
    client: ab.client,
    db: autodeleteDb(t),
    log: captured.log,
    config: autodeleteConfigSchema.parse({ webhookName: 'Reports' }),
  } as unknown as AutodeleteContext;
});

afterEach(async () => {
  await ab.bot.stop();
  await t.drop();
});


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

describe('native notifications', () => {
  it('sends the DM before the report', async () => {
    const rule = await ruleWithLog({ notifyDm: true });
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(ab.requests.filter(r => r.method === 'POST' && (r.path.startsWith('/webhooks/') || r.path.endsWith('/messages'))).map(r => r.path.startsWith('/webhooks/') ? 'report' : 'dm')).toEqual(['dm', 'report']);
    expect(discord.dms).toHaveLength(1);
    expect(discord.dms[0]!.userId).toBe(MEMBER);
    expect(discord.reports).toHaveLength(1);
  });

  it('sends the report as the member', async () => {
    const rule = await ruleWithLog();
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports[0]!.options).toEqual({ username: 'Alex', avatarUrl: 'https://cdn.example/alex.png' });
  });

  it('sends into the log thread', async () => {
    discord.addChannel(LOG_THREAD, { guildId: GUILD, type: ChannelType.PublicThread, parentId: LOG_CHANNEL });
    const rule = await ruleWithLog({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
    await notifyLeft(ctx, rule, member, removal());
    expect(discord.reports[0]!.target.threadId).toBe(LOG_THREAD);
  });

  it('notes closed DMs in the report', async () => {
    discord.override('POST', '/users/@me/channels', () => ({ status: 403, json: { code: 50007, message: 'Closed' } }));
    const rule = await ruleWithLog({ notifyDm: true });
    await notifyRejected(ctx, rule, member, removal(), { messageId: '100000000000000650', post: { content: 'current', attachmentCount: 0 } }, NEXT);
    expect(JSON.stringify(discord.reports[0]!.message)).toContain('their DMs are closed');
    expect(JSON.stringify(discord.reports[0]!.message)).not.toContain('got a copy by DM');
  });

  it('says in the report that a copy was sent', async () => {
    const rule = await ruleWithLog({ notifyDm: true, cooldownMs: 3_600_000 });
    await notifyRejected(ctx, rule, member, removal(), null, NEXT);
    expect(JSON.stringify(discord.reports[0]!.message)).toContain('got a copy by DM');
    expect(JSON.stringify(discord.dms[0]!.message)).toContain('1h');
  });

  it('sends no DM when notify_dm is off or for a member who left', async () => {
    const off = await ruleWithLog({ notifyDm: false });
    await notifyReplaced(ctx, off, member, removal(), newPost);
    const on = await ruleWithLog({ channelId: '100000000000000020', notifyDm: true });
    await notifyLeft(ctx, on, member, removal());
    expect(discord.dms).toHaveLength(0);
    expect(discord.reports).toHaveLength(2);
  });

  it('sends no DM for a post that could not be fetched or deleted', async () => {
    const rule = await ruleWithLog({ notifyDm: true });
    await notifyReplaced(ctx, rule, member, removal({ post: null, outcome: 'gone' }), newPost);
    await notifyReplaced(ctx, rule, member, removal({ outcome: 'forbidden' }), newPost);
    expect(discord.dms).toHaveLength(0);
    const json = discord.reports.map((report) => JSON.stringify(report.message)).join('\n');
    expect(json).toContain('already gone');
    expect(json).toContain('Manage Messages');
  });

  it('sends no report without a log webhook', async () => {
    const rule = await insertRule(t, { channelId: CHANNEL, notifyDm: true });
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(0);
    expect(discord.dms).toHaveLength(1);
  });

  it('replaces a deleted webhook once, stores it and resends', async () => {
    const rule = await ruleWithLog();
    discord.webhooks.delete(rule.logWebhookId!);
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(1);
    const [row] = await ruleRows(t);
    expect(row!.logWebhookId).not.toBe(rule.logWebhookId);
    expect(row).toMatchObject({ logWebhookId: discord.reports[0]!.target.id, logWebhookToken: discord.reports[0]!.target.token });
    expect(ab.requests.filter(r => r.method === 'POST' && r.path === `/channels/${LOG_CHANNEL}/webhooks`)).toHaveLength(1);
  });

  it('gives up after the replacement fails too, without logging the token', async () => {
    const rule = await ruleWithLog();
    let sends = 0;
    discord.override('POST', `/webhooks/${rule.logWebhookId}/${rule.logWebhookToken}`, () => {
      sends += 1;
      return { status: 404, json: { code: 10015, message: 'Unknown Webhook' } };
    });
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(sends).toBe(2);
    expect(lines.some((line) => line.level === 40)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(rule.logWebhookToken!);
  });

  it('drops the report when the webhook cannot be recreated', async () => {
    const rule = await ruleWithLog();
    discord.webhooks.delete(rule.logWebhookId!);
    discord.override('POST', `/channels/${LOG_CHANNEL}/webhooks`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(0);
    expect(lines.some((line) => line.level === 40)).toBe(true);
  });

  it('resends once without the username when Discord rejects it', async () => {
    const rule = await ruleWithLog();
    const sent: unknown[] = [];
    const path = `/webhooks/${rule.logWebhookId}/${rule.logWebhookToken}`;
    discord.override('POST', path, request => {
      const body = request.body as { username?: string; avatar_url?: string };
      sent.push({ ...(body.username !== undefined ? { username: body.username } : {}), avatarUrl: body.avatar_url });
      if (body.username === 'Discord fan') return { status: 400, json: { code: 50035, message: 'Invalid Form Body' } };
      discord.clearOverride('POST', path);
      return discord.answer(request);
    });
    await notifyReplaced(ctx, rule, { ...member, displayName: 'Discord fan' }, removal(), newPost);
    expect(sent).toEqual([{ username: 'Discord fan', avatarUrl: member.avatarUrl }, { username: 'Synthetic webhook', avatarUrl: member.avatarUrl }]);
  });

  it('does not split a character when cutting a long name', async () => {
    const rule = await ruleWithLog();
    await notifyReplaced(ctx, rule, { ...member, displayName: '\u{1F600}'.repeat(90) }, removal(), newPost);
    expect(Array.from(discord.reports[0]!.options!.username!)).toHaveLength(80);
  });

  it('warns and skips the report when the log channel is gone on the first send', async () => {
    const rule = await ruleWithLog();
    discord.override('POST', `/webhooks/${rule.logWebhookId}/${rule.logWebhookToken}`, () => ({ status: 404, json: { code: 10003, message: 'Unknown Channel' } }));
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(lines.filter((line) => line.level === 40)).toEqual([expect.objectContaining({ channelId: LOG_CHANNEL })]);
    expect(JSON.stringify(lines)).not.toContain(rule.logWebhookToken!);
    expect(ab.requests.filter(r => r.method === 'POST' && r.path === `/channels/${LOG_CHANNEL}/webhooks`)).toEqual([]);
  });
});

it.each([10015, 50027])('recovers report webhook %i during resolution and send', async code => {
  for (const stage of ['GET', 'POST']) {
    const rule = await ruleWithLog({ channelId: discord.newId(), logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
    const path = `/webhooks/${rule.logWebhookId}/${rule.logWebhookToken}`;
    discord.override(stage, path, () => {
      discord.removeWebhook(rule.logWebhookId!);
      return { status: code === 50027 ? 401 : 404, json: { code, message: 'Unusable webhook' } };
    });
    const before = discord.reports.length;
    await notifyReplaced(ctx, rule, member, removal(), newPost);
    expect(discord.reports).toHaveLength(before + 1);
    const row = (await ruleRows(t)).find(row => row.channelId === rule.channelId)!;
    expect(row.logWebhookId).not.toBe(rule.logWebhookId);
    expect(row.logThreadId).toBe(LOG_THREAD);
  }
});

it('retries a rejected username without losing files, components or routing', async () => {
  const rule = await ruleWithLog({ logChannelId: LOG_THREAD, logThreadId: LOG_THREAD });
  const path = `/webhooks/${rule.logWebhookId}/${rule.logWebhookToken}`;
  const attempts: FormData[] = [];
  discord.override('POST', path, request => {
    const form = request.body as FormData;
    attempts.push(form);
    const payload = JSON.parse(form.get('payload_json') as string);
    if (payload.username === member.displayName) return { status: 400, json: { code: 50035, message: 'Invalid username' } };
    discord.clearOverride('POST', path); return discord.answer(request);
  });
  await notifyReplaced(ctx, rule, member, removal({ post: { content: 'old line\n'.repeat(1200), attachmentCount: 0 } }), { messageId: newPost.messageId, content: 'new line\n'.repeat(1200) });
  expect(attempts).toHaveLength(2);
  const payload = JSON.parse(attempts[1]!.get('payload_json') as string);
  expect(payload.username).toBe('Synthetic webhook');
  expect(payload.avatar_url).toBe(member.avatarUrl);
  expect(payload.allowed_mentions).toEqual({ parse: [] });
  expect(payload.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  expect(attempts[1]!.get('files[0]')).not.toBeNull();
  const request = ab.requests.findLast(r => r.method === 'POST' && r.path === path)!;
  expect(new URLSearchParams(request.query).get('thread_id')).toBe(LOG_THREAD);
  expect(discord.reports).toHaveLength(1);
});
