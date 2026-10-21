import { defineModule, gate, on } from '@bronto/core';
import { fakeButton, fakeModal, FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { ChannelType, Events, PermissionFlagsBits, type ActionRowBuilder, type ButtonBuilder, type ModalBuilder } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { templatesApi } from '../src/api.js';
import { forums, templateImages, templates } from '../src/db/schema.js';
import { templatesEvents, templatesGates } from '../src/events.js';
import { createTemplatesModule } from '../src/index.js';
import { exportJson } from '../src/transfer.js';
import { FORUM, GUILD, inHandler, prepareTemplatesBot, ready, templatesDb, USER, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;
let denial: string[] | null;
let emitted: string[];

const TEXT = '100000000000000030';
const MEMBER = '100000000000000098';

const guard = defineModule({
  name: 'guard',
  dependsOn: [createTemplatesModule()],
  listeners: [
    on(templatesEvents.updated, (_ctx, { id }) => void emitted.push(`updated ${id}`)),
    on(templatesEvents.deleted, (_ctx, { id }) => void emitted.push(`deleted ${id}`)),
    gate(templatesGates.deleting, () => (denial === null ? undefined : { deny: denial.join('\n') })),
  ],
});

beforeEach(async () => {
  denial = null;
  emitted = [];
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  tb = await prepareTemplatesBot(t, discord, { extra: [{ packageName: '@test/guard', definition: guard, config: {} }] });
  discord.addChannel(TEXT, { guildId: GUILD, type: ChannelType.GuildText });
  await templatesDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
  await ready(tb);
});

afterEach(async () => {
  await tb.bot.stop();
  await t.drop();
});

const embed = { title: 'Welcome', description: 'Read the rules.' };

async function makeTemplate() {
  const { id } = await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'Welcome rules', content: 'Hello', embed }));
  const [row] = await t.database.admin.select().from(templates).where(eq(templates.id, id));
  return row!;
}

function buttonId(threadId: string, name: string): string {
  const rows = discord.messages.get(threadId)!.components as { components: { custom_id: string }[] }[];
  return rows[0]!.components.find((button) => button.custom_id.startsWith(`templates:${name}:`))!.custom_id;
}

async function send<T extends FakeInteraction>(fake: T): Promise<T> {
  tb.client.emit(Events.InteractionCreate, fake as never);
  await tb.bot.idle();
  return fake;
}

const click = (threadId: string, name: string, options: { permissions?: bigint; userId?: string } = {}) =>
  send(fakeButton({ customId: buttonId(threadId, name), guildId: GUILD, channelId: threadId, userId: options.userId ?? USER, ...options }));

const payload = (fake: FakeInteraction, index = 0) => fake.responses[index]!.payload as Record<string, any>;

/** Opens the import form and submits it. */
async function submitImport(threadId: string, input: { json?: string; uploads?: { filename: string; url: string; size: number }[] }) {
  const opened = await click(threadId, 'import');
  expect(opened.responses[0]!.kind).toBe('showModal');
  const modal = (payload(opened) as ModalBuilder).toJSON();
  return send(
    fakeModal({
      customId: modal.custom_id,
      guildId: GUILD,
      channelId: threadId,
      userId: USER,
      fields: { json: input.json ?? '' },
      uploads: { file: input.uploads ?? [] },
    }),
  );
}

async function uploadedJson(name: string, text: string) {
  const channel = await tb.client.channels.fetch(TEXT);
  if (channel === null || channel.type !== ChannelType.GuildText) throw new Error('no channel');
  const message = await channel.send({ files: [{ attachment: Buffer.from(text), name }] });
  const file = message.attachments.first()!;
  return { filename: file.name, url: file.url, size: file.size };
}

describe('export', () => {
  it('replies with the template as a .json file', async () => {
    const row = await makeTemplate();
    const fake = await click(row.threadId, 'export');
    const [file] = payload(fake).files;
    expect(file.name).toBe('welcome-rules.json');
    expect(file.attachment.toString()).toBe(exportJson({ content: 'Hello', embed }));
  });
});

