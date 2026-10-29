import { downloadFile, UserError, withWebhookErrors, type ButtonContext, type IncomingWebhook } from '@bronto/core';
import sticky from '@bronto/sticky';
import {
  DiscordAPIError,
  MessageFlags,
  MessageType,
  RESTJSONErrorCodes,
  SnowflakeUtil,
  type APIEmbed,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from 'discord.js';
import { classify, type Plan, type StayReason } from './classify.js';
import { isForumPost, loadChannels } from './command.js';
import type { ChannelLocks } from './locks.js';
import type { PendingMove } from './pending.js';
import { readRange } from './range.js';
import { displayName, renderMessage, webhookName, type ReplyTarget, type RepostPart } from './render.js';
import { findMoveWebhook } from './webhook.js';

/** The shortest time between two progress edits. */
const PROGRESS_MS = 3000;
/** Discord bulk-deletes only messages younger than 14 days; the margin covers the time the move takes. */
const BULK_MAX_AGE_MS = 14 * 24 * 3600_000 - 10 * 60_000;
const BULK_SIZE = 100;
/** Discord takes at most this many files per message. */
const MAX_FILES = 10;
/** How long reposts still count as moved after a move ends, since their gateway events can arrive late. */
const ACTIVE_GRACE_MS = 60_000;
/** Room for the result in one message. */
const RESULT_LENGTH = 1900;

const REASON_TEXT: Record<StayReason, string> = {
  'too-large': 'attachment too large',
  poll: 'poll',
  thread: 'has a thread',
  'forum-start': 'original post',
  interactive: 'interactive',
};

const link = (guildId: string, channelId: string, messageId: string): string => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
const plural = (count: number, word: string): string => `**${count}** ${count === 1 ? word : `${word}s`}`;

interface Send {
  content: string;
  embeds: APIEmbed[];
  files: { attachment: Buffer; name: string; description?: string }[];
}

/** A send that failed in a way that ends the move. */
class SendFailed extends Error {
  constructor(readonly reason: string, options: { cause: unknown }) {
    super(reason, options);
  }
}

/** Edits the confirmation message; once Discord refuses (the token expired), the result goes to the log instead. */
class Progress {
  private last = Date.now();
  private broken = false;

  constructor(private readonly ctx: ButtonContext) {}

  async show(content: string, force = false): Promise<void> {
    if (this.broken || (!force && Date.now() - this.last < PROGRESS_MS)) return;
    await this.edit(content);
  }

  async finish(content: string): Promise<void> {
    if (!this.broken) await this.edit(content);
    if (this.broken) this.ctx.log.info({ result: content }, 'A move finished after its confirmation could no longer be edited');
  }

  private async edit(content: string): Promise<void> {
    this.last = Date.now();
    try {
      await this.ctx.update({ content, components: [], flags: MessageFlags.SuppressEmbeds });
    } catch (error) {
      this.broken = true;
      this.ctx.log.info({ err: error }, 'Editing the move confirmation failed');
    }
  }
}

/** Lines of a list that fit the result, with a count of those that don't. */
function listLines(entries: string[], room: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const [index, entry] of entries.entries()) {
    if (used + entry.length + 1 > room) {
      lines.push(`- …and ${entries.length - index} more`);
      break;
    }
    lines.push(entry);
    used += entry.length + 1;
  }
  return lines;
}

/** Reposts ranges of messages through the target's Move webhook and deletes the originals. */
export class Mover {
  private readonly locks: ChannelLocks;
  /** Webhooks of running moves: how many moves use them, and until when they count after the last one ended. */
  private readonly active = new Map<string, { runs: number; until: number }>();

  constructor(deps: { locks: ChannelLocks }) {
    this.locks = deps.locks;
  }

  /** True while a move posts through the webhook, and shortly after. */
  isActiveWebhook(id: string): boolean {
    const entry = this.active.get(id);
    return entry !== undefined && (entry.runs > 0 || Date.now() < entry.until);
  }

