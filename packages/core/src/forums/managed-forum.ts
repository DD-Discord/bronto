import {
  ChannelType,
  DiscordAPIError,
  Events,
  GatewayDispatchEvents,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type AnyThreadChannel,
} from 'discord.js';
import { and, eq, ne, type InferSelectModel } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/database.js';
import { UserError } from '../interactions/errors.js';
import { gatewayEvent, on, type Listener } from '../runtime/events.js';
import type { HandlerContext } from '../runtime/types.js';
import { channelExists as channelExistsOn } from './ui.js';

/** A per-guild table holding the server's one forum; its guild_id needs a unique index. */
export type ForumTable = PgTable & { guildId: PgColumn; forumChannelId: PgColumn };

/** A per-guild table with one record per forum post. */
export type ForumRecordTable = PgTable & { id: PgColumn; name: PgColumn; threadId: PgColumn };

export interface ForumRecord {
  id: string;
  name: string;
  threadId: string;
}

/** How replies and log lines name the forum's records. */
export interface ForumWording {
  /** The record in replies and log lines, in lower case: "I couldn't turn this post into a <noun>", "<Noun> deleted". */
  noun: string;
  /** The forum in log lines: "Checking the <forumLabel> failed". */
  forumLabel: string;
  /** The log field holding the record's ID. */
  logKey: string;
}

type Row<TRecords extends ForumRecordTable> = InferSelectModel<TRecords> & ForumRecord;

export interface ManagedForumOptions<TRecords extends ForumRecordTable, TAll = undefined> {
  /** Name of the forum channel `ensure` creates. */
  forumName: string;
  tables: { forums: ForumTable; records: TRecords };
  wording: ForumWording;
  /**
   * Creates the record for a member's new post, or throws a `UserError` to answer in the post. Returning `'skip'`
   * leaves the post alone without a reply.
   */
  createFromPost: (ctx: HandlerContext, thread: AnyThreadChannel) => Promise<unknown>;
  /** Forgets one record instead of the default delete, log line and `forgotOne`. */
  forgetOne?: (ctx: HandlerContext, record: Row<TRecords>) => Promise<unknown>;
  /** Runs after the default delete removed a record. */
  forgotOne?: (ctx: HandlerContext, record: Row<TRecords>) => unknown;
  /** Runs inside the transaction that forgets the forum, before the records are deleted; its result reaches `forgotAll`. */
  forgetAllTx?: (tx: Tx) => Promise<TAll>;
  /** Runs after the forum and all its records were deleted. */
  forgotAll?: (ctx: HandlerContext, records: Row<TRecords>[], extra: TAll) => unknown;
  /** Handles a renamed thread instead of setting the record's name to the thread's name. */
  rename?: (ctx: HandlerContext, thread: AnyThreadChannel) => Promise<unknown>;
}

export interface ManagedForum<TRecords extends ForumRecordTable> {
  /** Listeners for new posts, deleted posts, the deleted forum and renamed posts. */
  listeners: Listener[];
  /**
   * Forgets records whose forum or post was deleted while the bot was away. Only Unknown Channel counts as gone; any
   * other failure (permissions, outages) keeps the data and logs a warning.
   */
  reconcile(ctx: HandlerContext): Promise<void>;
  /** The stored forum's channel ID, or null when the server has none. */
  storedId(ctx: HandlerContext): Promise<string | null>;
  /** Whether the channel still exists on Discord; only Unknown Channel counts as gone. */
  channelExists(ctx: HandlerContext, channelId: string): Promise<boolean>;
  /** The stored forum while it exists; otherwise creates one hidden from @everyone and stores it. */
  ensure(ctx: HandlerContext): Promise<string>;
  /** Forgets one record: `forgetOne`'s result, or by default whether a row was deleted. */
  forget(ctx: HandlerContext, record: Row<TRecords>): Promise<unknown>;
}

const COMMUNITY_MESSAGE = 'Forum channels need a Community server. Turn on Community in Server Settings first.';

/**
 * One bot-owned forum per server whose posts are records: members' new posts become records (and are deleted), and
 * records follow their posts when those are renamed or deleted.
 */