describe('import', () => {
  it('replaces content and embed from pasted JSON', async () => {
    const row = await makeTemplate();
    const json = JSON.stringify({ content: 'New', embeds: [{ title: 'Fresh' }] });
    const fake = await submitImport(row.threadId, { json });
    expect(payload(fake).content).toBe('Template imported.');
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored).toMatchObject({ content: 'New', embed: { title: 'Fresh' } });
    expect(discord.messages.get(row.threadId)).toMatchObject({ content: 'New', embeds: [{ title: 'Fresh' }] });
    expect(emitted).toEqual([`updated ${row.id}`]);
  });

  it('imports an uploaded .json file', async () => {
    const row = await makeTemplate();
    const file = await uploadedJson('t.json', JSON.stringify({ content: 'From file' }));
    await submitImport(row.threadId, { uploads: [file] });
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored).toMatchObject({ content: 'From file', embed: null });
  });

  it('refuses a file that is not .json', async () => {
    const row = await makeTemplate();
    const file = await uploadedJson('t.txt', '{}');
    const fake = await submitImport(row.threadId, { uploads: [file] });
    expect(payload(fake).content).toBe('The file must be a .json file.');
  });

  it('shows the error for invalid JSON and keeps the template', async () => {
    const row = await makeTemplate();
    const fake = await submitImport(row.threadId, { json: '{nope' });
    expect(payload(fake).content).toMatch(/^That isn't template JSON/);
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored).toMatchObject({ content: 'Hello', embed });
    expect(emitted).toEqual([]);
  });

  it('shows validation problems', async () => {
    const row = await makeTemplate();
    const fake = await submitImport(row.threadId, { json: JSON.stringify({ content: '' }) });
    expect(payload(fake).content).toBe('A template needs text or an embed.');
  });

  it('asks for input when the form is empty', async () => {
    const row = await makeTemplate();
    const fake = await submitImport(row.threadId, {});
    expect(payload(fake).content).toBe('Paste template JSON or upload a .json file.');
  });

  it('drops uploaded images the new embed no longer references', async () => {
    const created = await inHandler(tb, (ctx) =>
      templatesApi(ctx).create({ name: 'Pic', content: 'Hi', embed: { title: 'T' } }),
    );
    const [row] = await t.database.admin.select().from(templates).where(eq(templates.id, created.id));
    const { updatePreview } = await import('../src/posts.js');
    await inHandler(tb, (ctx) => updatePreview(ctx, row!, [{ slot: 'image', name: 'a.png', data: Buffer.from('png') }, { slot: 'thumbnail', name: 'b.png', data: Buffer.from('png') }]));
    // The embed in the row references the uploads, as the editor stores it.
    await t.database.admin
      .update(templates)
      .set({ embed: { title: 'T', image: { url: 'attachment://image.png' }, thumbnail: { url: 'attachment://thumbnail.png' } } })
      .where(eq(templates.id, row!.id));
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(2);

    const json = JSON.stringify({ content: 'Hi', embeds: [{ title: 'T', image: { url: 'attachment://image.png' }, thumbnail: { url: 'attachment://other.png' } }] });
    await submitImport(row!.threadId, { json });

    const images = await t.database.admin.select().from(templateImages);
    expect(images.map((image) => image.slot)).toEqual(['image']);
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored!.embed).toEqual({ title: 'T', image: { url: 'attachment://image.png' } });
    expect(discord.messages.get(row!.threadId)!.attachments.map((a) => a.filename)).toEqual(['image.png']);
  });

  it('keeps uploaded images through export and import', async () => {
    const created = await inHandler(tb, (ctx) => templatesApi(ctx).create({ name: 'Pic', content: 'Hi', embed: { title: 'T' } }));
    const [row] = await t.database.admin.select().from(templates).where(eq(templates.id, created.id));
    const { updatePreview } = await import('../src/posts.js');
    await inHandler(tb, (ctx) => updatePreview(ctx, row!, [{ slot: 'image', name: 'a.png', data: Buffer.from('png') }]));
    await t.database.admin
      .update(templates)
      .set({ embed: { title: 'T', image: { url: 'attachment://image.png' } } })
      .where(eq(templates.id, row!.id));
    const [before] = await t.database.admin.select().from(templateImages);

    const exported = await click(row!.threadId, 'export');
    const json = payload(exported).files[0].attachment.toString();
    expect(JSON.parse(json).embeds[0].image.url).toMatch(/^https:\/\/cdn\.discordapp\.com\/attachments\//);
    await submitImport(row!.threadId, { json });

    const images = await t.database.admin.select().from(templateImages);
    expect(images).toHaveLength(1);
    expect(images[0]!.attachmentId).toBe(before!.attachmentId);
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored!.embed).toEqual({ title: 'T', image: { url: 'attachment://image.png' } });
    expect(discord.messages.get(row!.threadId)!.attachments.map((a) => a.filename)).toEqual(['image.png']);
  });

  it('says so when the post could not be updated after saving', async () => {
    const row = await makeTemplate();
    discord.override('PATCH', `/channels/${row.threadId}/messages/${row.previewMessageId}`, () => ({
      status: 403,
      json: { code: 50013, message: 'Missing Permissions' },
    }));
    const fake = await submitImport(row.threadId, { json: JSON.stringify({ content: 'Saved text' }) });
    expect(payload(fake).content).toMatch(/^Saved, but the post couldn't be updated: .*Missing Permissions/);
    const [stored] = await t.database.admin.select().from(templates);
    expect(stored!.content).toBe('Saved text');
  });

  it('is refused for members who may not post in the thread', async () => {
    const row = await makeTemplate();
    const fake = await click(row.threadId, 'import', { userId: MEMBER, permissions: PermissionFlagsBits.ViewChannel });
    expect(payload(fake).content).toBe('You need permission to post in this forum to change templates.');
  });
});

