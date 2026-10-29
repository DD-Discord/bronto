import { defineSelect, UserError, type Autocomplete } from '@bronto/core';
import sticky from '@bronto/sticky';
import templates from '@bronto/templates';
import {
  ActionRowBuilder,
  DiscordAPIError,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  type GuildBasedChannel,
} from 'discord.js';
import { and, asc, count, eq, ilike, isNull, max, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { editorBinding } from './binding.js';
import type { FormsContext } from './context.js';
import { forms, openers, type Form, type Opener } from './db/schema.js';
import { cleanupOpeners, loadOpeners, MAX_OPENERS, openerRows, refreshMessages, type LiveOpener } from './openers.js';

const MAX_LABEL = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_LINK = /^https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/;
const MAX_CONTENT = 2000;
const MAX_SELECT = 25;

const clip = (text: string, length: number) => Array.from(text).slice(0, length).join('');

/** Forms whose name contains the query, for the `form` option; the value is the form's ID. */
export const suggestForms: Autocomplete = async (ctx, query) => {
  const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await (ctx as FormsContext).db.run(async (tx) =>
    tx.select({ id: forms.id, name: forms.name }).from(forms).where(ilike(forms.name, pattern)).orderBy(sql`lower(${forms.name})`, asc(forms.name)).limit(MAX_SELECT),
  );
  return rows.map((row) => ({ name: clip(row.name, 100), value: row.id }));
};

async function findForm(ctx: FormsContext, value: string): Promise<Form> {
  const [form] = await ctx.db.run(async (tx) =>
    tx.select().from(forms).where(UUID.test(value) ? eq(forms.id, value) : eq(sql`lower(${forms.name})`, value.toLowerCase())).limit(1),
  );
  if (form === undefined) throw new UserError("That form doesn't exist.");
  return form;
}

/**
 * Inserts an opener under a share lock on its form, so the form can't be deleted in between. `scope` selects the
 * message or sticky the button belongs to; its buttons are capped and numbered after the existing ones.
 */
async function insertOpener(
  ctx: FormsContext,
  values: { id: string; formId: string; channelId: string; messageId: string | null; templateId: string | null; label: string },
): Promise<Opener> {
  return ctx.db.run(async (tx) => {
    const [form] = await tx.select({ id: forms.id }).from(forms).where(eq(forms.id, values.formId)).for('key share');
    if (form === undefined) throw new UserError('This form no longer exists.');
    const scope =
      values.messageId === null
        ? and(eq(openers.channelId, values.channelId), isNull(openers.messageId))
        : eq(openers.messageId, values.messageId);
    const [stats] = await tx.select({ count: count(), last: max(openers.position) }).from(openers).where(scope);
    if ((stats?.count ?? 0) >= MAX_OPENERS) {
      throw new UserError(values.messageId === null ? `A sticky holds at most ${MAX_OPENERS} form buttons.` : `A message holds at most ${MAX_OPENERS} form buttons.`);
    }
    const [row] = await tx.insert(openers).values({ ...values, position: (stats?.last ?? -1) + 1 }).returning();
    return row!;
  });
}

const messageUrl = (ctx: FormsContext, channelId: string, messageId: string) => `https://discord.com/channels/${ctx.guildId}/${channelId}/${messageId}`;

function postError(error: unknown, channelId: string): unknown {
  if (error instanceof DiscordAPIError && (error.code === RESTJSONErrorCodes.MissingAccess || error.code === RESTJSONErrorCodes.MissingPermissions)) {
    return new UserError(`I can't post in <#${channelId}>.`);
  }
  return error;
}

export interface PostOptions {
  channel: GuildBasedChannel;
  form: string;
  label: string | null;
  template: string | null;
  message: string | null;
}

/** Runs `/forms post`; returns the reply. */
export async function postOpener(ctx: FormsContext, options: PostOptions): Promise<string> {
  const channelId = options.channel.id;
  const form = await findForm(ctx, options.form);
  const label = clip(options.label ?? form.name, MAX_LABEL);
  if (options.message !== null) return addToMessage(ctx, channelId, form, label, options.message);
  if (options.template !== null) return postMessage(ctx, channelId, form, label, options.template);
  const api = ctx.modules.optional(sticky);
  if (api === null || !(await api.exists(channelId))) throw new UserError(`Give a template, or create a sticky in <#${channelId}> first.`);
  await insertOpener(ctx, { id: randomUUID(), formId: form.id, channelId, messageId: null, templateId: null, label });
  await api.refresh(channelId);
  return `Added a "${label}" button to the sticky in <#${channelId}>.`;
}

async function addToMessage(ctx: FormsContext, channelId: string, form: Form, label: string, link: string): Promise<string> {
  const match = MESSAGE_LINK.exec(link.trim());
  if (match === null || match[1] !== ctx.guildId || match[2] !== channelId) throw new UserError(`Give the link to a message with form buttons in <#${channelId}>.`);
  const messageId = match[3]!;
  const [existing] = await ctx.db.run(async (tx) =>
    tx.select().from(openers).where(and(eq(openers.messageId, messageId), eq(openers.channelId, channelId))).limit(1),
  );
  if (existing === undefined) throw new UserError(`That is not a message with form buttons in <#${channelId}>.`);
  const row = await insertOpener(ctx, { id: randomUUID(), formId: form.id, channelId, messageId, templateId: existing.templateId, label });
  const gone = await refreshMessages(ctx, [messageId]);
  if (gone.length > 0) throw new UserError('That message no longer exists.');
  return `Added a "${row.label}" button to [the message](${messageUrl(ctx, channelId, messageId)}).`;
}

async function postMessage(ctx: FormsContext, channelId: string, form: Form, label: string, templateId: string): Promise<string> {
  const rendered = await ctx.modules.get(templates).render(templateId);
  if (rendered === null) throw new UserError("That template doesn't exist.");
  const id = randomUUID();
  const channel = await ctx.client.channels.fetch(channelId);
  if (channel === null || !channel.isSendable()) throw new UserError(`I can't post in <#${channelId}>.`);
  const draft = { id, label, active: form.active };
  let sent;
  try {
    sent = await channel.send({
      content: rendered.content,
      embeds: rendered.embed === null ? [] : [rendered.embed],
      components: openerRows(ctx, [draft]),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    throw postError(error, channelId);
  }
  try {
    await insertOpener(ctx, { id, formId: form.id, channelId, messageId: sent.id, templateId, label });
  } catch (error) {
    await sent.delete().catch(() => undefined);
    throw error;
  }
  const below = ctx.modules.optional(sticky);
  const hasSticky = below !== null && (await below.exists(channelId));
  return `Posted [the message](${messageUrl(ctx, channelId, sent.id)}) with a "${label}" button.${hasSticky ? ' The sticky will repost below it.' : ''}`;
}

const placeOf = (opener: LiveOpener & { formName: string }) =>
  opener.messageId === null ? 'sticky' : `message ${opener.messageId}`;

type Listed = LiveOpener & { formName: string };

async function listOpeners(ctx: FormsContext, channelId: string): Promise<Listed[]> {
  const list = await loadOpeners(ctx, eq(openers.channelId, channelId));
  if (list.length === 0) return [];
  const names = await ctx.db.run(async (tx) => tx.select({ id: forms.id, name: forms.name }).from(forms));
  const byId = new Map(names.map((form) => [form.id, form.name]));
  return list.map((opener) => ({ ...opener, formName: byId.get(opener.formId) ?? '?' }));
}

/** The reply of `/forms buttons`: the channel's openers and a select to remove one. */
export async function buttonsMessage(ctx: FormsContext, channelId: string, prefix = ''): Promise<{ content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] }> {
  const list = await listOpeners(ctx, channelId);
  if (list.length === 0) return { content: `${prefix}No form buttons in <#${channelId}>.`, components: [] };
  const shown: Listed[] = [];
  const lines: string[] = [];
  for (const opener of list.slice(0, MAX_SELECT)) {
    const line = `- **${clip(opener.label, 40)}** · ${clip(opener.formName, 40)} · ${opener.messageId === null ? 'sticky' : `[message](${messageUrl(ctx, channelId, opener.messageId)})`}`;
    const rest = list.length - shown.length - 1;
    if ([prefix, ...lines, line].join('\n').length + (rest > 0 ? 30 : 0) > MAX_CONTENT) break;
    shown.push(opener);
    lines.push(line);
  }
  const rest = list.length - shown.length;
  if (rest > 0) lines.push(`…and ${rest} more`);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(ctx.customId(removeOpenerSelect, [channelId]))
    .setPlaceholder('Remove a button')
    .addOptions(shown.map((opener) => ({ label: clip(opener.label, 100), description: clip(`${opener.formName} · ${placeOf(opener)}`, 100), value: opener.id })));
  return { content: `${prefix}${lines.join('\n')}`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

/** Deletes one opener and brings its message or sticky up to date; the message goes with its last button. */
async function removeOpener(ctx: FormsContext, openerId: string): Promise<Opener | null> {
  const [row] = await ctx.db.run(async (tx) => tx.delete(openers).where(eq(openers.id, openerId)).returning());
  if (row === undefined) return null;
  if (row.messageId === null) {
    await cleanupOpeners(ctx, [row]);
    return row;
  }
  const left = await ctx.db.run(async (tx) => tx.select({ count: count() }).from(openers).where(eq(openers.messageId, row.messageId!)));
  if ((left[0]?.count ?? 0) === 0) await cleanupOpeners(ctx, [row]);
  else await refreshMessages(ctx, [row.messageId]);
  return row;
}

export const removeOpenerSelect = defineSelect({
  name: 'remove-opener',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    if (!ctx.interaction.memberPermissions?.has('Administrator')) throw new UserError('You need the Administrator permission to remove form buttons.');
    const row = await removeOpener(ctx, ctx.values[0] ?? '');
    const channelId = args[0] ?? row?.channelId ?? ctx.channelId!;
    await ctx.update(await buttonsMessage(ctx, channelId, row === null ? 'That button was already gone.\n' : `Removed "${row.label}".\n`));
  },
});
