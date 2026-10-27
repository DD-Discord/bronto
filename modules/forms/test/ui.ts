import {
  fakeButton,
  fakeModal,
  fakeSelect,
  type FakeDiscordHttp,
  type FakeInteraction,
  type UploadedFile,
} from '@bronto/core/testing';
import { Events } from 'discord.js';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { TestDatabase } from '../../../packages/core/test/test-db.js';
import { forms, forums, type Form } from '../src/db/schema.js';
import { createFormPost } from '../src/new-post.js';
import { FORUM, GUILD, formsDb, inHandler, USER, type FormsBot } from './harness.js';

export type Json = Record<string, any>;

export const toJson = (value: unknown): Json =>
  (typeof (value as Json).toJSON === 'function' ? (value as Json).toJSON() : value) as Json;

/** Every component of a message, nested ones included. */
export function allComponents(components: unknown[] = []): Json[] {
  return components.map(toJson).flatMap((component) => [component, ...allComponents(component.components ?? [])]);
}

export const payload = (fake: FakeInteraction, index = 0): Json => toJson(fake.responses[index]!.payload);

/** The text and labels of a message, one per line. */
export function textOf(message: Json): string {
  return allComponents(message.components)
    .flatMap((component) => [component.content, component.label])
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

/** The custom ID of the button with `label` in a message. */
export function buttonId(message: Json, label: string): string {
  const found = allComponents(message.components).find((component) => component.label === label && component.custom_id !== undefined);
  if (found === undefined) throw new Error(`No button "${label}" in: ${textOf(message)}`);
  return found.custom_id;
}

export function selectOf(message: Json): Json {
  const found = allComponents(message.components).find((component) => Array.isArray(component.options));
  if (found === undefined) throw new Error('No select in the message');
  return found;
}

export async function send<T extends FakeInteraction>(fb: FormsBot, fake: T): Promise<T> {
  fb.client.emit(Events.InteractionCreate, fake as never);
  await fb.bot.idle();
  return fake;
}

export interface Who {
  userId?: string;
  permissions?: bigint;
}

export const click = (fb: FormsBot, threadId: string, customId: string, who: Who = {}) =>
  send(fb, fakeButton({ customId, guildId: GUILD, channelId: threadId, userId: USER, ...who }));

export const choose = (fb: FormsBot, threadId: string, customId: string, values: string[], who: Who = {}) =>
  send(fb, fakeSelect({ customId, values, guildId: GUILD, channelId: threadId, userId: USER, ...who }));

/** Clicks the preview button labelled `label`. */
export function clickPreview(fb: FormsBot, discord: FakeDiscordHttp, threadId: string, label: string, who: Who = {}) {
  return click(fb, threadId, buttonId(toJson(discord.messages.get(threadId)), label), who);
}

export function shownModal(fake: FakeInteraction): Json {
  expect(fake.responses[0]!.kind).toBe('showModal');
  return payload(fake);
}

/** The components of a modal by custom ID, one entry per label. */
export function modalInputs(modal: Json): Record<string, Json> {
  return Object.fromEntries((modal.components as Json[]).map((label) => [label.component.custom_id, { ...label.component, label: label.label, description: label.description }]));
}

export interface Filled {
  fields?: Record<string, string>;
  checkboxes?: Record<string, boolean>;
  selections?: Record<string, string[]>;
  mentionables?: Record<string, { users?: string[]; roles?: string[] }>;
  uploads?: Record<string, UploadedFile[]>;
}

/** Submits a modal with its prefilled values, overridden by `filled`. */
export function submitModal(fb: FormsBot, threadId: string, modal: Json, filled: Filled = {}, who: Who = {}) {
  const fields: Record<string, string> = {};
  const checkboxes: Record<string, boolean> = {};
  for (const [id, input] of Object.entries(modalInputs(modal))) {
    if (input.type === 4) fields[id] = input.value ?? '';
    else if (input.type === 23) checkboxes[id] = input.default ?? false;
  }
  return send(
    fb,
    fakeModal({
      customId: modal.custom_id,
      guildId: GUILD,
      channelId: threadId,
      userId: USER,
      ...who,
      fields: { ...fields, ...filled.fields },
      checkboxes: { ...checkboxes, ...filled.checkboxes },
      selections: filled.selections,
      mentionables: filled.mentionables,
      uploads: filled.uploads,
    }),
  );
}

export async function storeForum(t: TestDatabase): Promise<void> {
  await formsDb(t).run(async (tx) => {
    await tx.insert(forums).values({ forumChannelId: FORUM });
  });
}

/** Creates a form with its post and preview. */
export async function makeForm(fb: FormsBot, name = 'Story contest'): Promise<Form> {
  return inHandler(fb, (ctx) => createFormPost(ctx, { name }));
}

export async function storedForm(t: TestDatabase, id: string): Promise<Form> {
  const [row] = await t.database.admin.select().from(forms).where(eq(forms.id, id));
  return row!;
}

/** Adds a field through the UI: Add field, the type, then the modal with `filled` on top of its defaults. */
export async function addField(fb: FormsBot, discord: FakeDiscordHttp, form: Form, type: string, filled: Filled) {
  const open = await clickPreview(fb, discord, form.threadId, 'Add field');
  const menu = payload(open);
  const picked = await choose(fb, form.threadId, selectOf(menu).custom_id, [type]);
  return submitModal(fb, form.threadId, shownModal(picked), filled);
}