describe('delete', () => {
  async function confirmId(threadId: string): Promise<string> {
    const asked = await click(threadId, 'delete');
    expect(payload(asked).content).toContain('Welcome rules');
    const rows = payload(asked).components as ActionRowBuilder<ButtonBuilder>[];
    return (rows[0]!.toJSON().components[0] as { custom_id: string }).custom_id;
  }
  const confirm = (threadId: string, customId: string) => send(fakeButton({ customId, guildId: GUILD, channelId: threadId, userId: USER }));

  it('asks for confirmation first', async () => {
    const row = await makeTemplate();
    await confirmId(row.threadId);
    expect(await t.database.admin.select().from(templates)).toHaveLength(1);
    expect(discord.channels.has(row.threadId)).toBe(true);
  });

  it('deletes the template and its post when the gate allows', async () => {
    const row = await makeTemplate();
    const customId = await confirmId(row.threadId);
    const fake = await confirm(row.threadId, customId);
    expect(fake.responses[0]!.kind).toBe('update');
    expect(payload(fake)).toMatchObject({ content: 'Template deleted.', components: [] });
    expect(await t.database.admin.select().from(templates)).toHaveLength(0);
    expect(discord.channels.has(row.threadId)).toBe(false);
    expect(emitted).toEqual([`deleted ${row.id}`]);
  });

  it('answers before the thread goes and reports a post that could not be removed', async () => {
    const row = await makeTemplate();
    discord.override('DELETE', `/channels/${row.threadId}`, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    const fake = await confirm(row.threadId, await confirmId(row.threadId));
    expect(fake.responses.map((response) => response.kind)).toEqual(['update', 'followUp']);
    expect(payload(fake)).toMatchObject({ content: 'Template deleted.', components: [] });
    expect(payload(fake, 1).content).toBe("Template deleted, but its post couldn't be removed.");
    expect(await t.database.admin.select().from(templates)).toHaveLength(0);
    expect(emitted).toEqual([`deleted ${row.id}`]);
  });

  it('keeps everything and shows the reasons when a listener denies', async () => {
    const row = await makeTemplate();
    denial = ['Used by the welcome message.'];
    const fake = await confirm(row.threadId, await confirmId(row.threadId));
    expect(fake.responses[0]!.kind).toBe('update');
    expect(payload(fake)).toMatchObject({ content: "Can't delete this template:\n• Used by the welcome message.", components: [] });
    expect(await t.database.admin.select().from(templates)).toHaveLength(1);
    expect(discord.channels.has(row.threadId)).toBe(true);
    expect(emitted).toEqual([]);
  });

  it('is refused for members who may not post in the thread', async () => {
    const row = await makeTemplate();
    const fake = await click(row.threadId, 'delete', { userId: MEMBER, permissions: PermissionFlagsBits.ViewChannel });
    expect(payload(fake).content).toBe('You need permission to post in this forum to change templates.');
  });
});