export function defineManagedForum<TRecords extends ForumRecordTable, TAll = undefined>(
  options: ManagedForumOptions<TRecords, TAll>,
): ManagedForum<TRecords> {
  const { forums, records } = options.tables;
  const { noun, forumLabel, logKey } = options.wording;
  const deletedMessage = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted`;

  function announce(ctx: HandlerContext, gone: Row<TRecords>[]): void {
    for (const { id, name, threadId } of gone) ctx.log.info({ [logKey]: id, name, threadId }, deletedMessage);
  }

  async function storedId(ctx: HandlerContext): Promise<string | null> {
    const [row] = await ctx.db.run(async (tx) => tx.select({ id: forums.forumChannelId }).from(forums as PgTable));
    return (row?.id as string | undefined) ?? null;
  }

  async function channelExists(ctx: HandlerContext, channelId: string): Promise<boolean> {
    return channelExistsOn(ctx.client, channelId);
  }

  async function ensure(ctx: HandlerContext): Promise<string> {
    const stored = await storedId(ctx);
    if (stored !== null && (await channelExists(ctx, stored))) return stored;

    const guild = await ctx.client.guilds.fetch(ctx.guildId);
    if (!guild.features.includes('COMMUNITY')) throw new UserError(COMMUNITY_MESSAGE);
    let forum;
    try {
      forum = await guild.channels.create({
        name: options.forumName,
        type: ChannelType.GuildForum,
        permissionOverwrites: [
          // The @everyone role's ID is the server's ID.
          { id: ctx.guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
          { id: ctx.client.user!.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel] },
        ],
      });
    } catch (error) {
      // Discord's answer when a forum is created outside a Community server.
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.CannotExecuteActionOnThisChannelType) {
        throw new UserError(COMMUNITY_MESSAGE);
      }
      throw error;
    }
    await ctx.db.run(async (tx) => {
      await tx
        .insert(forums as PgTable)
        .values({ forumChannelId: forum.id } as never)
        .onConflictDoUpdate({ target: forums.guildId, set: { forumChannelId: forum.id } as never });
    });
    return forum.id;
  }

  async function forget(ctx: HandlerContext, record: Row<TRecords>): Promise<unknown> {
    if (options.forgetOne !== undefined) return options.forgetOne(ctx, record);
    const rows = (await ctx.db.run(async (tx) =>
      tx.delete(records as PgTable).where(eq(records.id, record.id)).returning(),
    )) as unknown as Row<TRecords>[];
    announce(ctx, rows);
    for (const row of rows) await options.forgotOne?.(ctx, row);
    return rows.length > 0;
  }

  /**
   * Deletes every record and the forum row. Does nothing once another forum is stored: `ensure` may have replaced the
   * gone forum while it was being checked.
   */
  async function forgetForum(ctx: HandlerContext, forumId: string): Promise<void> {
    const removed = await ctx.db.run(async (tx) => {
      const [stored] = await tx.select({ id: forums.forumChannelId }).from(forums as PgTable).for('update');
      if (stored?.id !== forumId) return null;
      const extra = (await options.forgetAllTx?.(tx)) as TAll;
      const deleted = (await tx.delete(records as PgTable).returning()) as unknown as Row<TRecords>[];
      await tx.delete(forums as PgTable);
      return { deleted, extra };
    });
    if (removed === null) return;
    announce(ctx, removed.deleted);
    await options.forgotAll?.(ctx, removed.deleted, removed.extra);
  }

  async function recordOfThread(ctx: HandlerContext, threadId: string): Promise<Row<TRecords> | undefined> {
    const [row] = await ctx.db.run(async (tx) => tx.select().from(records as PgTable).where(eq(records.threadId, threadId)));
    return row as Row<TRecords> | undefined;
  }

  async function reply(ctx: HandlerContext, thread: AnyThreadChannel, text: string): Promise<void> {
    try {
      await thread.send({ content: text, allowedMentions: { parse: [] } });
    } catch (error) {
      ctx.log.warn({ err: error, threadId: thread.id }, 'Replying in a forum post failed');
    }
  }

  /** Turns a member's new post in the forum into a record and deletes the post. Problems are answered in the post, which stays. */
  async function onThreadCreate(ctx: HandlerContext, thread: AnyThreadChannel, newlyCreated: boolean): Promise<void> {
    if (!newlyCreated || thread.ownerId === ctx.client.user?.id) return;
    const forumId = await storedId(ctx);
    if (forumId === null || thread.parentId !== forumId) return;
    try {
      if ((await options.createFromPost(ctx, thread)) === 'skip') return;
    } catch (error) {
      const reason = error instanceof UserError ? error.message : 'Something went wrong.';
      await reply(ctx, thread, `I couldn't turn this post into a ${noun}: ${reason}`);
      if (!(error instanceof UserError)) throw error;
      return;
    }
    try {
      await thread.delete();
    } catch (error) {
      ctx.log.warn({ err: error, threadId: thread.id }, `Deleting the member's post after creating its ${noun} failed`);
    }
  }

  async function onThreadUpdate(ctx: HandlerContext, thread: AnyThreadChannel): Promise<void> {
    if (options.rename !== undefined) {
      await options.rename(ctx, thread);
      return;
    }
    await ctx.db.run(async (tx) => {
      await tx
        .update(records as PgTable)
        .set({ name: thread.name } as never)
        .where(and(eq(records.threadId, thread.id), ne(records.name, thread.name)));
    });
  }

  async function reconcile(ctx: HandlerContext): Promise<void> {
    const forumId = await storedId(ctx);
    if (forumId !== null) {
      let exists: boolean;
      try {
        exists = await channelExists(ctx, forumId);
      } catch (error) {
        ctx.log.warn({ err: error, channelId: forumId }, `Checking the ${forumLabel} failed`);
        return;
      }
      if (!exists) {
        await forgetForum(ctx, forumId);
        return;
      }
    }
    const rows = (await ctx.db.run(async (tx) => tx.select().from(records as PgTable))) as Row<TRecords>[];
    for (const row of rows) {
      let exists: boolean;
      try {
        exists = await channelExists(ctx, row.threadId);
      } catch (error) {
        ctx.log.warn({ err: error, [logKey]: row.id, threadId: row.threadId }, `Checking a ${noun} post failed`);
        continue;
      }
      if (!exists) await forget(ctx, row);
    }
  }

  return {
    listeners: [
      on(Events.ThreadCreate, (ctx, thread, newlyCreated) => onThreadCreate(ctx, thread, newlyCreated)),
      // Raw packet: discord.js emits ThreadDelete only for cached threads.
      on(gatewayEvent(GatewayDispatchEvents.ThreadDelete), async (ctx, data) => {
        const record = await recordOfThread(ctx, data.id);
        if (record !== undefined) await forget(ctx, record);
      }),
      on(Events.ChannelDelete, (ctx, channel) => forgetForum(ctx, channel.id)),
      on(Events.ThreadUpdate, (ctx, _before, after) => onThreadUpdate(ctx, after)),
    ],
    reconcile,
    storedId,
    channelExists,
    ensure,
    forget,
  };
}
