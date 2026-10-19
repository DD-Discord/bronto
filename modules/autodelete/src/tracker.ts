import type { HandlerContext } from '@bronto/core';
import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import { and, desc, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import type { AutodeleteConfig } from './config.js';
import { cooldowns, posts, rules, type Post, type Rule } from './db/schema.js';
import type { AutodeleteDiscord, DeleteOutcome, FetchedPost } from './discord.js';
import type { RuleIndex } from './rule-index.js';

export type AutodeleteContext = HandlerContext<AutodeleteConfig>;

export interface MemberInfo {
  id: string;
  displayName: string;
  avatarUrl: string;
  joinedAt: Date | null;
}

/** A post the bot removed; `post` is null when it was already gone before it could be fetched. */
export interface Removal {
  messageId: string;
  postedAt: Date;
  post: FetchedPost | null;
  outcome: DeleteOutcome;
}

/** Reports and DMs about removed posts. */
export interface Notifier {
  replaced(
    ctx: AutodeleteContext,
    rule: Rule,
    member: MemberInfo,
    removed: Removal,
    newPost: { messageId: string; content: string },
  ): Promise<void>;
  rejected(
    ctx: AutodeleteContext,
    rule: Rule,
    member: MemberInfo,
    rejected: Removal,
    current: { messageId: string; post: FetchedPost | null } | null,
    nextPostAt: Date,
  ): Promise<void>;
  left(ctx: AutodeleteContext, rule: Rule, member: MemberInfo, removed: Removal): Promise<void>;
}

/** The parts of a guild member (possibly partial) the tracker reads. */
export interface MemberLike {
  id: string;
  displayName?: string | null;
  joinedAt: Date | null;
  displayAvatarURL?(): string;
  user: { username: string; displayName?: string | null; displayAvatarURL(): string };
}

/** The parts of a gateway message the tracker reads. */
export interface IncomingMessage {
  id: string;
  channelId: string;
  content: string;
  webhookId: string | null;
  system: boolean;
  author: { id: string; bot: boolean };
  member: (MemberLike & { permissionsIn(channelId: string): { has(permission: bigint): boolean } }) | null;
}

export interface TrackerDeps {
  index: RuleIndex;
  discord: (ctx: AutodeleteContext) => AutodeleteDiscord;
  notifier: Notifier;
  /** Clock in milliseconds. */
  now?: () => number;
}

type Decision =
  | { kind: 'accepted'; rule: Rule; removed: Post[]; newestId: string }
  | { kind: 'rejected'; rule: Rule; current: Post | null; nextPostAt: Date };

export function memberInfo(member: MemberLike): MemberInfo {
  return {
    id: member.id,
    displayName: member.displayName ?? member.user.displayName ?? member.user.username,
    avatarUrl: member.displayAvatarURL?.() ?? member.user.displayAvatarURL(),
    joinedAt: member.joinedAt ?? null,
  };
}

const newestOf = (ids: string[]): string => ids.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a));

/** Tracks the posts and cooldowns of rule channels and removes posts the rules do not allow. */
export class Tracker {
  private readonly index: RuleIndex;
  private readonly discord: (ctx: AutodeleteContext) => AutodeleteDiscord;
  private readonly notifier: Notifier;
  private readonly now: () => number;

  constructor(deps: TrackerDeps) {
    this.index = deps.index;
    this.discord = deps.discord;
    this.notifier = deps.notifier;
    this.now = deps.now ?? Date.now;
  }

  async onMessage(ctx: AutodeleteContext, message: IncomingMessage): Promise<void> {
    const indexed = this.index.get(ctx.guildId, message.channelId);
    if (indexed === undefined || !indexed.enabled) return;
    if (message.author.bot || message.webhookId !== null || message.system) return;
    const { member } = message;
    if (member === null || member.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages)) return;

