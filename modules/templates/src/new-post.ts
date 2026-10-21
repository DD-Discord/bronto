import { UserError } from '@bronto/core';
import { PermissionFlagsBits, type APIEmbed, type AnyThreadChannel, type GuildBasedChannel } from 'discord.js';
import { sendableEmbed, type TemplateMessage } from './content.js';
import type { TemplatesContext } from './context.js';
import type { ImageSlot } from './db/schema.js';
import { storedForumId } from './forum.js';
import { DOWNLOAD_TIMEOUT_MS } from './images.js';
import { createPost, type PendingUpload } from './posts.js';
import { parseBody } from './transfer.js';

const ATTACHMENT_LINK = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//;

const SLOT_URLS: Record<ImageSlot, (embed: APIEmbed) => string | undefined> = {
  image: (embed) => embed.image?.url,
  thumbnail: (embed) => embed.thumbnail?.url,
  author_icon: (embed) => embed.author?.icon_url,
  footer_icon: (embed) => embed.footer?.icon_url,
};

type Body = TemplateMessage & { uploads: PendingUpload[] };

async function download(url: string, slot: ImageSlot): Promise<PendingUpload> {
  const failure = new UserError("I couldn't download an image from that message.");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw failure;
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return { slot, name, data: Buffer.from(await response.arrayBuffer()) };
  } catch {
    throw failure;
  }
}

/** Whether the member who wrote the post may view the channel and its history. */
async function posterCanRead(ctx: TemplatesContext, channel: GuildBasedChannel, posterId: string): Promise<boolean> {
  let member;
  try {
    member = await channel.guild.members.fetch(posterId);
  } catch (error) {
    ctx.log.debug({ err: error }, 'Fetching the member who wrote a post failed');
    return false;
  }
  return channel.permissionsFor(member).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
}

/** The content and first embed of a message in this server; Discord-hosted images of the embed are downloaded. */
async function fromLink(
  ctx: TemplatesContext,
  link: { guildId: string; channelId: string; messageId: string },
  posterId: string,
): Promise<Body> {
  if (link.guildId !== ctx.guildId) throw new UserError('The message link must point to this server.');
  let message;
  try {
    const channel = await ctx.client.channels.fetch(link.channelId);
    if (channel === null || !channel.isTextBased()) throw new Error('not a text channel');
    if (channel.isDMBased() || !(await posterCanRead(ctx, channel, posterId))) {
      throw new UserError('You can only import messages you can read.');
    }
    message = await channel.messages.fetch(link.messageId);
  } catch (error) {
    if (error instanceof UserError) throw error;
    ctx.log.debug({ err: error }, 'Reading the linked message failed');
    throw new UserError("I couldn't read that message.");
  }
  const first = message.embeds[0];
  const embed = first === undefined ? null : sendableEmbed(first.toJSON());
  const uploads: PendingUpload[] = [];
  if (embed !== null) {
    for (const slot of Object.keys(SLOT_URLS) as ImageSlot[]) {
      const url = SLOT_URLS[slot](embed);
      if (url !== undefined && ATTACHMENT_LINK.test(url)) uploads.push(await download(url, slot));
    }
  }
  return { content: message.content, embed, uploads };
}

async function bodyOf(ctx: TemplatesContext, text: string, posterId: string): Promise<Body> {
  const parsed = parseBody(text);
  switch (parsed.kind) {
    case 'link':
      return fromLink(ctx, parsed, posterId);
    case 'json':
      return { ...parsed.message, uploads: [] };
    case 'text':
      return { content: parsed.content, embed: null, uploads: [] };
  }
}

async function reply(ctx: TemplatesContext, thread: AnyThreadChannel, text: string): Promise<void> {
  try {
    await thread.send({ content: text, allowedMentions: { parse: [] } });
  } catch (error) {
    ctx.log.warn({ err: error, threadId: thread.id }, 'Replying in a forum post failed');
  }
}

/**
 * Turns a new post in the template forum into a template owned by the bot: the starter message is read as a link,
 * JSON or plain text, and once the template exists the user's post is deleted. Problems are answered in the post,
 * which stays.
 */
export async function onThreadCreate(ctx: TemplatesContext, thread: AnyThreadChannel, newlyCreated: boolean): Promise<void> {
  if (!newlyCreated || thread.ownerId === ctx.client.user?.id) return;
  const forumId = await storedForumId(ctx);
  if (forumId === null || thread.parentId !== forumId) return;
  try {
    const starter = await thread.fetchStarterMessage();
    if (starter === null) return;
    const body = await bodyOf(ctx, starter.content, starter.author.id);
    await createPost(ctx, { name: thread.name, tags: thread.appliedTags, ...body });
  } catch (error) {
    const reason = error instanceof UserError ? error.message : 'Something went wrong.';
    await reply(ctx, thread, `I couldn't turn this post into a template: ${reason}`);
    if (!(error instanceof UserError)) throw error;
    return;
  }
  try {
    await thread.delete();
  } catch (error) {
    ctx.log.warn({ err: error, threadId: thread.id }, "Deleting the user's post after creating its template failed");
  }
}