  async run(ctx: ButtonContext, move: PendingMove): Promise<void> {
    const progress = new Progress(ctx);
    const release = await this.locks.acquire([move.sourceId, move.targetId], () => void progress.show('Waiting for another move…', true));
    try {
      await progress.finish(await this.execute(ctx, move, progress));
    } catch (error) {
      if (error instanceof UserError) {
        await progress.finish(`${error.message}\nNothing was moved.`);
      } else {
        ctx.log.error({ err: error, sourceId: move.sourceId, targetId: move.targetId }, 'A move failed');
        await progress.finish('The move failed. Nothing was deleted.');
      }
    } finally {
      release();
    }
  }

  private async execute(ctx: ButtonContext, move: PendingMove, progress: Progress): Promise<string> {
    const { guild, source, target } = await loadChannels(ctx.client, move.guildId, move.sourceId, move.targetId, move.userId);
    const messages = await readRange(source, move.fromId, move.toId, { requireEnds: false });
    const stickyApi = ctx.modules.optional(sticky);
    const context = { uploadLimit: move.uploadLimit, sourceIsForumPost: isForumPost(source), isSticky: (m: Message) => stickyApi?.isSticky(m) === true };
    const plans = messages.map((message) => [message, classify(message, context)] as const);
    const total = plans.filter(([, plan]) => plan.kind === 'repost').length;
    if (total === 0) return 'Nothing left to move.';

    const { webhook, threadId } = await findMoveWebhook(ctx.client, target.id);
    this.enter(webhook.id);
    try {
      const run = new Run(ctx, guild, source, target.id, webhook, threadId, move.uploadLimit);
      const failure = await run.repostAll(plans, async (done) => progress.show(`Moved ${done} of ${total}…`));
      if (failure !== null) return failure;
      await progress.show('Deleting the originals…');
      await run.deleteOriginals();
      return run.summary();
    } finally {
      this.leave(webhook.id);
    }
  }

  private enter(id: string): void {
    const entry = this.active.get(id) ?? { runs: 0, until: 0 };
    entry.runs += 1;
    this.active.set(id, entry);
  }

  private leave(id: string): void {
    const entry = this.active.get(id);
    if (entry === undefined) return;
    const now = Date.now();
    entry.runs -= 1;
    entry.until = now + ACTIVE_GRACE_MS;
    for (const [key, value] of this.active) if (value.runs === 0 && value.until <= now) this.active.delete(key);
  }
}

/** One move's reposting and deleting, with what it found along the way. */
class Run {
  /** Original message ID → its first repost. */
  private readonly reposted = new Map<string, string>();
  /** Every repost, for rolling back. */
  private readonly posted: string[] = [];
  private readonly toDelete: string[] = [];
  /** Reposted originals that stay, with their reasons. */
  private readonly stayed: { id: string; reasons: StayReason[] }[] = [];
  /** Originals that stay without a copy, since nothing of them could be posted. */
  private readonly notCopied: string[] = [];
  private readonly notDeleted: string[] = [];
  private moved = 0;
  private readonly members = new Map<string, Promise<GuildMember | null>>();

  constructor(
    private readonly ctx: ButtonContext,
    private readonly guild: Guild,
    private readonly source: GuildTextBasedChannel,
    private readonly targetId: string,
    private readonly webhook: IncomingWebhook,
    private readonly threadId: string | null,
    private readonly uploadLimit: number,
  ) {}

  /** Reposts in order; on a failed send, removes the reposts and returns the result to show. */
  async repostAll(plans: ReadonlyArray<readonly [Message, Plan]>, onProgress: (done: number) => Promise<void>): Promise<string | null> {
    let done = 0;
    try {
      for (const [message, plan] of plans) {
        if (plan.kind === 'skip-delete') this.toDelete.push(message.id);
        if (plan.kind !== 'repost') continue;
        await this.repost(message, plan);
        done += 1;
        await onProgress(done);
      }
      return null;
    } catch (error) {
      const reason = error instanceof SendFailed ? error.reason : 'something went wrong';
      this.ctx.log.warn({ err: error, sourceId: this.source.id, targetId: this.targetId }, 'A move stopped while reposting');
      const left = (await this.removeReposts(this.posted)).length;
      const removed = left === 0 ? 'the copies already posted were removed' : `**${left}** of the copies already posted couldn't be removed`;
      return `The move failed: ${reason}. Nothing was deleted, and ${removed}.`;
    }
  }

