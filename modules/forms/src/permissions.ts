import { UserError, type ButtonContext, type ModalContext, type SelectContext } from '@bronto/core';
import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { forms, type Form } from './db/schema.js';

/**
 * Throws unless the member may post in the form's thread. Seeing the post isn't enough to change the form. Discord
 * computes `memberPermissions` for the channel the interaction happened in, with overwrites applied.
 */
export function requireEditor(ctx: ButtonContext | SelectContext | ModalContext): void {
  if (!ctx.interaction.memberPermissions?.has(PermissionFlagsBits.SendMessagesInThreads)) {
    throw new UserError('You need permission to post in this forum to change forms.');
  }
}

export async function formById(ctx: FormsContext, id: string): Promise<Form> {
  const [form] = await ctx.db.run(async (tx) => tx.select().from(forms).where(eq(forms.id, id)));
  if (form === undefined) throw new UserError('This form no longer exists.');
  return form;
}

/** The form whose post is `threadId`. */
export async function formForThread(ctx: FormsContext, threadId: string): Promise<Form> {
  const [form] = await ctx.db.run(async (tx) => tx.select().from(forms).where(eq(forms.threadId, threadId)));
  if (form === undefined) throw new UserError('This form no longer exists.');
  return form;
}

/** The member who triggered the interaction, with the roles and permissions they hold now. */
export async function actingMember(ctx: FormsContext): Promise<GuildMember> {
  const guild = await ctx.client.guilds.fetch(ctx.guildId);
  return guild.members.fetch(ctx.actorId!);
}
