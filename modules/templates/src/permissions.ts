import { UserError, type ButtonContext, type ModalContext, type SelectContext } from '@bronto/core';
import { PermissionFlagsBits } from 'discord.js';
import { eq } from 'drizzle-orm';
import type { TemplatesContext } from './context.js';
import { templates, type Template } from './db/schema.js';

/**
 * Throws unless the member may post in the template's thread. Seeing the post isn't enough to change the template.
 * Discord computes `memberPermissions` for the channel the interaction happened in, with overwrites applied.
 */
export function requireEditor(ctx: ButtonContext | SelectContext | ModalContext): void {
  if (!ctx.interaction.memberPermissions?.has(PermissionFlagsBits.SendMessagesInThreads)) {
    throw new UserError('You need permission to post in this forum to change templates.');
  }
}

/** The template whose post is `threadId`. */
export async function templateForThread(ctx: TemplatesContext, threadId: string): Promise<Template> {
  const [template] = await ctx.db.run(async (tx) => tx.select().from(templates).where(eq(templates.threadId, threadId)));
  if (template === undefined) throw new UserError('This template no longer exists.');
  return template;
}