  private async repost(message: Message, plan: Extract<Plan, { kind: 'repost' }>): Promise<void> {
    const originalLink = link(this.guild.id, this.source.id, message.id);
    const replyTarget = await this.replyTarget(message);
    const input = { replyTarget, uploadLimit: this.uploadLimit, originalLink };
    let stays = plan.stays;
    let parts = renderMessage(message, plan, input);

    const files = parts.at(-1)!.files;
    const data: (Buffer | null)[] = [];
    let size = 0;
    for (const file of files) {
      const buffer = await downloadFile(file.url, this.uploadLimit).catch((error: unknown) => {
        this.ctx.log.debug({ err: error, messageId: message.id }, 'Downloading an attachment for a move failed');
        return null;
      });
      // Sticker images have no size until downloaded, so the total is checked here too.
      const fits = buffer !== null && size + buffer.length <= this.uploadLimit;
      if (fits) size += buffer.length;
      data.push(fits ? buffer : null);
    }
    if (data.includes(null) && !stays.includes('too-large')) {
      stays = [...stays, 'too-large'];
      parts = renderMessage(message, { kind: 'repost', stays }, input);
    }
    const attached = parts.at(-1)!.files.flatMap((file, index) => {
      const buffer = data[index];
      if (buffer === null || buffer === undefined) return [];
      const name = file.spoiler ? `SPOILER_${file.name}` : file.name;
      return [{ attachment: buffer, name, ...(file.description === undefined ? {} : { description: file.description }) }];
    });

    const sends = this.sends(parts, attached);
    if (sends.length === 0) {
      this.notCopied.push(message.id);
      return;
    }
    const member = message.webhookId === null ? await this.member(message.author.id) : null;
    const username = webhookName(displayName(member, message.author));
    const avatarURL = member?.displayAvatarURL() ?? message.author.displayAvatarURL();

    const own: string[] = [];
    let last: Message | undefined;
    for (const send of sends) {
      try {
        last = await withWebhookErrors(this.webhook.token, () =>
          this.webhook.send({
            ...send,
            username,
            avatarURL,
            threadId: this.threadId ?? undefined,
            allowedMentions: { parse: [] },
            flags: MessageFlags.SuppressNotifications,
          }),
        );
      } catch (error) {
        if (error instanceof DiscordAPIError && (error.status === 400 || error.status === 413)) {
          // Discord refuses this message's content; it stays behind without a copy and the move goes on.
          this.ctx.log.warn({ err: error, messageId: message.id }, 'Discord refused a repost');
          const left = new Set(await this.removeReposts(own));
          this.posted.splice(this.posted.length - own.length, own.length, ...own.filter((id) => left.has(id)));
          this.notCopied.push(message.id);
          return;
        }
        throw new SendFailed(error instanceof DiscordAPIError ? error.message : "I can't post in the target any more", { cause: error });
      }
      own.push(last.id);
      this.posted.push(last.id);
    }
    this.reposted.set(message.id, own[0]!);
    await this.react(message, last!);
    if (stays.length > 0) this.stayed.push({ id: message.id, reasons: stays });
    else this.toDelete.push(message.id);
  }

  /** The parts as sends: nothing empty, and files beyond Discord's limit on further sends. */
  private sends(parts: RepostPart[], attached: Send['files']): Send[] {
    const sends: Send[] = parts.map((part, index) => ({
      content: part.content,
      embeds: part.embeds,
      files: index === parts.length - 1 ? attached.slice(0, MAX_FILES) : [],
    }));
    for (let index = MAX_FILES; index < attached.length; index += MAX_FILES) {
      sends.push({ content: '', embeds: [], files: attached.slice(index, index + MAX_FILES) });
    }
    return sends.filter((send) => send.content.trim() !== '' || send.embeds.length > 0 || send.files.length > 0);
  }

  /** Each emoji once, in order; custom emojis only when the bot can use them. Failures are skipped. */
  private async react(message: Message, repost: Message): Promise<void> {
    for (const reaction of message.reactions.cache.values()) {
      try {
        const { emoji } = reaction;
        if (emoji.id !== null && !this.ctx.client.emojis.cache.has(emoji.id)) continue;
        await repost.react(emoji);
      } catch (error) {
        this.ctx.log.debug({ err: error, messageId: repost.id }, 'Adding a reaction to a repost failed');
      }
    }
  }

