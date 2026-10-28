import { FakeDiscordHttp, type FakeInteraction, type UploadedFile } from '@bronto/core/testing';
import { ChannelType } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { drafts, forms, openers, submissions, type Form } from '../src/db/schema.js';
import type { Field } from '../src/model.js';
import { openButton } from '../src/open.js';
import { formsDb, GUILD, inHandler, prepareFormsBot, ready, USER, type FormsBot, type FormsBotOptions } from './harness.js';
import { buttonId, click, makeForm, payload, shownModal, storeForum, submitModal, toJson, type Filled, type Json, type Who } from './ui.js';

// Made-up IDs; tests never use real server data.
export const TEXT = '100000000000000070';
export const SUBMIT = '100000000000000072';
export const ROLE = '100000000000000300';
export const PING_ROLE = '100000000000000301';

export const text = (n: number, extra: Partial<Field> = {}): Field => ({ id: `q000000${n}`, type: 'short', label: `Question ${n}`, required: false, ...extra }) as Field;
export const fileField = (n: number, extra: Partial<Field> = {}): Field =>
  ({ id: `f000000${n}`, type: 'file', label: `Files ${n}`, required: false, maxFiles: 3, fileTypes: [], ...extra }) as Field;

export interface Filling {
  t: TestDatabase;
  discord: FakeDiscordHttp;
  fb: FormsBot;
}

export async function startFilling(t: TestDatabase, roles: string[] = [], options: FormsBotOptions = {}): Promise<Filling> {
  const discord = new FakeDiscordHttp();
  for (const id of [TEXT, SUBMIT]) discord.addChannel(id, { guildId: GUILD, type: ChannelType.GuildText });
  const fb = await prepareFormsBot(t, discord, options);
  discord.addRole(GUILD, { id: ROLE });
  discord.addMember(GUILD, USER, { roles });
  await storeForum(t);
  await ready(fb);
  // The role was added after the guild was cached.
  await fb.client.guilds.fetch({ guild: GUILD, force: true });
  return { t, discord, fb };
}

/** A form with `fields`, active and posting to SUBMIT unless `change` says otherwise. */
export async function formWith(f: Filling, fields: Field[], change: Partial<Form> = {}): Promise<Form> {
  const form = await makeForm(f.fb);
  const [row] = await formsDb(f.t).run(async (tx) =>
    tx
      .update(forms)
      .set({ fields, active: true, channelId: SUBMIT, ...change })
      .where(eq(forms.id, form.id))
      .returning(),
  );
  return row!;
}

export async function setForm(f: Filling, formId: string, change: Partial<Form>): Promise<void> {
  await formsDb(f.t).run(async (tx) => {
    await tx.update(forms).set(change).where(eq(forms.id, formId));
  });
}

/** The custom ID of an opener button for the form in TEXT. */
export async function openerId(f: Filling, form: Form): Promise<string> {
  const [row] = await formsDb(f.t).run(async (tx) => tx.insert(openers).values({ formId: form.id, channelId: TEXT, messageId: '100000000000000400', label: form.name }).returning());
  return inHandler(f.fb, async (ctx) => ctx.customId(openButton, [row!.id]));
}

export const open = (f: Filling, customId: string, who: Who = {}) => click(f.fb, TEXT, customId, who);

export const submitPage = (f: Filling, modal: Json, filled: Filled = {}, who: Who = {}) => submitModal(f.fb, TEXT, modal, filled, who);

export const replyOf = (fake: FakeInteraction, index = 0): Json => payload(fake, index);
export const contentOf = (fake: FakeInteraction, index = 0) => String(replyOf(fake, index).content ?? '');

export const clickIn = (f: Filling, message: Json, label: string, who: Who = {}) => click(f.fb, TEXT, buttonId(message, label), who);

export const draftRows = (f: Filling) => f.t.database.admin.select().from(drafts);
export const submissionRows = (f: Filling) => f.t.database.admin.select().from(submissions);

/** The messages of a channel as stored by the fake. */
export function messagesIn(f: Filling, channelId: string): Json[] {
  return [...f.discord.messages.values()].filter((message) => message.channel_id === channelId).map((message) => toJson(message));
}

/** A file a member uploads in a modal, stored on the fake CDN. */
export function upload(f: Filling, filename: string, bytes: number | string, contentType?: string): UploadedFile {
  const data = typeof bytes === 'number' ? Buffer.alloc(bytes, 1) : Buffer.from(bytes);
  const attachment = f.discord.addFile(TEXT, { filename, data, contentType });
  return { id: attachment.id, filename, url: attachment.url, size: attachment.size, contentType: attachment.content_type };
}

/** Opens the form and returns the shown modal. */
export async function openModal(f: Filling, customId: string, who: Who = {}): Promise<Json> {
  return shownModal(await open(f, customId, who));
}

/** Labels of a modal, in order. */
export const labelsOf = (modal: Json): string[] => (modal.components as Json[]).map((label) => label.label);
