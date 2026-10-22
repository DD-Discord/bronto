import type { GateResult, HandlerContext } from '@bronto/core';
import { fakeCommand } from '@bronto/core/testing';
import { templatesEvents, templatesGates } from '@bronto/templates';
import { Events, type APIEmbed } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { FakeDiscordHttp } from '@bronto/core/testing';
import {
  CHANNEL,
  createTemplate,
  GUILD,
  insertSticky,
  message,
  prepareStickyBot,
  QUIET_CHANNEL,
  ready,
  stateOf,
  stickyRows,
  THREAD,
  USER,
  type StickyBot,
} from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let sb: StickyBot;
let template: string;

/** A channel option value as discord.js resolves it. */
const channel = (id: string, parentId?: string) => ({ id, isThread: () => parentId !== undefined, parentId: parentId ?? null });

async function sticky(subcommand: string, options: Record<string, unknown>, channelId = CHANNEL): Promise<void> {
  sb.client.emit(Events.InteractionCreate, fakeCommand({ command: 'sticky', subcommand, guildId: GUILD, channelId, userId: USER, options }));
  await sb.bot.idle();
}

async function say(channelId: string): Promise<void> {
  sb.client.emit(Events.MessageCreate, message(channelId));
  await sb.bot.idle();
}

/** Runs `run` as the templates module, the way its own handlers emit and check. */
async function asTemplates(run: (ctx: HandlerContext) => Promise<void>): Promise<void> {
  const runtime = sb.bot.runtimes.find((entry) => entry.name === 'templates')!;
  const outcome = await sb.bot.dispatcher.runHandler(runtime, GUILD, null, 'test', run);
  if (!outcome.ok) throw outcome.error;
  await sb.bot.idle();
}

/** Saves new content for a template and announces it, as the editor does. */
async function editTemplate(id: string, content: string, embed: APIEmbed | null): Promise<void> {
  await t.database.adminPool.query('update templates.templates set content = $2, embed = $3 where id = $1', [id, content, embed === null ? null : JSON.stringify(embed)]);
  await asTemplates(async (ctx) => ctx.emit(templatesEvents.updated, { id }));
}

/** Deletes a template and announces it, as the templates module does. */
async function deleteTemplate(id: string): Promise<void> {
  await t.database.adminPool.query('delete from templates.templates where id = $1', [id]);
  await asTemplates(async (ctx) => ctx.emit(templatesEvents.deleted, { id }));
}

async function checkDeleting(id: string): Promise<GateResult> {
  let result: GateResult | undefined;
  await asTemplates(async (ctx) => {
    result = await ctx.check(templatesGates.deleting, { id });
  });
  return result!;
}

const contentOf = (messageId: string) => {
  const posted = discord.messages.get(messageId)!;
  return { content: posted.content, embeds: posted.embeds };
};

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  sb = await prepareStickyBot(t, discord);
  await ready(sb);
  template = await createTemplate(sb, 'Welcome rules', { content: 'Read the rules.', embed: { title: 'Rules' } });
});

afterEach(async () => {
  await sb.bot.stop();
  await t.drop();
});

describe('posting templates', () => {
  it('posts the rendered template', async () => {
    await sticky('create', { channel: channel(CHANNEL), template });
    await say(CHANNEL);
    expect(discord.sent).toHaveLength(2);
    expect(discord.sent[1]!.message).toMatchObject({ content: 'Read the rules.', embeds: [{ title: 'Rules' }] });
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[1]!.id]);
  });

  it('posts the template rather than a stored copy while the template exists', async () => {
    await insertSticky(t, discord, { channelId: CHANNEL, templateId: template, content: 'Old copy', embeds: [] });
    // An edit without changes indexes the sticky and posts it.
    await sticky('edit', { channel: channel(CHANNEL), silent: true });
    expect(discord.sent.map((sent) => sent.message.content)).toEqual(['Read the rules.']);
  });

  it('posts the stored copy while its template is missing', async () => {
    await insertSticky(t, discord, { channelId: CHANNEL, content: 'Old copy', embeds: [{ title: 'Old' }] });
    await sticky('edit', { channel: channel(CHANNEL), silent: true });
    expect(discord.sent[0]!.message).toMatchObject({ content: 'Old copy', embeds: [{ title: 'Old' }] });
  });
});

