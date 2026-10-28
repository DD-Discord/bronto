import { FakeDiscordHttp, fakeButton, fakeModal, type FakeInteraction } from '@bronto/core/testing';
import { Events } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { RenameLimiter } from '../src/rename.js';
import { CHANNEL, createTemplate, fakeMessage, GUILD, insertRule, MEMBER, prepareAutothreadBot, ready, USER, type AutothreadBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let ab: AutothreadBot | undefined;

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
});

afterEach(async () => {
  vi.useRealTimers();
  await ab?.bot.stop();
  ab = undefined;
  await t.drop();
});

type Json = Record<string, any>;

/** Starts a bot with a renaming rule and posts in CHANNEL; returns the thread's ID. */
async function openThread(options: { template?: boolean; templateId?: string } = {}): Promise<string> {
  ab = await prepareAutothreadBot(t, discord);
  const templateId = options.templateId ?? (options.template === true ? await createTemplate(ab, 'Welcome', 'Hi {user.mention}') : undefined);
  await insertRule(t, { channelId: CHANNEL, rename: true, ...(templateId === undefined ? {} : { templateId }) });
  await ready(ab);
  const message = fakeMessage(CHANNEL);
  discord.addPost(message.channelId, message.id, { content: message.content, attachmentCount: 0 });
  ab.client.emit(Events.MessageCreate, message);
  await ab.bot.idle();
  return message.id;
}

const postsIn = (channelId: string) => [...discord.messages.values()].filter((message) => message.channel_id === channelId) as unknown as Json[];
const buttonOf = (message: Json) => message.components[0].components[0] as Json;

async function press(threadId: string, customId: string, userId = MEMBER): Promise<FakeInteraction> {
  const fake = fakeButton({ customId, guildId: GUILD, channelId: threadId, userId });
  ab!.client.emit(Events.InteractionCreate, fake as never);
  await ab!.bot.idle();
  return fake;
}

async function submit(threadId: string, customId: string, name: string, userId = MEMBER): Promise<FakeInteraction> {
  const fake = fakeModal({ customId, guildId: GUILD, channelId: threadId, userId, fields: { name } });
  ab!.client.emit(Events.InteractionCreate, fake as never);
  await ab!.bot.idle();
  return fake;
}

const json = (value: unknown): Json => ((value as Json).toJSON?.() ?? value) as Json;

/** Presses the button as the author and returns the modal's custom ID. */
async function modalId(threadId: string): Promise<string> {
  const buttonId = buttonOf(postsIn(threadId)[0]!).custom_id;
  const fake = await press(threadId, buttonId);
  expect(fake.responses[0]!.kind).toBe('showModal');
  return json(fake.responses[0]!.payload).custom_id;
}

describe('RenameLimiter', () => {
  it('allows two renames per ten minutes per thread', () => {
    const limiter = new RenameLimiter();
    expect([limiter.allow('a', 0), limiter.allow('a', 1), limiter.allow('a', 2), limiter.allow('b', 2)]).toEqual([true, true, false, true]);
    expect(limiter.retryAt('a')).toBe(600_000);
    expect(limiter.allow('a', 600_000)).toBe(true);
  });
});

describe('the rename button', () => {
  it('sits on the auto-message', async () => {
    const thread = await openThread({ template: true });
    const posts = postsIn(thread);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ content: `Hi <@${MEMBER}>` });
    expect(buttonOf(posts[0]!)).toMatchObject({ label: 'Rename thread' });
  });

  it('posts the button alone without a template', async () => {
    const thread = await openThread();
    const posts = postsIn(thread);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ allowed_mentions: { parse: [] } });
    expect(buttonOf(posts[0]!)).toMatchObject({ label: 'Rename thread' });
  });

  it('posts the button when the template is gone', async () => {
    const thread = await openThread({ templateId: '00000000-0000-4000-8000-000000000000' });
    expect(postsIn(thread)).toHaveLength(1);
    expect(buttonOf(postsIn(thread)[0]!)).toMatchObject({ label: 'Rename thread' });
    expect(ab!.lines.filter((line) => line.msg === 'The auto-message template no longer exists')).toHaveLength(1);
  });

  it('logs a failing template render and still opens the thread', async () => {
    ab = await prepareAutothreadBot(t, discord);
    const templateId = await createTemplate(ab, 'Welcome', 'Hi');
    await insertRule(t, { channelId: CHANNEL, rename: true, templateId });
    await ready(ab);
    await t.database.admin.execute('drop table templates.templates cascade');
    const message = fakeMessage(CHANNEL);
    discord.addPost(message.channelId, message.id, { content: message.content, attachmentCount: 0 });
    ab.client.emit(Events.MessageCreate, message);
    await ab.bot.idle();
    expect(discord.channels.has(message.id)).toBe(true);
    expect(ab.lines.filter((line) => line.msg === 'Posting the auto-message failed')).toHaveLength(1);
  });

  it('opens the modal for the author, prefilled with the name', async () => {
    const thread = await openThread();
    const fake = await press(thread, buttonOf(postsIn(thread)[0]!).custom_id);
    const modal = json(fake.responses[0]!.payload);
    expect(modal.title).toBe('Rename thread');
    expect(modal.components[0].component).toMatchObject({ custom_id: 'name', value: '[Comments] Mia Display', min_length: 1, max_length: 100 });
  });

  it('refuses other members', async () => {
    const thread = await openThread();
    const fake = await press(thread, buttonOf(postsIn(thread)[0]!).custom_id, USER);
    expect(fake.responses.map((r) => r.kind)).not.toContain('showModal');
    expect(JSON.stringify(fake.responses)).toContain('Only the author can rename this thread.');
  });

  it('renames the thread', async () => {
    const thread = await openThread();
    const fake = await submit(thread, await modalId(thread), 'Chat about cats');
    expect((discord.channels.get(thread) as Json).name).toBe('Chat about cats');
    expect(JSON.stringify(fake.responses)).toContain('Thread renamed.');
  });

  it('limits renames to two per ten minutes', async () => {
    const thread = await openThread();
    const id = await modalId(thread);
    await submit(thread, id, 'One');
    await submit(thread, id, 'Two');
    const third = await submit(thread, id, 'Three');
    expect((discord.channels.get(thread) as Json).name).toBe('Two');
    expect(JSON.stringify(third.responses)).toMatch(/Discord allows two renames per 10 minutes\. Try again <t:\d+:R>\./);
  });

  it('works after a restart', async () => {
    const thread = await openThread();
    const buttonId = buttonOf(postsIn(thread)[0]!).custom_id;
    await ab!.bot.stop();
    ab = await prepareAutothreadBot(t, discord);
    await ready(ab);
    const fake = await press(thread, buttonId);
    expect(fake.responses[0]!.kind).toBe('showModal');
  });
});
