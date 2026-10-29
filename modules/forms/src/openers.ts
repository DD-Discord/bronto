import { isGone } from '@bronto/core';
import sticky from '@bronto/sticky';
import templates from '@bronto/templates';
import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
} from 'discord.js';
import { and, asc, eq, inArray, isNotNull, isNull, type SQL } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { forms, openers, type Opener } from './db/schema.js';
import { openButton } from './open.js';

/** Discord's limit of buttons per row; a message or sticky post holds five rows. */
const BUTTONS_PER_ROW = 5;
/** Buttons per message, and per channel's sticky. */
export const MAX_OPENERS = 25;

/** An opener with the activity of its form. */
export type LiveOpener = Opener & { active: boolean };

/** What a button needs from its opener. */
export type OpenerButton = Pick<Opener, 'id' | 'label'> & { active: boolean };

export type OpenerRow = APIActionRowComponent<APIButtonComponentWithCustomId>;

/** Openers matching `where`, in button order. */
export async function loadOpeners(ctx: FormsContext, where: SQL | undefined): Promise<LiveOpener[]> {
  const rows = await ctx.db.run(async (tx) =>
    tx
      .select({ opener: openers, active: forms.active })
      .from(openers)
      .innerJoin(forms, eq(openers.formId, forms.id))
      .where(where)
      .orderBy(asc(openers.position), asc(openers.id)),
  );
  return rows.map(({ opener, active }) => ({ ...opener, active }));
}

/** The openers on a channel's sticky. */
export const stickyOpenersOf = (ctx: FormsContext, channelId: string) =>
  loadOpeners(ctx, and(eq(openers.channelId, channelId), isNull(openers.messageId)));

/** Button rows for the openers, five per row, in the order given. */
export function openerRows(ctx: FormsContext, list: OpenerButton[]): OpenerRow[] {
  const rows: OpenerRow[] = [];
  for (let start = 0; start < list.length; start += BUTTONS_PER_ROW) {
    rows.push({
      type: ComponentType.ActionRow,
      components: list.slice(start, start + BUTTONS_PER_ROW).map((opener) => ({
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        custom_id: ctx.customId(openButton, [opener.id]),
        label: opener.label,
        disabled: !opener.active,
      })),
    });
  }
  return rows;
}

/** The channel's message manager, or null when the channel is gone or can't hold messages. */
async function messagesOf(ctx: FormsContext, channelId: string) {
  let channel;
  try {
    channel = await ctx.client.channels.fetch(channelId);
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
  return channel !== null && channel.isTextBased() ? channel.messages : null;
}

/** Deletes the forms-owned messages of the openers; messages that are already gone don't count. */
async function deleteMessages(ctx: FormsContext, list: Pick<Opener, 'channelId' | 'messageId'>[]): Promise<void> {
  const seen = new Set<string>();
  for (const { channelId, messageId } of list) {
    if (messageId === null || seen.has(messageId)) continue;
    seen.add(messageId);
    try {
      await (await messagesOf(ctx, channelId))?.delete(messageId);
    } catch (error) {
      if (!isGone(error)) ctx.log.warn({ err: error, channelId, messageId }, 'Deleting an opener message failed');
    }
  }
}

/** Re-renders the stickies of the channels; does nothing while sticky is unavailable. */
async function refreshStickies(ctx: FormsContext, channelIds: Iterable<string>): Promise<void> {
  const api = ctx.modules.optional(sticky);
  if (api === null) return;
  for (const channelId of new Set(channelIds)) {
    try {
      await api.refresh(channelId);
    } catch (error) {
      ctx.log.warn({ err: error, channelId }, 'Refreshing a sticky with form buttons failed');
    }
  }
}

/**
 * Removes the Discord side of openers whose rows are already gone: their messages, and the buttons on their stickies.
 * Failures are logged; the rows are the source of truth.
 */
export async function cleanupOpeners(ctx: FormsContext, gone: Opener[]): Promise<void> {
  await deleteMessages(ctx, gone);
  await refreshStickies(ctx, gone.filter((opener) => opener.messageId === null).map((opener) => opener.channelId));
}

/**
 * Re-renders the messages with their template and all their openers' buttons. A message that no longer exists loses its
 * opener rows. Returns the IDs of the messages that were gone.
 */
export async function refreshMessages(ctx: FormsContext, messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const all = await loadOpeners(ctx, inArray(openers.messageId, messageIds));
  const gone: string[] = [];
  for (const messageId of new Set(all.map((opener) => opener.messageId!))) {
    const group = all.filter((opener) => opener.messageId === messageId);
    const { channelId, templateId } = group[0]!;
    try {
      const rendered = templateId === null ? null : await ctx.modules.get(templates).render(templateId);
      if (rendered === null) continue;
      const messages = await messagesOf(ctx, channelId);
      if (messages === null) {
        gone.push(messageId);
        continue;
      }
      await messages.edit(messageId, {
        content: rendered.content,
        embeds: rendered.embed === null ? [] : [rendered.embed],
        components: openerRows(ctx, group),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (isGone(error)) {
        gone.push(messageId);
      } else {
        ctx.log.warn({ err: error, channelId, messageId }, 'Updating an opener message failed');
      }
    }
  }
  if (gone.length > 0) {
    await ctx.db.run(async (tx) => {
      await tx.delete(openers).where(inArray(openers.messageId, gone));
    });
  }
  return gone;
}

/** Rebuilds the form's opener buttons after its name or activity changed. */
export async function refreshOpeners(ctx: FormsContext, formId: string): Promise<void> {
  const own = await ctx.db.run(async (tx) => tx.select().from(openers).where(eq(openers.formId, formId)));
  await refreshMessages(ctx, [...new Set(own.map((opener) => opener.messageId).filter((id): id is string => id !== null))]);
  await refreshStickies(ctx, own.filter((opener) => opener.messageId === null).map((opener) => opener.channelId));
}

/** Re-renders every opener message that uses the template. */
export async function refreshTemplateMessages(ctx: FormsContext, templateId: string): Promise<void> {
  const rows = await ctx.db.run(async (tx) =>
    tx.select({ messageId: openers.messageId }).from(openers).where(and(eq(openers.templateId, templateId), isNotNull(openers.messageId))),
  );
  await refreshMessages(ctx, [...new Set(rows.map((row) => row.messageId!))]);
}

/** Deletes the messages and rows of the openers that use a deleted template. */
export async function dropTemplateOpeners(ctx: FormsContext, templateId: string): Promise<void> {
  const rows = await ctx.db.run(async (tx) => tx.delete(openers).where(eq(openers.templateId, templateId)).returning());
  await cleanupOpeners(ctx, rows);
}

/** Deletes the rows of the sticky openers of a channel whose sticky is gone. */
export async function dropStickyOpeners(ctx: FormsContext, channelId: string): Promise<void> {
  await ctx.db.run(async (tx) => {
    await tx.delete(openers).where(and(eq(openers.channelId, channelId), isNull(openers.messageId)));
  });
}

/** The channels whose openers use the template, in order; empty when none do. */
export async function channelsUsingTemplate(ctx: FormsContext, templateId: string): Promise<string[]> {
  const rows = await ctx.db.run(async (tx) =>
    tx.selectDistinct({ channelId: openers.channelId }).from(openers).where(eq(openers.templateId, templateId)).orderBy(asc(openers.channelId)),
  );
  return rows.map((row) => row.channelId);
}