describe('templates.updated', () => {
  it('edits the live posts of every sticky using the template in place', async () => {
    const other = await createTemplate(sb, 'Other');
    await sticky('create', { channel: channel(CHANNEL), template });
    await sticky('create', { channel: channel(THREAD, CHANNEL), template }, THREAD);
    await sticky('create', { channel: channel(QUIET_CHANNEL), template: other }, QUIET_CHANNEL);
    const [main, thread, quiet] = discord.sent.map((sent) => sent.id);
    await editTemplate(template, 'New rules', { title: 'Rules v2' });
    expect(discord.sent).toHaveLength(3);
    expect(discord.edited.toSorted()).toEqual([main, thread].toSorted());
    expect(contentOf(main!)).toMatchObject({ content: 'New rules', embeds: [{ title: 'Rules v2' }] });
    expect(contentOf(thread!)).toMatchObject({ content: 'New rules', embeds: [{ title: 'Rules v2' }] });
    expect(contentOf(quiet!).content).toBe('Read the rules.');
    expect(sb.requests.find((request) => request.method === 'PATCH' && request.path.startsWith('/webhooks/'))).toMatchObject({
      authorized: false,
      body: { allowed_mentions: { parse: [] } },
    });
  });

  it('clears the content of a post whose template no longer has any', async () => {
    await sticky('create', { channel: channel(CHANNEL), template });
    await editTemplate(template, '', { title: 'Only an embed' });
    expect(contentOf(discord.sent[0]!.id)).toMatchObject({ content: '', embeds: [{ title: 'Only an embed' }] });
  });

  it('reposts when the live post is gone', async () => {
    await sticky('create', { channel: channel(CHANNEL), template });
    discord.messages.delete(discord.sent[0]!.id);
    await editTemplate(template, 'New rules', null);
    expect(discord.edited).toEqual([]);
    expect(discord.sent).toHaveLength(2);
    expect(discord.sent[1]!.message).toMatchObject({ content: 'New rules', embeds: [] });
    expect((await stateOf(t, CHANNEL))?.lastMessageId).toBe(discord.sent[1]!.id);
  });

  it('still reposts when the edit replaces a repost waiting in the queue', async () => {
    await sticky('create', { channel: channel(CHANNEL), template });
    const [row] = await stickyRows(t);
    const path = `/webhooks/${row!.webhookId}/${row!.webhookToken}`;
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    discord.override('POST', path, async (request) => {
      reached.resolve(); await gate.promise; discord.clearOverride('POST', path); return discord.answer(request);
    });
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await reached.promise;
    // This repost waits behind the one in flight; the template edit queued next replaces it.
    sb.client.emit(Events.MessageCreate, message(CHANNEL));
    await t.database.adminPool.query("update templates.templates set content = 'New rules' where id = $1", [template]);
    const edited = asTemplates(async (ctx) => ctx.emit(templatesEvents.updated, { id: template }));
    gate.resolve();
    await edited;
    expect(discord.sent).toHaveLength(3);
    expect(discord.sent[2]!.message.content).toBe('New rules');
    expect(discord.liveMessages(CHANNEL)).toEqual([discord.sent[2]!.id]);
  });

  it('leaves a sticky without a post for the next repost', async () => {
    await sticky('create', { channel: channel(CHANNEL), template });
    await t.database.adminPool.query('update sticky.sticky_state set last_message_id = null');
    await editTemplate(template, 'New rules', null);
    expect(discord.edited).toEqual([]);
    expect(discord.sent).toHaveLength(1);
  });
});

describe('templates.deleted', () => {
  it('deletes the stickies using the template, with their posts and webhooks', async () => {
    const other = await createTemplate(sb, 'Other');
    await sticky('create', { channel: channel(CHANNEL), template });
    await sticky('create', { channel: channel(THREAD, CHANNEL), template }, THREAD);
    await sticky('create', { channel: channel(QUIET_CHANNEL), template: other }, QUIET_CHANNEL);
    const [main] = await stickyRows(t);
    await deleteTemplate(template);
    expect((await stickyRows(t)).map((row) => row.channelId)).toEqual([QUIET_CHANNEL]);
    expect(discord.liveMessages(CHANNEL)).toEqual([]);
    expect(discord.liveMessages(THREAD)).toEqual([]);
    expect(discord.liveMessages(QUIET_CHANNEL)).toHaveLength(1);
    expect(discord.deletedWebhooks).toEqual([main!.webhookId]);
    await say(CHANNEL);
    await say(THREAD);
    expect(discord.sent).toHaveLength(3);
  });
});

describe('templates.deleting', () => {
  it('allows deleting a template no sticky uses', async () => {
    const other = await createTemplate(sb, 'Other');
    await sticky('create', { channel: channel(CHANNEL), template: other });
    expect(await checkDeleting(template)).toEqual({ allowed: true });
  });

  it('denies while stickies use the template, naming their channels', async () => {
    await sticky('create', { channel: channel(QUIET_CHANNEL), template }, QUIET_CHANNEL);
    await sticky('create', { channel: channel(CHANNEL), template });
    expect(await checkDeleting(template)).toEqual({
      allowed: false,
      reasons: [`Used by the stickies in <#${CHANNEL}>, <#${QUIET_CHANNEL}>`],
    });
  });
});
