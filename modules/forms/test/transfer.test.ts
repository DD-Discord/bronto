import { FakeDiscordHttp } from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, openers, type Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { formsDb, GUILD, prepareFormsBot, ready, USER, type FormsBot } from './harness.js';
import { buttonId, click, clickPreview, makeForm, modalInputs, payload, shownModal, storeForum, storedForm, submitModal, textOf } from './ui.js';

let t: TestDatabase;
let discord: FakeDiscordHttp;
let fb: FormsBot;

const TEXT = '100000000000000070';

beforeEach(async () => {
  t = await createTestDatabase();
  discord = new FakeDiscordHttp();
  discord.addChannel(TEXT, { guildId: GUILD, type: ChannelType.GuildText });
  fb = await prepareFormsBot(t, discord);
  discord.addMember(GUILD, USER);
  await storeForum(t);
  await ready(fb);
});

afterEach(async () => {
  await fb.bot.stop();
  await t.drop();
});

const fields: Field[] = [
  { id: 'aaaaaaa1', type: 'short', label: 'Name', required: true, maxLength: 40 },
  { id: 'aaaaaaa2', type: 'select', label: 'Genre', required: false, options: ['Fantasy', 'Horror'] },
  { id: 'aaaaaaa3', type: 'file', label: 'Cover', required: false, maxFiles: 2, fileTypes: ['image'] },
];

async function configured(name: string, over: Partial<Form> = {}): Promise<Form> {
  const form = await makeForm(fb, name);
  await formsDb(t).run(async (tx) => {
    await tx.update(forms).set({ fields, channelId: TEXT, active: true, oncePerMember: false, ...over }).where(eq(forms.id, form.id));
  });
  return storedForm(t, form.id);
}

async function exported(form: Form): Promise<string> {
  const fake = await clickPreview(fb, discord, form.threadId, 'Export');
  const file = (payload(fake).files as { attachment: Buffer; name: string }[])[0]!;
  expect(file.name).toBe('story-contest.json');
  return file.attachment.toString('utf8');
}

async function importText(form: Form, text: string, over: { uploads?: any } = {}) {
  const open = await clickPreview(fb, discord, form.threadId, 'Import');
  return submitModal(fb, form.threadId, shownModal(open), { fields: { json: text }, uploads: { file: [], ...over.uploads } });
}

