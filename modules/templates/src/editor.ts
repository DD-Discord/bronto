import { defineButton, defineModal, defineSelect, UserError, type ButtonContext, type ModalContext, type ReplyMessage } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { embedLength } from './content.js';
import type { TemplatesContext } from './context.js';
import { templateImages, type ImageSlot, type Template, type TemplateImage } from './db/schema.js';
import { requireEditor, templateForThread } from './permissions.js';
import { saveChange } from './save.js';
import { NEEDS_EMBED } from './apply.js';
import { MAX_FIELDS, readSection, sectionArg, sectionModal, TryAgainError, type Draft, type Section } from './sections.js';

// Discord lets a bot edit an ephemeral reply for 15 minutes; editor components live as long.
const EDITOR_TTL_MS = 15 * 60_000;
const MAX_EMBED = 6000;
const editorBinding = { bind: { user: true, channel: true }, expiresAfterMs: EDITOR_TTL_MS, ephemeral: true } as const;

/** Cuts text to `max` characters on one line, marking the cut with "…". */
function line(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const shown = (text: string, max: number) => escapeMarkdown(line(text, max));
const parts = (entries: [string, boolean][]) => entries.filter(([, present]) => present).map(([name]) => name).join(' · ') || '(none)';

function imageState(images: TemplateImage[], slot: ImageSlot, url: string | undefined): string {
  if (url === undefined) return '—';
  return images.some((image) => image.slot === slot) ? '✓ (uploaded)' : '✓';
}

function summaries(template: Template, images: TemplateImage[]): [Section, string][] {
  const embed = template.embed ?? {};
  const content = template.content.trim() === '' ? '(none)' : shown(template.content, 100);
  return [
    ['content', `**Content**\n${content}`],
    ['body', `**Body**  ${parts([['title', embed.title !== undefined], ['description', embed.description !== undefined], ['url', embed.url !== undefined], ['color', embed.color !== undefined]])}`],
    ['author', `**Author**  ${embed.author === undefined ? '(none)' : parts([[shown(embed.author.name, 60), true], ['link', embed.author.url !== undefined], ['icon', embed.author.icon_url !== undefined]])}`],
    ['footer', `**Footer**  ${parts([['footer text', embed.footer !== undefined], ['icon', embed.footer?.icon_url !== undefined], ['time of posting', template.showPostTime]])}`],
    [
      'images',
      `**Images**  thumbnail ${imageState(images, 'thumbnail', embed.thumbnail?.url)} · image ${imageState(images, 'image', embed.image?.url)}`,
    ],
  ];
}

/** The editor: one container with each section and its Edit button, the field list and select, and the embed actions. */
export function editorView(ctx: TemplatesContext, template: Template, images: TemplateImage[]): ReplyMessage {
  const embed = template.embed;
  const fields = embed?.fields ?? [];
  const container = new ContainerBuilder();
  if (embed?.color !== undefined) container.setAccentColor(embed.color);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Editing "${shown(template.name, 100)}"`));
  container.addSeparatorComponents(new SeparatorBuilder());
  for (const [section, summary] of summaries(template, images)) {
    const edit = new ButtonBuilder().setCustomId(ctx.customId(sectionButton, [section])).setLabel('Edit').setStyle(ButtonStyle.Secondary);
    container.addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(summary)).setButtonAccessory(edit),
    );
  }
  container.addSeparatorComponents(new SeparatorBuilder());
  const list = fields.map((field, i) => `${i + 1}. ${shown(field.name, 40)}${field.inline === true ? ' (inline)' : ''}`).join(' · ');
  const length = embed === null ? 0 : embedLength(embed);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**Fields (${fields.length}/${MAX_FIELDS}) · ${length}/${MAX_EMBED} characters**\n${list || '(none)'}`),
  );
  if (fields.length > 0) {
    const select = new StringSelectMenuBuilder().setCustomId(ctx.customId(fieldSelect)).setPlaceholder('Edit a field…');
    fields.forEach((field, i) => {
      const description = line(field.value, 100);
      select.addOptions({ label: line(`${i + 1}. ${field.name}`, 100), value: String(i), ...(description === '' ? {} : { description }) });
    });
    container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  const buttons: ButtonBuilder[] = [];
  if (fields.length < MAX_FIELDS) {
    buttons.push(new ButtonBuilder().setCustomId(ctx.customId(sectionButton, ['add-field'])).setLabel('+ Add field').setStyle(ButtonStyle.Secondary));
  }
  if (embed !== null) {
    buttons.push(new ButtonBuilder().setCustomId(ctx.customId(removeEmbedButton)).setLabel('Remove embed').setStyle(ButtonStyle.Danger));
  }
  if (buttons.length > 0) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

async function imagesOf(ctx: TemplatesContext, templateId: string): Promise<TemplateImage[]> {
  return ctx.db.run(async (tx) => tx.select().from(templateImages).where(eq(templateImages.templateId, templateId)));
}

/** Answers the preview's Edit button with the editor, visible only to the user. */
export async function openEditor(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const template = await templateForThread(ctx, ctx.channelId!);
  await ctx.reply(editorView(ctx, template, await imagesOf(ctx, template.id)));
}

/** Drafts for [Try again], by a random key; kept as long as editor components are valid. */
const drafts = new Map<string, { guildId: string; draft: Draft; expiresAt: number }>();

function keepDraft(guildId: string, draft: Draft): string {
  const now = Date.now();
  for (const [key, entry] of drafts) if (entry.expiresAt <= now) drafts.delete(key);
  const key = randomBytes(6).toString('base64url');
  drafts.set(key, { guildId, draft, expiresAt: now + EDITOR_TTL_MS });
  return key;
}

/** Drops the guild's drafts; for `guildStopped`. */
export function dropDrafts(guildId: string): void {
  for (const [key, entry] of drafts) if (entry.guildId === guildId) drafts.delete(key);
}

/** A V2 message with `text` and its buttons, so that a later `ctx.update` can turn it into the editor. */
function prompt(text: string, button: ButtonBuilder): ReplyMessage {
  return {
    components: [
      new TextDisplayBuilder().setContent(text),
      new ActionRowBuilder<ButtonBuilder>().addComponents(button),
    ],
    flags: MessageFlags.IsComponentsV2,
  };
}

/** Saves the submitted form; wrong input is answered with the problem and [Try again]. */
async function submitSection(ctx: ModalContext, section: Section, fieldIndex: number | undefined): Promise<void> {
  try {
    await saveChange(ctx, ctx.channelId!, readSection(ctx, section, fieldIndex));
  } catch (error) {
    if (!(error instanceof TryAgainError)) throw error;
    const key = keepDraft(ctx.guildId, error.draft);
    const retry = new ButtonBuilder().setCustomId(ctx.customId(tryAgainButton, [error.section, key])).setLabel('Try again').setStyle(ButtonStyle.Primary);
    await ctx.reply(prompt(error.message, retry));
  }
}

export const sectionModalDefinition = defineModal({
  name: 'section',
  bind: { channel: true },
  expiresAfterMs: EDITOR_TTL_MS,
  ephemeral: true,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const section = sectionArg(args[0]);
    const fieldIndex = args[1] === undefined ? undefined : Number(args[1]);
    await submitSection(ctx, section, fieldIndex);
  },
});