  private async replyTarget(message: Message): Promise<ReplyTarget> {
    if (message.type !== MessageType.Reply || message.reference?.messageId === undefined) return null;
    const replied = await message.fetchReference().catch(() => null);
    if (replied === null) return 'deleted';
    const member = replied.webhookId === null ? await this.member(replied.author.id) : null;
    const repost = this.reposted.get(replied.id);
    return {
      name: displayName(member, replied.author),
      link: repost === undefined ? link(this.guild.id, replied.channelId, replied.id) : link(this.guild.id, this.targetId, repost),
      text: replied.content,
    };
  }

  /** The author as a member, or null when they left. */
  private member(userId: string): Promise<GuildMember | null> {
    let found = this.members.get(userId);
    if (found === undefined) {
      found = this.guild.members.fetch(userId).catch(() => null);
      this.members.set(userId, found);
    }
    return found;
  }

  /** Deletes reposts through the webhook; returns those that couldn't be deleted. */
  private async removeReposts(ids: string[]): Promise<string[]> {
    const left: string[] = [];
    for (const id of ids) {
      try {
        await withWebhookErrors(this.webhook.token, () => this.webhook.deleteMessage(id, this.threadId ?? undefined));
      } catch (error) {
        left.push(id);
        this.ctx.log.warn({ err: error, messageId: id }, 'Removing a repost failed');
      }
    }
    return left;
  }

  /** Bulk deletes for young messages in chunks of up to 100, one by one for old ones and lone ones. */
  async deleteOriginals(): Promise<void> {
    const cutoff = Date.now() - BULK_MAX_AGE_MS;
    const young = this.toDelete.filter((id) => SnowflakeUtil.timestampFrom(id) > cutoff);
    const old = this.toDelete.filter((id) => SnowflakeUtil.timestampFrom(id) <= cutoff);
    for (let index = 0; index < young.length; index += BULK_SIZE) {
      const chunk = young.slice(index, index + BULK_SIZE);
      if (chunk.length === 1) {
        await this.deleteOne(chunk[0]!);
        continue;
      }
      try {
        await this.source.bulkDelete(chunk);
      } catch (error) {
        this.ctx.log.warn({ err: error, channelId: this.source.id }, 'Bulk deleting moved messages failed; deleting one by one');
        for (const id of chunk) await this.deleteOne(id);
      }
    }
    for (const id of old) await this.deleteOne(id);
    const reposted = new Set(this.reposted.keys());
    this.moved = this.toDelete.filter((id) => reposted.has(id) && !this.notDeleted.includes(id)).length;
  }

  private async deleteOne(id: string): Promise<void> {
    try {
      await this.source.messages.delete(id);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return;
      this.ctx.log.warn({ err: error, messageId: id }, 'Deleting a moved message failed');
      this.notDeleted.push(id);
    }
  }

  summary(): string {
    const original = (id: string) => link(this.guild.id, this.source.id, id);
    const sections: { title: string; entries: string[] }[] = [];
    if (this.stayed.length > 0) {
      sections.push({
        title: `${plural(this.stayed.length, 'message')} stayed behind, with a copy in <#${this.targetId}>:`,
        entries: this.stayed.map(({ id, reasons }) => `- ${original(id)} (${reasons.map((reason) => REASON_TEXT[reason]).join(', ')})`),
      });
    }
    if (this.notCopied.length > 0) {
      sections.push({ title: `${plural(this.notCopied.length, 'message')} couldn't be copied and stayed behind:`, entries: this.notCopied.map((id) => `- ${original(id)}`) });
    }
    if (this.notDeleted.length > 0) {
      sections.push({ title: `${plural(this.notDeleted.length, 'message')} couldn't be deleted; the copies are in the target:`, entries: this.notDeleted.map((id) => `- ${original(id)}`) });
    }
    const lines = [`Moved ${plural(this.moved, 'message')} to <#${this.targetId}>.`];
    const room = RESULT_LENGTH - lines[0]!.length - sections.reduce((sum, section) => sum + section.title.length + 1, 0);
    for (const section of sections) lines.push(section.title, ...listLines(section.entries, Math.floor(room / sections.length)));
    return lines.join('\n');
  }
}
