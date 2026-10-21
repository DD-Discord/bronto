import { defineModule, on } from '@bronto/core';
import { fakeButton, fakeModal, fakeSelect, FakeDiscordHttp, type FakeInteraction } from '@bronto/core/testing';
import { ChannelType, Events, MessageFlags, PermissionFlagsBits, type APIEmbed } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { templatesApi } from '../src/api.js';
import { render } from '../src/render.js';
import { refreshPreview } from '../src/save.js';
import { forums, templateImages, templates } from '../src/db/schema.js';
import { templatesEvents } from '../src/events.js';
import { createTemplatesModule } from '../src/index.js';
import { FORUM, GUILD, inHandler, prepareTemplatesBot, ready, templatesDb, USER, type TemplatesBot } from './harness.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let tb: TemplatesBot;
let emitted: string[];

const TEXT = '100000000000000030';
const MEMBER = '100000000000000098';

const listener = defineModule({
  name: 'listener',
  dependsOn: [createTemplatesModule()],
  listeners: [on(templatesEvents.updated, (_ctx, { id }) => void emitted.push(`updated ${id}`))],
});

beforeEach(async () => {
  emitted = [];
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  tb = await prepareTemplatesBot(t, discord, { extra: [{ packageName: '@test/listener', definition: listener, config: {} }] });
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

type Json = Record<string, any>;

async function makeTemplate(input: { content?: string; embed?: APIEmbed | null } = {}) {
  const { id } = await inHandler(tb, (ctx) =>
    templatesApi(ctx).create({ name: 'Welcome rules', content: input.content ?? 'Hello', embed: input.embed === undefined ? { title: 'Welcome' } : input.embed }),
  );
  return stored(id);
}

async function stored(id: string) {
  const [row] = await t.database.admin.select().from(templates).where(eq(templates.id, id));
  return row!;
}

async function send<T extends FakeInteraction>(fake: T): Promise<T> {
  tb.client.emit(Events.InteractionCreate, fake as never);
  await tb.bot.idle();
  return fake;
}

const payload = (fake: FakeInteraction, index = 0) => fake.responses[index]!.payload as Json;
const toJson = (value: unknown): Json => (typeof (value as Json).toJSON === 'function' ? (value as Json).toJSON() : value) as Json;

/** Every component of a message, nested ones and section accessories included. */
function allComponents(components: Json[]): Json[] {
  return components.map(toJson).flatMap((component) => [
    component,
    ...allComponents(component.components ?? []),
    ...(component.accessory === undefined ? [] : [toJson(component.accessory)]),
  ]);
}

function customIdIn(message: Json, prefix: string): string {
  const id = allComponents(message.components ?? [])
    .map((component) => component.custom_id as string | undefined)
    .find((candidate) => candidate?.startsWith(prefix));
  if (id === undefined) throw new Error(`No component ${prefix} in the message`);
  return id;
}

function previewButtonId(threadId: string, name: string): string {
  return customIdIn(discord.messages.get(threadId) as unknown as Json, `templates:${name}:`);
}

/** Clicks Edit on the preview and returns the editor message. */
async function openEditor(threadId: string, options: { userId?: string; permissions?: bigint } = {}) {
  const fake = await send(fakeButton({ customId: previewButtonId(threadId, 'edit'), guildId: GUILD, channelId: threadId, userId: USER, ...options }));
  return { fake, editor: payload(fake) };
}

const click = (threadId: string, customId: string, options: { attachmentSizeLimit?: number } = {}) =>
  send(fakeButton({ customId, guildId: GUILD, channelId: threadId, userId: USER, ...options }));

/** A shown modal as JSON. */
function shownModal(fake: FakeInteraction): Json {
  expect(fake.responses[0]!.kind).toBe('showModal');
  return toJson(payload(fake));
}

/** The inputs of a modal: text values as prefilled, checkboxes as set. */
function inputsOf(modal: Json) {
  const fields: Record<string, string> = {};
  const checkboxes: Record<string, boolean> = {};
  const uploads: Record<string, never[]> = {};
  for (const label of modal.components as Json[]) {
    const input = label.component;
    if (input === undefined) continue;
    if (input.type === 4) fields[input.custom_id] = input.value ?? '';
    else if (input.type === 23) checkboxes[input.custom_id] = input.default ?? false;
    else if (input.type === 19) uploads[input.custom_id] = [];
  }
  return { fields, checkboxes, uploads };
}

type Upload = { filename: string; url: string; size: number; contentType?: string };

/** Submits a modal with its prefilled values, changed by `changes`. */
function submit(
  threadId: string,
  modal: Json,
  changes: { fields?: Record<string, string>; checkboxes?: Record<string, boolean>; uploads?: Record<string, Upload[]> } = {},
  options: { attachmentSizeLimit?: number } = {},
) {
  const inputs = inputsOf(modal);
  return fakeModal({
    customId: modal.custom_id,
    guildId: GUILD,
    channelId: threadId,
    userId: USER,
    fields: { ...inputs.fields, ...changes.fields },
    checkboxes: { ...inputs.checkboxes, ...changes.checkboxes },
    uploads: { ...inputs.uploads, ...changes.uploads },
    ...options,
  });
}

async function openSection(threadId: string, editor: Json, section: string): Promise<Json> {
  return shownModal(await click(threadId, customIdIn(editor, `templates:section:${section}:`)));
}

async function openField(threadId: string, editor: Json, index: number): Promise<Json> {
  const customId = customIdIn(editor, 'templates:field:');
  return shownModal(await send(fakeSelect({ customId, guildId: GUILD, channelId: threadId, userId: USER, values: [String(index)] })));
}

/** Opens the editor and the section's modal, submits it with `changes` and returns the modal's interaction. */
async function edit(threadId: string, section: string, changes: Parameters<typeof submit>[2], options: Parameters<typeof submit>[3] = {}) {
  const { editor } = await openEditor(threadId);
  const modal = await openSection(threadId, editor, section);
  return send(submit(threadId, modal, changes, options));
}

function previewOf(threadId: string): Json {
  return discord.messages.get(threadId) as unknown as Json;
}

function textOf(message: Json): string {
  return allComponents(message.components ?? [])
    .filter((component) => typeof component.content === 'string')
    .map((component) => component.content)
    .join('\n');
}

async function uploadedImage(name = 'cat.png', bytes = Buffer.from('png bytes')): Promise<Upload> {
  const channel = await tb.client.channels.fetch(TEXT);
  if (channel === null || channel.type !== ChannelType.GuildText) throw new Error('no channel');
  const message = await channel.send({ files: [{ attachment: bytes, name }] });
  const file = message.attachments.first()!;
  return { filename: file.name, url: file.url, size: file.size, contentType: 'image/png' };
}

/** Expects a saved modal: the editor was redrawn in place. */
function expectRedrawn(fake: FakeInteraction): Json {
  expect(fake.responses.map((response) => response.kind)).toEqual(['update']);
  const editor = payload(fake);
  expect(editor.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
  return editor;
}

describe('opening the editor', () => {
  it('replies with the Components V2 editor, privately', async () => {
    const row = await makeTemplate();
    const { fake, editor } = await openEditor(row.threadId);
    expect(fake.responses[0]!.kind).toBe('reply');
    expect(editor.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(editor.flags & MessageFlags.IsComponentsV2).toBe(MessageFlags.IsComponentsV2);
    expect(textOf(editor)).toContain('## Editing "Welcome rules"');
  });

  it('is refused for members who may not post in the thread', async () => {
    const row = await makeTemplate();
    const { editor } = await openEditor(row.threadId, { permissions: PermissionFlagsBits.ViewChannel, userId: MEMBER });
    expect(editor.content).toBe('You need permission to post in this forum to change templates.');
  });
});

describe('section modals', () => {
  it('saves content, updates the preview and redraws the editor', async () => {
    const row = await makeTemplate();
    const fake = await edit(row.threadId, 'content', { fields: { content: 'New text' } });
    const editor = expectRedrawn(fake);
    expect(textOf(editor)).toContain('New text');
    expect((await stored(row.id)).content).toBe('New text');
    expect(previewOf(row.threadId).content).toBe('New text');
    expect(emitted).toEqual([`updated ${row.id}`]);
  });

  it('saves the body', async () => {
    const row = await makeTemplate();
    const fake = await edit(row.threadId, 'body', {
      fields: { title: 'Rules', description: 'Be nice.', url: 'https://example.com/rules', color: '#5865F2' },
    });
    expectRedrawn(fake);
    const embed = { title: 'Rules', description: 'Be nice.', url: 'https://example.com/rules', color: 0x5865f2 };
    expect((await stored(row.id)).embed).toEqual(embed);
    expect(previewOf(row.threadId).embeds).toEqual([embed]);
    expect(toJson(payload(fake).components[0]).accent_color).toBe(0x5865f2);
  });

  it('saves the author', async () => {
    const row = await makeTemplate();
    await edit(row.threadId, 'author', { fields: { name: 'Staff', url: 'https://example.com', icon_url: 'https://example.com/a.png' } });
    expect((await stored(row.id)).embed!.author).toEqual({ name: 'Staff', url: 'https://example.com', icon_url: 'https://example.com/a.png' });
  });

  it('saves the footer and the time of posting', async () => {
    const row = await makeTemplate();
    await edit(row.threadId, 'footer', { fields: { text: 'Thanks' }, checkboxes: { show_time: true } });
    const saved = await stored(row.id);
    expect(saved.embed!.footer).toEqual({ text: 'Thanks' });
    expect(saved.showPostTime).toBe(true);
  });

  it('creates the embed when a section of a template without one is filled', async () => {
    const row = await makeTemplate({ embed: null });
    await edit(row.threadId, 'images', { fields: { image_url: 'https://example.com/i.png' } });
    expect((await stored(row.id)).embed).toEqual({ image: { url: 'https://example.com/i.png' } });
  });

  it('saves image links', async () => {
    const row = await makeTemplate();
    await edit(row.threadId, 'images', { fields: { image_url: 'https://example.com/i.png', thumbnail_url: 'https://example.com/t.png' } });
    expect((await stored(row.id)).embed).toMatchObject({ image: { url: 'https://example.com/i.png' }, thumbnail: { url: 'https://example.com/t.png' } });
  });

  it('refuses links that are not http(s) and offers to try again', async () => {
    const row = await makeTemplate();
    const fake = await edit(row.threadId, 'images', { fields: { image_url: 'ftp://example.com/i.png' } });
    expect(fake.responses[0]!.kind).toBe('reply');
    expect(textOf(payload(fake))).toContain('Links must start with http:// or https://.');
    expect((await stored(row.id)).embed).toEqual({ title: 'Welcome' });
    expect(emitted).toEqual([]);
  });

  it('says so when the post could not be updated after saving', async () => {
    const row = await makeTemplate();
    discord.override('PATCH', `/channels/${row.threadId}/messages/${row.previewMessageId}`, () => ({
      status: 403,
      json: { code: 50013, message: 'Missing Permissions' },
    }));
    const fake = await edit(row.threadId, 'content', { fields: { content: 'Saved text' } });
    expect(fake.responses.map((response) => response.kind)).toEqual(['update', 'followUp']);
    expect(payload(fake, 1).content).toMatch(/^Saved, but the post couldn't be updated: .*Missing Permissions/);
    expect((await stored(row.id)).content).toBe('Saved text');
    expect(emitted).toEqual([`updated ${row.id}`]);
  });
});

describe('uploads', () => {
  it('replaces a link with an uploaded image', async () => {
    const row = await makeTemplate({ embed: { title: 'T', image: { url: 'https://example.com/i.png' } } });
    const file = await uploadedImage();
    expectRedrawn(await edit(row.threadId, 'images', { uploads: { image_upload: [file] } }));
    expect((await stored(row.id)).embed).toEqual({ title: 'T', image: { url: 'attachment://image.png' } });
    const images = await t.database.admin.select().from(templateImages);
    expect(images.map((image) => image.slot)).toEqual(['image']);
    const preview = previewOf(row.threadId);
    expect(preview.attachments.map((attachment: Json) => attachment.filename)).toEqual(['image.png']);
    expect(preview.embeds[0].image.url).toBe('attachment://image.png');
  });

  it('keeps an uploaded image while its field is unchanged and removes it when cleared', async () => {
    const row = await makeTemplate();
    await edit(row.threadId, 'images', { uploads: { thumbnail_upload: [await uploadedImage()] } });
    await edit(row.threadId, 'body', { fields: { title: 'Other' } });
    expect((await stored(row.id)).embed!.thumbnail).toEqual({ url: 'attachment://thumbnail.png' });
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(1);

    await edit(row.threadId, 'images', { fields: { thumbnail_url: '' } });
    expect((await stored(row.id)).embed!.thumbnail).toBeUndefined();
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(0);
    expect(previewOf(row.threadId).attachments).toEqual([]);
  });

  it('refuses a file over the upload limit', async () => {
    const row = await makeTemplate();
    const file = { ...(await uploadedImage()), size: 3 * 1024 * 1024 };
    const fake = await edit(row.threadId, 'images', { uploads: { image_upload: [file] } }, { attachmentSizeLimit: 2 * 1024 * 1024 });
    expect(textOf(payload(fake))).toContain('That file is larger than I can upload here (2 MB).');
    expect((await stored(row.id)).embed).toEqual({ title: 'Welcome' });
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(0);
  });

  it('refuses an author icon without an author name', async () => {
    const row = await makeTemplate();
    const fake = await edit(row.threadId, 'author', { uploads: { icon_upload: [await uploadedImage()] } });
    expect(textOf(payload(fake))).toContain('An author icon needs an author name.');
  });
});

describe('fields', () => {
  const three = { title: 'T', fields: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }, { name: 'C', value: '3' }] };

  it('adds a field', async () => {
    const row = await makeTemplate();
    const fake = await edit(row.threadId, 'add-field', { fields: { name: 'Rule', value: 'Be kind' }, checkboxes: { inline: true } });
    expect(textOf(expectRedrawn(fake))).toContain('**Fields (1/25)');
    expect((await stored(row.id)).embed!.fields).toEqual([{ name: 'Rule', value: 'Be kind', inline: true }]);
  });

  it('edits a field picked from the select', async () => {
    const row = await makeTemplate({ embed: three });
    const { editor } = await openEditor(row.threadId);
    const modal = await openField(row.threadId, editor, 1);
    expect(inputsOf(modal).fields).toMatchObject({ name: 'B', value: '2', position: '2' });
    expectRedrawn(await send(submit(row.threadId, modal, { fields: { value: 'two' } })));
    expect((await stored(row.id)).embed!.fields!.map((field) => field.value)).toEqual(['1', 'two', '3']);
  });

  it('moves a field to another position, clamping out-of-range positions', async () => {
    const row = await makeTemplate({ embed: three });
    let { editor } = await openEditor(row.threadId);
    await send(submit(row.threadId, await openField(row.threadId, editor, 0), { fields: { position: '3' } }));
    expect((await stored(row.id)).embed!.fields!.map((field) => field.name)).toEqual(['B', 'C', 'A']);
    ({ editor } = await openEditor(row.threadId));
    await send(submit(row.threadId, await openField(row.threadId, editor, 2), { fields: { position: '0' } }));
    expect((await stored(row.id)).embed!.fields!.map((field) => field.name)).toEqual(['A', 'B', 'C']);
    ({ editor } = await openEditor(row.threadId));
    await send(submit(row.threadId, await openField(row.threadId, editor, 0), { fields: { position: '99' } }));
    expect((await stored(row.id)).embed!.fields!.map((field) => field.name)).toEqual(['B', 'C', 'A']);
  });

  it('deletes a field whose name and value are cleared', async () => {
    const row = await makeTemplate({ embed: three });
    const { editor } = await openEditor(row.threadId);
    await send(submit(row.threadId, await openField(row.threadId, editor, 1), { fields: { name: '', value: '' } }));
    expect((await stored(row.id)).embed!.fields!.map((field) => field.name)).toEqual(['A', 'C']);
  });

  it('refuses a 6000-character overflow and reopens the form with what was typed', async () => {
    const big = Array.from({ length: 5 }, (_, i) => ({ name: `F${i}`, value: 'v'.repeat(1000) }));
    const row = await makeTemplate({ embed: { description: 'd'.repeat(950), fields: big } });
    const typed = 'x'.repeat(1000);
    const fake = await edit(row.threadId, 'add-field', { fields: { name: 'Too much', value: typed } });
    expect(fake.responses[0]!.kind).toBe('reply');
    const error = payload(fake);
    expect(error.flags & MessageFlags.Ephemeral).toBe(MessageFlags.Ephemeral);
    expect(textOf(error)).toMatch(/longer than 6000 characters/);
    expect((await stored(row.id)).embed!.fields).toHaveLength(5);

    const retry = await click(row.threadId, customIdIn(error, 'templates:try-again:'));
    const modal = shownModal(retry);
    expect(inputsOf(modal).fields).toEqual({ name: 'Too much', value: typed });

    const saved = await send(submit(row.threadId, modal, { fields: { value: 'short' } }));
    expectRedrawn(saved);
    expect((await stored(row.id)).embed!.fields).toHaveLength(6);
  });
});

describe('remove embed', () => {
  it('asks first, then removes the embed', async () => {
    const row = await makeTemplate();
    const { editor } = await openEditor(row.threadId);
    const asked = await click(row.threadId, customIdIn(editor, 'templates:remove-embed:'));
    expect(asked.responses[0]!.kind).toBe('reply');
    expect((await stored(row.id)).embed).not.toBeNull();
    const confirmed = await click(row.threadId, customIdIn(payload(asked), 'templates:remove-embed-confirm:'));
    expectRedrawn(confirmed);
    expect((await stored(row.id)).embed).toBeNull();
    expect(previewOf(row.threadId).embeds).toEqual([]);
    expect(emitted).toEqual([`updated ${row.id}`]);
  });

  it('is refused when the template has no content', async () => {
    const row = await makeTemplate({ content: '' });
    const { editor } = await openEditor(row.threadId);
    const asked = await click(row.threadId, customIdIn(editor, 'templates:remove-embed:'));
    expect(payload(asked).content).toBe('The template has no text, so it needs its embed. Add text before removing the embed.');
  });

  it('is refused at confirmation when the content was cleared meanwhile', async () => {
    const row = await makeTemplate();
    const { editor } = await openEditor(row.threadId);
    const asked = await click(row.threadId, customIdIn(editor, 'templates:remove-embed:'));
    await edit(row.threadId, 'content', { fields: { content: '' } });
    const confirmed = await click(row.threadId, customIdIn(payload(asked), 'templates:remove-embed-confirm:'));
    expect(textOf(payload(confirmed)) + (payload(confirmed).content ?? '')).toContain('Add text before removing the embed.');
    expect((await stored(row.id)).embed).not.toBeNull();
  });
});

describe('concurrency', () => {
  it('lands two saves of different sections submitted together', async () => {
    const row = await makeTemplate();
    const { editor } = await openEditor(row.threadId);
    const content = await openSection(row.threadId, editor, 'content');
    const body = await openSection(row.threadId, editor, 'body');
    const first = submit(row.threadId, content, { fields: { content: 'Both' } });
    const second = submit(row.threadId, body, { fields: { title: 'Saved' } });
    tb.client.emit(Events.InteractionCreate, first as never);
    tb.client.emit(Events.InteractionCreate, second as never);
    await tb.bot.idle();
    const saved = await stored(row.id);
    expect(saved.content).toBe('Both');
    expect(saved.embed!.title).toBe('Saved');
    expect(previewOf(row.threadId)).toMatchObject({ content: 'Both', embeds: [{ title: 'Saved' }] });
  });

  it('keeps an upload when another save follows right after it', async () => {
    const row = await makeTemplate();
    const { editor } = await openEditor(row.threadId);
    const images = await openSection(row.threadId, editor, 'images');
    const content = await openSection(row.threadId, editor, 'content');
    const file = await uploadedImage();
    tb.client.emit(Events.InteractionCreate, submit(row.threadId, images, { uploads: { image_upload: [file] } }) as never);
    tb.client.emit(Events.InteractionCreate, submit(row.threadId, content, { fields: { content: 'Next' } }) as never);
    await tb.bot.idle();
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(1);
    expect(previewOf(row.threadId).attachments.map((attachment: Json) => attachment.filename)).toEqual(['image.png']);
  });
});

describe('redraws that fail or do not run', () => {
  const setModule = (enabled: boolean) => tb.bot.lifecycle.setModuleEnabled(GUILD, 'templates', enabled, null);
  const pending = () => [{ slot: 'image' as const, name: 'cat.png', data: Buffer.from('png bytes') }];

  async function referenceUpload(id: string) {
    await t.database.admin.update(templates).set({ embed: { title: 'Welcome', image: { url: 'attachment://image.png' } } }).where(eq(templates.id, id));
  }

  it('retries the upload of a failed redraw with the next save, and renders without it meanwhile', async () => {
    const row = await makeTemplate();
    const path = `/channels/${row.threadId}/messages/${row.previewMessageId}`;
    discord.override('PATCH', path, () => ({ status: 403, json: { code: 50013, message: 'Missing Permissions' } }));
    const failed = await edit(row.threadId, 'images', { uploads: { image_upload: [await uploadedImage()] } });
    expect(payload(failed, 1).content).toMatch(/^Saved, but the post couldn't be updated/);
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(0);
    expect((await inHandler(tb, (ctx) => render(ctx, row.id)))!.embed).toEqual({ title: 'Welcome' });

    discord.clearOverride('PATCH', path);
    await edit(row.threadId, 'content', { fields: { content: 'Next' } });
    expect((await t.database.admin.select().from(templateImages)).map((image) => image.slot)).toEqual(['image']);
    expect(previewOf(row.threadId).attachments.map((attachment: Json) => attachment.filename)).toEqual(['image.png']);
    expect((await inHandler(tb, (ctx) => render(ctx, row.id)))!.embed!.image!.url).toMatch(/^https:\/\/cdn\.discordapp\.com\/attachments\/.*\/image\.png/);
  });

  it('keeps the uploads of a redraw the queue skipped for the next save', async () => {
    const row = await makeTemplate();
    await referenceUpload(row.id);
    await setModule(false);
    const error = await inHandler(tb, (ctx) => refreshPreview(ctx, row.id, pending()));
    expect((error as Error).message).toBe("the update didn't run.");
    await setModule(true);
    await edit(row.threadId, 'content', { fields: { content: 'Next' } });
    expect((await t.database.admin.select().from(templateImages)).map((image) => image.slot)).toEqual(['image']);
  });

  it('drops waiting uploads and drafts when the module stops in the guild', async () => {
    const row = await makeTemplate();
    const failed = await edit(row.threadId, 'body', { fields: { color: 'nope' } });
    const retryId = customIdIn(payload(failed), 'templates:try-again:');
    await referenceUpload(row.id);
    await setModule(false);
    await inHandler(tb, (ctx) => refreshPreview(ctx, row.id, pending()));
    await setModule(true);
    await setModule(false);
    await setModule(true);

    const retry = await click(row.threadId, retryId);
    expect(payload(retry).content).toBe('That form has expired. Open the editor again.');
    await edit(row.threadId, 'content', { fields: { content: 'Next' } });
    expect(await t.database.admin.select().from(templateImages)).toHaveLength(0);
    expect(previewOf(row.threadId).attachments).toEqual([]);
  });
});