export const sectionButton = defineButton({
  name: 'section',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const section = sectionArg(args[0]);
    const template = await templateForThread(ctx, ctx.channelId!);
    if (section === 'add-field' && (template.embed?.fields?.length ?? 0) >= MAX_FIELDS) {
      throw new UserError(`An embed can have at most ${MAX_FIELDS} fields.`);
    }
    await ctx.showModal(sectionModal(ctx, section, template));
  },
});

export const fieldSelect = defineSelect({
  name: 'field',
  ...editorBinding,
  execute: async (ctx) => {
    requireEditor(ctx);
    const template = await templateForThread(ctx, ctx.channelId!);
    await ctx.showModal(sectionModal(ctx, 'field', template, Number(ctx.values[0])));
  },
});

export const tryAgainButton = defineButton({
  name: 'try-again',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const section = sectionArg(args[0]);
    const entry = drafts.get(args[1] ?? '');
    if (entry === undefined || entry.guildId !== ctx.guildId || entry.expiresAt <= Date.now()) {
      throw new UserError('That form has expired. Open the editor again.');
    }
    const template = await templateForThread(ctx, ctx.channelId!);
    await ctx.showModal(sectionModal(ctx, section, template, entry.draft.fieldIndex, entry.draft));
  },
});

export const removeEmbedConfirmButton = defineButton({
  name: 'remove-embed-confirm',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx) => {
    requireEditor(ctx);
    await saveChange(ctx, ctx.channelId!, { section: 'remove-embed' });
  },
});

export const removeEmbedButton = defineButton({
  name: 'remove-embed',
  ...editorBinding,
  execute: async (ctx) => {
    requireEditor(ctx);
    const template = await templateForThread(ctx, ctx.channelId!);
    if (template.embed === null) throw new UserError('This template has no embed.');
    if (template.content.trim() === '') throw new UserError(NEEDS_EMBED);
    const confirm = new ButtonBuilder().setCustomId(ctx.customId(removeEmbedConfirmButton)).setLabel('Remove embed').setStyle(ButtonStyle.Danger);
    await ctx.reply(prompt(`Remove the embed of "${shown(template.name, 100)}"? Its title, text, images and fields are deleted.`, confirm));
  },
});

export const editorComponents = [sectionButton, fieldSelect, tryAgainButton, removeEmbedButton, removeEmbedConfirmButton, sectionModalDefinition];