describe('export and import', () => {
  it('imports an exported form into a second form with equal settings and fields', async () => {
    const source = await configured('Story contest');
    const target = await makeForm(fb, 'Poetry slam');
    const text = await exported(source);
    const done = await importText(target, text);
    expect(payload(done).content).toContain('imported');
    const row = await storedForm(t, target.id);
    expect(row.fields).toEqual(fields);
    expect(row).toMatchObject({ name: 'Story contest', active: true, channelId: TEXT, oncePerMember: false });
    expect(textOf(JSON.parse(JSON.stringify(discord.messages.get(target.threadId))))).toContain('Story contest');
  });

  it('reports invalid JSON', async () => {
    const form = await makeForm(fb);
    const done = await importText(form, '{nope');
    expect(payload(done).content).toContain('not valid JSON');
    expect(await storedForm(t, form.id)).toMatchObject({ fields: [] });
  });

  it('reports an invalid form with the path', async () => {
    const form = await makeForm(fb);
    const done = await importText(form, JSON.stringify({ version: 1, settings: { name: 'x' }, fields: [] }));
    expect(payload(done).content).toContain('Invalid form');
  });

  it('asks for JSON when the modal is empty', async () => {
    const form = await makeForm(fb);
    expect(payload(await importText(form, '  ')).content).toContain('Paste');
  });

  it('gives imported fields new IDs when they were removed from the form before', async () => {
    const source = await configured('Story contest');
    const target = await makeForm(fb, 'Poetry slam');
    await formsDb(t).run(async (tx) => {
      await tx.update(forms).set({ removedFieldIds: ['aaaaaaa2'] }).where(eq(forms.id, target.id));
    });
    await importText(target, await exported(source));
    const row = await storedForm(t, target.id);
    expect(row.fields.map((f) => f.label)).toEqual(['Name', 'Genre', 'Cover']);
    expect(row.fields[1]!.id).not.toBe('aaaaaaa2');
    expect(row.fields[0]!.id).toBe('aaaaaaa1');
    expect(row.removedFieldIds).toContain('aaaaaaa2');
  });

  it('gives a field whose type an import changes a new ID and records the old one as removed', async () => {
    const form = await configured('Story contest');
    const changed = fields.map((field) => (field.id === 'aaaaaaa1' ? { id: 'aaaaaaa1', type: 'long', label: 'Name', required: true } : field));
    const json = JSON.stringify({ version: 1, settings: { name: 'Story contest', active: true, channelId: TEXT, pingUserIds: [], pingRoleIds: [], allowedRoleIds: [], oncePerMember: false }, fields: changed });
    await importText(form, json);
    const row = await storedForm(t, form.id);
    expect(row.fields[0]).toMatchObject({ type: 'long', label: 'Name' });
    expect(row.fields[0]!.id).not.toBe('aaaaaaa1');
    expect(row.fields.slice(1).map((field) => field.id)).toEqual(['aaaaaaa2', 'aaaaaaa3']);
    expect(row.removedFieldIds).toEqual(['aaaaaaa1']);
  });

  it('records the fields an import replaces as removed', async () => {
    const form = await configured('Story contest');
    const bare = JSON.stringify({ version: 1, settings: { name: 'Story contest', active: false, channelId: null, pingUserIds: [], pingRoleIds: [], allowedRoleIds: [], oncePerMember: true }, fields: [] });
    await importText(form, bare);
    const row = await storedForm(t, form.id);
    expect(row.fields).toEqual([]);
    expect(row.removedFieldIds.sort()).toEqual(['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3']);
  });

  it('refuses imported settings the member may not set', async () => {
    const form = await makeForm(fb);
    const bad = JSON.stringify({ version: 1, settings: { name: 'X', active: false, channelId: '100000000000000999', pingUserIds: [], pingRoleIds: [], allowedRoleIds: [], oncePerMember: true }, fields: [] });
    expect(payload(await importText(form, bad)).content).toContain('100000000000000999');
  });
});

describe('delete', () => {
  it('is refused while openers exist, naming their channels', async () => {
    const form = await configured('Story contest');
    await formsDb(t).run(async (tx) => {
      await tx.insert(openers).values({ formId: form.id, channelId: TEXT, messageId: null, label: 'Apply' });
    });
    const done = await clickPreview(fb, discord, form.threadId, 'Delete');
    expect(payload(done).content).toContain(`<#${TEXT}>`);
    expect(payload(done).content).toContain('form buttons');
    expect(payload(done).content).not.toContain('opener');
    expect(await storedForm(t, form.id)).toBeDefined();
    expect(discord.channels.has(form.threadId)).toBe(true);
  });

  it('refuses at the confirmation too when an opener appeared meanwhile', async () => {
    const form = await configured('Story contest');
    const ask = await clickPreview(fb, discord, form.threadId, 'Delete');
    await formsDb(t).run(async (tx) => {
      await tx.insert(openers).values({ formId: form.id, channelId: TEXT, messageId: null, label: 'Apply' });
    });
    const done = await click(fb, form.threadId, buttonId(payload(ask), 'Delete'));
    expect(JSON.stringify(payload(done))).toContain(`<#${TEXT}>`);
    expect(await storedForm(t, form.id)).toBeDefined();
    expect(discord.channels.has(form.threadId)).toBe(true);
  });

  it('deletes the form, its post and its rows after confirmation', async () => {
    const form = await configured('Story contest');
    const ask = await clickPreview(fb, discord, form.threadId, 'Delete');
    expect(payload(ask).content).toContain('Story contest');
    await click(fb, form.threadId, buttonId(payload(ask), 'Delete'));
    expect(await t.database.admin.select().from(forms)).toEqual([]);
    expect(discord.channels.has(form.threadId)).toBe(false);
    expect(await t.database.admin.select().from(openers)).toEqual([]);
  });
});
