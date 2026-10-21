import type { AnyThreadChannel, Channel, PartialDMChannel } from 'discord.js';
import { and, eq, ne } from 'drizzle-orm';
import type { TemplatesContext } from './context.js';
import { forums, templates, type Template } from './db/schema.js';
import { templatesEvents } from './events.js';
import { channelExists, storedForumId } from './forum.js';

type Gone = Pick<Template, 'id' | 'name' | 'threadId'>;

function announce(ctx: TemplatesContext, gone: Gone[]): void {
  for (const { id, name, threadId } of gone) {
    ctx.log.info({ templateId: id, name, threadId }, 'Template deleted');
    ctx.emit(templatesEvents.deleted, { id });
  }
}

/** Deletes the template's row (its images go with it), logs it and emits `deleted`; false when it was already gone. */
export async function forgetTemplate(ctx: TemplatesContext, template: Gone): Promise<boolean> {
  const rows = await ctx.db.run(async (tx) => tx.delete(templates).where(eq(templates.id, template.id)).returning());
  announce(ctx, rows);
  return rows.length > 0;
}

/**
 * Deletes every template and the forum row, announcing each template. Does nothing once another forum is stored:
 * `create` may have replaced the gone forum while it was being checked.
 */
async function forgetForum(ctx: TemplatesContext, forumId: string): Promise<void> {
  const rows = await ctx.db.run(async (tx) => {
    const [stored] = await tx.select({ id: forums.forumChannelId }).from(forums).for('update');
    if (stored?.id !== forumId) return [];
    const deleted = await tx.delete(templates).returning();
    await tx.delete(forums);
    return deleted;
  });
  announce(ctx, rows);
}

/** A post deleted in Discord deletes its template. */
export async function onThreadDelete(ctx: TemplatesContext, data: { id: string }): Promise<void> {
  const [row] = await ctx.db.run(async (tx) => tx.select().from(templates).where(eq(templates.threadId, data.id)));
  if (row !== undefined) await forgetTemplate(ctx, row);
}

/** The template forum deleted in Discord deletes all its templates. */
export async function onChannelDelete(ctx: TemplatesContext, channel: Channel | PartialDMChannel): Promise<void> {
  await forgetForum(ctx, channel.id);
}

/** A renamed post renames its template; the rename is not a content change, so no event fires. */
export async function onThreadUpdate(ctx: TemplatesContext, _old: AnyThreadChannel, thread: AnyThreadChannel): Promise<void> {
  await ctx.db.run(async (tx) => {
    await tx
      .update(templates)
      .set({ name: thread.name })
      .where(and(eq(templates.threadId, thread.id), ne(templates.name, thread.name)));
  });
}

/**
 * Drops templates whose forum or post was deleted while the bot was away. Only Unknown Channel counts as gone; any
 * other failure (permissions, outages) keeps the data and logs a warning.
 */
export async function reconcile(ctx: TemplatesContext): Promise<void> {
  const forumId = await storedForumId(ctx);
  if (forumId !== null) {
    let exists: boolean;
    try {
      exists = await channelExists(ctx, forumId);
    } catch (error) {
      ctx.log.warn({ err: error, channelId: forumId }, 'Checking the template forum failed');
      return;
    }
    if (!exists) {
      await forgetForum(ctx, forumId);
      return;
    }
  }
  const rows = await ctx.db.run(async (tx) => tx.select().from(templates));
  for (const row of rows) {
    let exists: boolean;
    try {
      exists = await channelExists(ctx, row.threadId);
    } catch (error) {
      ctx.log.warn({ err: error, templateId: row.id, threadId: row.threadId }, 'Checking a template post failed');
      continue;
    }
    if (!exists) await forgetTemplate(ctx, row);
  }
}