    const decision = await this.decide(ctx, message);
    if (decision === null) return;
    const discord = this.discord(ctx);
    const info = memberInfo(member);
    const { channelId } = message;

    if (decision.kind === 'rejected') {
      const { rule, current, nextPostAt } = decision;
      await this.guarded(ctx, channelId, message.id, async () => {
        const currentPost =
          current === null ? null : { messageId: current.messageId, post: await discord.fetchPost(channelId, current.messageId) };
        const removal = await this.remove(ctx, discord, channelId, message.id, postedAtOf(message.id));
        await this.notifier.rejected(ctx, rule, info, removal, currentPost, nextPostAt);
      });
      return;
    }

    const { rule, removed, newestId } = decision;
    for (const post of removed) {
      await this.guarded(ctx, channelId, post.messageId, async () => {
        // A newer post handled first replaces this one; its text has to come from Discord.
        const newPost =
          newestId === message.id
            ? { messageId: message.id, content: message.content }
            : { messageId: newestId, content: (await discord.fetchPost(channelId, newestId))?.content ?? '' };
        const removal = await this.remove(ctx, discord, channelId, post.messageId, post.postedAt);
        await this.notifier.replaced(ctx, rule, info, removal, newPost);
      });
    }
  }

  /** Forgets deleted posts; a member's own post deleted within the grace time resets their cooldown. */
  async onDelete(ctx: AutodeleteContext, channelId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0 || this.index.get(ctx.guildId, channelId) === undefined) return;
    const now = this.now();
    await ctx.db.run(async (tx) => {
      // Lock order: cooldowns before posts, as in accepting a post, so the two never deadlock.
      await tx
        .select({ userId: cooldowns.userId })
        .from(cooldowns)
        .where(and(eq(cooldowns.channelId, channelId), inArray(cooldowns.messageId, messageIds)))
        .for('update');
      // Posts the bot deleted have lost their rows already, so their events change nothing.
      const deleted = await tx
        .delete(posts)
        .where(and(eq(posts.channelId, channelId), inArray(posts.messageId, messageIds)))
        .returning({ messageId: posts.messageId });
      if (deleted.length === 0) return;
      const [rule] = await tx.select({ graceMs: rules.graceMs }).from(rules).where(eq(rules.channelId, channelId));
      if (rule === undefined || rule.graceMs === 0) return;
      await tx.delete(cooldowns).where(
        and(
          eq(cooldowns.channelId, channelId),
          inArray(
            cooldowns.messageId,
            deleted.map((row) => row.messageId),
          ),
          gt(cooldowns.postedAt, new Date(now - rule.graceMs)),
        ),
      );
    });
  }

  /** Removes a leaving member's posts in the channels whose rule asks for it; their cooldowns stay. */
  async onLeave(ctx: AutodeleteContext, member: MemberLike): Promise<void> {
    if (!this.index.rulesOf(ctx.guildId).some((rule) => rule.enabled && rule.deleteOnLeave)) return;
    const removed = await ctx.db.run(async (tx) => {
      const leaveRules = await tx
        .select()
        .from(rules)
        .where(and(eq(rules.enabled, true), eq(rules.deleteOnLeave, true)))
        .for('share');
      if (leaveRules.length === 0) return [];
      const rows = await tx
        .delete(posts)
        .where(
          and(
            eq(posts.userId, member.id),
            inArray(
              posts.channelId,
              leaveRules.map((rule) => rule.channelId),
            ),
          ),
        )
        .returning();
      return rows.map((post) => ({ post, rule: leaveRules.find((rule) => rule.channelId === post.channelId)! }));
    });
    if (removed.length === 0) return;
    const discord = this.discord(ctx);
    const info = memberInfo(member);
    for (const { post, rule } of removed) {
      await this.guarded(ctx, post.channelId, post.messageId, async () => {
        const removal = await this.remove(ctx, discord, post.channelId, post.messageId, post.postedAt);
        await this.notifier.left(ctx, rule, info, removal);
      });
    }
  }

  /**
   * Accepts or rejects a message in one transaction. Concurrent messages of one member serialize on their cooldown
   * row: the insert of the second waits on the primary key until the first commits. Lock order: the cooldown row
   * before any `posts` rows.
   */
  private decide(ctx: AutodeleteContext, message: IncomingMessage): Promise<Decision | null> {
    const { channelId, id: messageId } = message;
    const userId = message.author.id;
    const postedAt = postedAtOf(messageId);
    return ctx.db.run(async (tx): Promise<Decision | null> => {
      // The rule may have been deleted or disabled since the index lookup; the share lock keeps it until commit.
      const [rule] = await tx.select().from(rules).where(eq(rules.channelId, channelId)).for('share');
      if (rule === undefined || !rule.enabled) return null;
      const member = and(eq(cooldowns.channelId, channelId), eq(cooldowns.userId, userId));

      const inserted = await tx
        .insert(cooldowns)
        .values({ channelId, userId, messageId, postedAt })
        .onConflictDoNothing()
        .returning({ userId: cooldowns.userId });
      if (inserted.length === 0) {
        const [cooldown] = await tx.select().from(cooldowns).where(member).for('update');
        if (cooldown !== undefined) {
          const nextPostAt = new Date(cooldown.postedAt.getTime() + rule.cooldownMs);
          if (rule.cooldownMs > 0 && postedAt.getTime() < nextPostAt.getTime()) {
            const [current] = await tx
              .select()
              .from(posts)
              .where(and(eq(posts.channelId, channelId), eq(posts.userId, userId)))
              .orderBy(desc(posts.postedAt))
              .limit(1);
            return { kind: 'rejected', rule, current: current ?? null, nextPostAt };
          }
        }
        // The cooldown counts from the newest accepted post, also when events arrive out of order.
        await tx
          .insert(cooldowns)
          .values({ channelId, userId, messageId, postedAt })
          .onConflictDoUpdate({
            target: [cooldowns.guildId, cooldowns.channelId, cooldowns.userId],
            set: { messageId, postedAt },
            setWhere: lt(cooldowns.postedAt, postedAt),
          });
      }

      await tx.insert(posts).values({ messageId, channelId, userId, postedAt }).onConflictDoNothing();
      if (!rule.keepLatest) return { kind: 'accepted', rule, removed: [], newestId: messageId };
      const memberPosts = and(eq(posts.channelId, channelId), eq(posts.userId, userId));
      const ids = await tx.select({ messageId: posts.messageId }).from(posts).where(memberPosts);
      const newestId = newestOf(ids.map((row) => row.messageId));
      const removed = await tx
        .delete(posts)
        .where(and(memberPosts, ne(posts.messageId, newestId)))
        .returning();
      return { kind: 'accepted', rule, removed, newestId };
    });
  }

  /** Fetches a post for the report, then deletes it. */
  private async remove(
    ctx: AutodeleteContext,
    discord: AutodeleteDiscord,
    channelId: string,
    messageId: string,
    postedAt: Date,
  ): Promise<Removal> {
    const post = await discord.fetchPost(channelId, messageId);
    const outcome = await discord.deletePost(channelId, messageId);
    if (outcome === 'forbidden') ctx.log.warn({ channelId, messageId }, 'Missing permission to delete a post');
    return { messageId, postedAt, post, outcome };
  }

  /** One failing removal or report is logged and does not stop the others. */
  private async guarded(ctx: AutodeleteContext, channelId: string, messageId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      ctx.log.error({ err: error, channelId, messageId }, 'Removing a post failed');
    }
  }
}

const postedAtOf = (messageId: string): Date => new Date(SnowflakeUtil.timestampFrom(messageId));

/** Reports nothing. */
export const silentNotifier: Notifier = {
  replaced: async () => undefined,
  rejected: async () => undefined,
  left: async () => undefined,
};
