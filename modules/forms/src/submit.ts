import autoreact from '@bronto/autoreact';
import autothread from '@bronto/autothread';
import { defineButton, UserError, type Reply, type ReplyMessage } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  type Channel,
  type GuildMember,
  type Message,
  type MessageMentionOptions,
  type SendableChannels,
  type User,
} from 'discord.js';
import { and, eq, gte } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { drafts, forms, submissions, type Answer, type Form, type Submission, type SubmissionFile, type SubmissionRender } from './db/schema.js';
import { downloadFiles, fileLinks, loadDraft, MissingFileError, releaseFiles } from './drafts.js';
import { PAGE_SIZE } from './model.js';
import { renderSubmission } from './render.js';

/** Discord's limit on the text of a plain message. */
const MAX_CONTENT = 2000;
const MAX_SUMMARY_LINE = 120;
/** How often a task replaced in the queue is queued again before giving up. */
const QUEUE_ATTEMPTS = 5;

/** The queue key that serializes one member's work on one form. */
export const fillKey = (formId: string, userId: string) => `submit:${formId}:${userId}`;

/**
 * Runs `work` in the member's queue for the form and returns its result. The queue drops a waiting task that a newer
 * one replaces, so a dropped task is queued again; a queue that keeps dropping it (the bot is stopping) is reported to
 * the member.
 */
export async function queued<T>(ctx: FormsContext, formId: string, userId: string, work: (task: FormsContext) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < QUEUE_ATTEMPTS; attempt++) {
    let outcome: { value: T } | { error: unknown } | undefined;
    await ctx.queue.run(fillKey(formId, userId), async (task) => {
      try {
        outcome = { value: await work(task as FormsContext) };
      } catch (error) {
        outcome = { error };
      }
    });
    if (outcome === undefined) continue;
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  throw new UserError("I couldn't get to that right now. Try again in a moment.");
}

/** `bytes` in whole megabytes, rounded down. */
export const megabytes = (bytes: number) => Math.floor(bytes / 1024 / 1024);

export const tooLarge = (name: string, limit: number) => `${name} is larger than ${megabytes(limit)} MB, the most this server accepts.`;

async function postingSubmission(ctx: FormsContext, formId: string, userId: string): Promise<Submission | null> {
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .select()
      .from(submissions)
      .where(and(eq(submissions.formId, formId), eq(submissions.userId, userId), eq(submissions.status, 'posting'))),
  );
  return row ?? null;
}

/** Whether the member has a posted or posting submission of the form, optionally one made at or after `after`. */
export async function hasSubmitted(ctx: FormsContext, formId: string, userId: string, after?: Date): Promise<boolean> {
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.formId, formId), eq(submissions.userId, userId), after === undefined ? undefined : gte(submissions.submittedAt, after)))
      .limit(1),
  );
  return row !== undefined;
}

function retryRow(ctx: FormsContext, submissionId: string): ActionRowBuilder<ButtonBuilder> {
  const retry = new ButtonBuilder().setCustomId(ctx.customId(retryPostButton, [submissionId])).setLabel('Try again').setStyle(ButtonStyle.Primary);
  const discard = new ButtonBuilder().setCustomId(ctx.customId(discardPostButton, [submissionId])).setLabel('Discard').setStyle(ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(retry, discard);
}

/** Try again and Discard for the member's submission still being posted, or null when there is none. */
export async function postingRefusal(ctx: FormsContext, form: Form, userId: string): Promise<ReplyMessage | null> {
  const posting = await postingSubmission(ctx, form.id, userId);
  if (posting === null) return null;
  const content =
    posting.partMessageIds.length >= posting.render.parts.length
      ? `Your submission to **${form.name}** is posted, but its thread isn't open yet. Press Try again to open it, or Discard.`
      : `Your submission to **${form.name}** isn't fully posted yet. Press Try again to post the rest, or Discard.`;
  return {
    content,
    components: [retryRow(ctx, posting.id)],
  };
}

/**
 * Why the member can't fill in the form now, checked in order: closed, not one of the allowed roles, already
 * submitted (a submission still being posted offers Try again and Discard instead), no fields. Null when they can.
 */
export async function refusal(ctx: FormsContext, form: Form, userId: string): Promise<Reply | null> {
  if (!form.active) return 'This form is currently closed.';
  if (form.allowedRoleIds.length > 0) {
    const guild = await ctx.client.guilds.fetch(ctx.guildId);
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.hasAny(...form.allowedRoleIds)) return "You can't fill in this form.";
  }
  const posting = await postingRefusal(ctx, form, userId);
  if (posting !== null) return posting;
  if (form.oncePerMember && (await hasSubmitted(ctx, form.id, userId))) return 'You already submitted this form.';
  if (form.fields.length === 0) return 'This form has no fields yet.';
  return null;
}

const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

/** The submitter as a guild member, else as a user; `author` is null when neither can be fetched. */
export async function submitterOf(ctx: FormsContext, userId: string): Promise<{ author: GuildMember | User | null; username: string; avatarUrl: string }> {
  try {
    const guild = await ctx.client.guilds.fetch(ctx.guildId);
    const member = await guild.members.fetch(userId);
    return { author: member, username: member.user.username, avatarUrl: member.displayAvatarURL() };
  } catch {
    // Not a member any more; fall back to the account.
  }
  try {
    const user = await ctx.client.users.fetch(userId);
    return { author: user, username: user.username, avatarUrl: user.displayAvatarURL() };
  } catch {
    return { author: null, username: userId, avatarUrl: DEFAULT_AVATAR };
  }
}

/** A refusal of the final submit that keeps the draft: Cancel, and with `retry` Try again on the draft's page. */
export type Refuse = (message: string, retry: boolean) => ReplyMessage;

/**
 * Turns the member's draft into a submission and posts it. The open checks run again first; the unique index on
 * one-per-member submissions decides a race between two final submits, and `openedAt` (when the last page was shown)
 * catches a repeated submit of the same modal. The parts are rendered once here and stored with the submission.
 */
export async function submit(ctx: FormsContext, formId: string, userId: string, limit: number, openedAt: Date, refuse: Refuse): Promise<Reply> {
  const [form] = await ctx.db.run(async (tx) => tx.select().from(forms).where(eq(forms.id, formId)));
  if (form === undefined) throw new UserError('This form no longer exists.');
  const refused = await refusal(ctx, form, userId);
  if (typeof refused === 'string') return refuse(refused, false);
  if (refused !== null) return refused;
  if (await hasSubmitted(ctx, formId, userId, openedAt)) return 'You already submitted this form.';
  const draft = await loadDraft(ctx, formId, userId, false);
  if (draft === null) return 'Your answers are no longer saved. Open the form again to start over.';

  const fileFields = new Set(form.fields.filter((field) => field.type === 'file').map((field) => field.id));
  const links = await fileLinks(ctx, draft.files.filter((file) => fileFields.has(file.fieldId)));
  const dropped: SubmissionRender['dropped'] = [];
  const kept = draft.files.filter((file) => {
    if (!fileFields.has(file.fieldId)) dropped.push({ name: file.name, reason: 'removed' });
    else if (!links.has(file.attachmentId)) dropped.push({ name: file.name, reason: 'missing' });
    else return true;
    return false;
  });
  const big = kept.find((file) => file.size > limit);
  if (big !== undefined) {
    // Try again shows the page with the file, to upload a smaller one.
    const page = Math.floor(form.fields.findIndex((field) => field.id === big.fieldId) / PAGE_SIZE);
    await ctx.db.run(async (tx) => {
      await tx
        .update(drafts)
        .set({ page })
        .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, false)));
    });
    return refuse(`${tooLarge(big.name, limit)} Press Try again to upload a smaller file.`, true);
  }
  const submittedAt = new Date();
  const { username, avatarUrl } = await submitterOf(ctx, userId);
  const parts = renderSubmission({
    formName: form.name,
    userId,
    username,
    avatarUrl,
    submittedAt,
    pingUserIds: form.pingUserIds,
    pingRoleIds: form.pingRoleIds,
    fields: form.fields,
    answers: draft.answers,
    files: kept,
    uploadLimit: limit,
    answersApart: form.answersApart,
  });
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .insert(submissions)
      .values({
        formId,
        userId,
        submittedAt,
        answers: draft.answers,
        files: draft.files,
        channelId: form.channelId ?? form.threadId,
        status: 'posting',
        once: form.oncePerMember,
        render: { fields: form.fields, parts, dropped },
      })
      .onConflictDoNothing()
      .returning(),
  );
  if (row === undefined) return 'You already submitted this form.';
  ctx.log.info({ formId, submissionId: row.id }, 'Form submitted');
  return postSubmission(ctx, row.id, limit);
}

/** `files` are the submission's files that were posted. */
function answerSummary(answer: Answer | undefined, files: SubmissionFile[]): string | null {
  if (answer === undefined) return null;
  let text: string;
  if ('text' in answer) text = answer.text.trim().replace(/\s+/g, ' ');
  else if ('choices' in answer) text = answer.choices.join(', ');
  else text = files.filter((file) => answer.files.includes(file.key)).map((file) => file.name).join(', ');
  if (text === '') return null;
  return text.length <= MAX_SUMMARY_LINE ? text : `${text.slice(0, MAX_SUMMARY_LINE - 1)}…`;
}

function droppedNote(dropped: SubmissionRender['dropped']): string {
  if (dropped.length === 0) return '';
  const names = dropped.map(({ name, reason }) => `${name} (${reason === 'removed' ? 'its field was removed' : 'no longer available'})`);
  return `\nThese files weren't posted: ${names.join(', ')}.`;
}

/** The confirmation: `head`, what was answered (cut to fit one message), and `tail`. */
function summary(head: string, submission: Submission, tail: string): string {
  const lines: string[] = [];
  let used = head.length + tail.length;
  const more = '\n…';
  const dropped = new Set(submission.render.dropped.map((file) => file.name));
  const posted = submission.files.filter((file) => !dropped.has(file.name));
  for (const field of submission.render.fields) {
    const text = answerSummary(submission.answers[field.id], posted);
    if (text === null) continue;
    const line = `\n**${field.label}:** ${text}`;
    if (used + line.length + more.length > MAX_CONTENT) {
      lines.push(more);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return head + lines.join('') + tail;
}

const confirmation = (form: Form, submission: Submission) => summary(`Submitted to **${form.name}**.`, submission, droppedNote(submission.render.dropped));

/** The reply to a failed posting; `allPosted` when only the thread on part 1 is missing. */
function failure(ctx: FormsContext, form: Form, submissionId: string, reason: string, allPosted = false): ReplyMessage {
  return {
    content: allPosted
      ? `Your submission to **${form.name}** is posted, but I couldn't open its thread: ${reason} Press Try again to open it, or Discard to leave it without one.`
      : `I couldn't post your submission to **${form.name}**: ${reason} Your answers are saved; press Try again to post the rest, or Discard.`,
    components: [retryRow(ctx, submissionId)],
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof MissingFileError) return `${error.file.name} is no longer available.`;
  if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return "the submissions channel or the form's post no longer exists.";
  if (error instanceof DiscordAPIError) return `Discord answered "${error.message}".`;
  return 'something went wrong.';
}

async function loadSubmission(ctx: FormsContext, submissionId: string): Promise<{ submission: Submission; form: Form }> {
  const loaded = await ctx.db.run(async (tx) => {
    const [submission] = await tx.select().from(submissions).where(eq(submissions.id, submissionId));
    if (submission === undefined) return null;
    const [form] = await tx.select().from(forms).where(eq(forms.id, submission.formId));
    return form === undefined ? null : { submission, form };
  });
  if (loaded === null) throw new UserError('This submission no longer exists.');
  return loaded;
}

/** Marks the submission posted and deletes the member's draft and its files. */
async function finish(ctx: FormsContext, submission: Submission): Promise<void> {
  const gone = await ctx.db.run(async (tx) => {
    await tx.update(submissions).set({ status: 'posted' }).where(eq(submissions.id, submission.id));
    return tx
      .delete(drafts)
      .where(and(eq(drafts.formId, submission.formId), eq(drafts.userId, submission.userId), eq(drafts.dry, false)))
      .returning();
  });
  await releaseFiles(ctx, gone.flatMap((draft) => draft.files), []);
}

async function sendableChannel(ctx: FormsContext, id: string): Promise<SendableChannels | null> {
  const channel = await ctx.client.channels.fetch(id);
  return channel !== null && channel.isSendable() ? channel : null;
}

/**
 * Applies the channel's autoreact rule (with `react`) and autothread rule (with `thread`) to part 1 as if the
 * submitter had posted it. The opened thread, or null without one; also null when the submitter's account can't be
 * fetched.
 */
async function applyRules(ctx: FormsContext, part1: Message, userId: string, apply: { react: boolean; thread: boolean }): Promise<SendableChannels | null> {
  const reactions = apply.react ? ctx.modules.optional(autoreact) : null;
  const threads = apply.thread ? ctx.modules.optional(autothread) : null;
  if (reactions === null && threads === null) return null;
  const { author } = await submitterOf(ctx, userId);
  if (author === null) return null;
  await reactions?.reactPost(part1, author);
  const threadId = (await threads?.threadPost(part1, author)) ?? null;
  return threadId === null ? null : sendableChannel(ctx, threadId);
}

/** The channel, fetched fresh; null when it no longer exists. */
async function fetchChannel(ctx: FormsContext, id: string): Promise<Channel | null> {
  try {
    return await ctx.client.channels.fetch(id, { force: true });
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) return null;
    throw error;
  }
}

/** The message, fetched fresh; null when it isn't in the channel (deleted, or never posted there). */
async function messageIn(channel: SendableChannels, messageId: string): Promise<Message | null> {
  try {
    return await channel.messages.fetch({ message: messageId, force: true });
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) return null;
    throw error;
  }
}

/**
 * Where a retry posts the parts after part 1, so that a submission is never split between a thread and the channel:
 * - once part 2 is posted, the channel or thread it went to (`restChannelId`), reopened if archived; the channel when
 *   that no longer exists;
 * - while part 1 is the only part posted: the thread on part 1 (a thread started on a message has its ID), reopened
 *   if archived; else a thread the channel's rule opens now when part 1 still exists; else the channel.
 */
async function retryTarget(ctx: FormsContext, channel: SendableChannels, submission: Submission): Promise<SendableChannels> {
  if (submission.restChannelId !== null) {
    const rest = await fetchChannel(ctx, submission.restChannelId);
    if (rest === null || !rest.isSendable()) return channel;
    if (rest.isThread() && rest.archived === true) await rest.setArchived(false);
    return rest;
  }
  const part1Id = submission.partMessageIds[0]!;
  const thread = await fetchChannel(ctx, part1Id);
  if (thread !== null) {
    if (!thread.isThread() || !thread.isSendable()) return channel;
    if (thread.archived === true) await thread.setArchived(false);
    return thread;
  }
  if (ctx.modules.optional(autothread) === null) return channel;
  const part1 = await messageIn(channel, part1Id);
  if (part1 === null) return channel;
  return (await applyRules(ctx, part1, submission.userId, { react: false, thread: true })) ?? channel;
}

/**
 * Posts the stored parts of a submission not posted yet, one message each, recording each message as soon as it is
 * sent so that a retry continues after it. Part 1 goes to the submissions channel and gets the channel's autoreact
 * rule as if the submitter had posted it, and, outside threads, its autothread rule; the later parts go into the
 * thread when there is one. When all are posted, the draft and its files are deleted. Files are downloaded from the
 * drafts post with fresh links; `limit` caps each download.
 */
export async function postSubmission(ctx: FormsContext, submissionId: string, limit: number): Promise<Reply> {
  const { submission, form } = await loadSubmission(ctx, submissionId);
  if (submission.status === 'posted') return confirmation(form, submission);
  const { parts } = submission.render;
  const start = submission.partMessageIds.length;
  let postedParts = start;
  try {
    const pending = new Set(parts.slice(start).flatMap((part) => part.fileKeys));
    const data = await downloadFiles(ctx, submission.files.filter((file) => pending.has(file.key)), limit);
    // Fresh, so that an archived post is noticed.
    const channel = await ctx.client.channels.fetch(submission.channelId, { force: true });
    if (channel === null || !channel.isSendable()) return failure(ctx, form, submissionId, "the submissions channel can't be posted in.");
    if (channel.isThread() && channel.archived === true) await channel.setArchived(false);
    // A thread can't hold another thread: in a thread channel, every part stays in it.
    const inThread = channel.isThread();
    let rest = start === 0 || inThread ? channel : await retryTarget(ctx, channel, submission);
    for (const [index, part] of parts.entries()) {
      if (index < start) continue;
      const target = index === 0 ? channel : rest;
      const message = await target.send({
        components: part.components,
        flags: MessageFlags.IsComponentsV2,
        files: part.files.map((file) => ({ attachment: data.get(file.key)!, name: file.name })),
        allowedMentions: part.allowedMentions as MessageMentionOptions,
      });
      const attachments = new Map(message.attachments.map((attachment) => [attachment.name, attachment.id]));
      const posted = new Map(part.files.map((file) => [file.key, attachments.get(file.name) ?? '']));
      await ctx.db.run(async (tx) => {
        const [current] = await tx.select().from(submissions).where(eq(submissions.id, submissionId)).for('update');
        if (current === undefined) return;
        await tx
          .update(submissions)
          .set({
            partMessageIds: [...current.partMessageIds, message.id],
            ...(index === 1 ? { restChannelId: target.id } : {}),
            files: current.files.map((file) => (posted.has(file.key) ? { ...file, messageId: message.id, attachmentId: posted.get(file.key)! } : file)),
          })
          .where(eq(submissions.id, submissionId));
      });
      postedParts++;
      if (index === 0) rest = (await applyRules(ctx, message, submission.userId, { react: true, thread: !inThread })) ?? channel;
    }
  } catch (error) {
    ctx.log.warn({ err: error, submissionId }, 'Posting a submission failed');
    return failure(ctx, form, submissionId, reasonOf(error), postedParts >= parts.length);
  }
  await finish(ctx, submission);
  ctx.log.info({ formId: form.id, submissionId, parts: parts.length }, 'Submission posted');
  return confirmation(form, submission);
}

/**
 * Gives up on posting the rest of a submission. Without a posted part the submission is deleted and the draft kept;
 * otherwise it counts as posted, and the reply names the parts that weren't.
 */
async function discardSubmission(ctx: FormsContext, submissionId: string): Promise<Reply> {
  const { submission, form } = await loadSubmission(ctx, submissionId);
  if (submission.status === 'posted') return confirmation(form, submission);
  const posted = submission.partMessageIds.length;
  const total = submission.render.parts.length;
  if (posted >= total) {
    // Only the thread on part 1 was missing.
    await finish(ctx, submission);
    ctx.log.info({ formId: form.id, submissionId }, 'Submission discarded without its thread');
    return confirmation(form, submission);
  }
  if (posted === 0) {
    await ctx.db.run(async (tx) => {
      await tx.delete(submissions).where(and(eq(submissions.id, submissionId), eq(submissions.status, 'posting')));
    });
    ctx.log.info({ formId: form.id, submissionId }, 'Submission discarded before posting');
    return `Discarded. Nothing was posted to **${form.name}**; your answers are still saved, so you can open the form again.`;
  }
  await finish(ctx, submission);
  ctx.log.info({ formId: form.id, submissionId, posted, total }, 'Submission discarded after some parts');
  const missing = posted + 1 === total ? `Part ${total}` : `Parts ${posted + 1}–${total}`;
  return summary(`Submitted to **${form.name}** without the rest. ${missing} of ${total} weren't posted.`, submission, droppedNote(submission.render.dropped));
}

async function submissionOwner(ctx: FormsContext, id: string): Promise<{ formId: string; userId: string }> {
  const [row] = await ctx.db.run(async (tx) => tx.select({ formId: submissions.formId, userId: submissions.userId }).from(submissions).where(eq(submissions.id, id)));
  if (row === undefined) throw new UserError('This submission no longer exists.');
  return row;
}

/** Posts the rest of a submission whose posting failed: `[submissionId]`. */
export const retryPostButton = defineButton({
  name: 'post-retry',
  bind: { user: true },
  ephemeral: true,
  execute: async (ctx, args) => {
    const id = args[0] ?? '';
    const { formId, userId } = await submissionOwner(ctx, id);
    const limit = ctx.interaction.attachmentSizeLimit;
    await ctx.reply(await queued(ctx, formId, userId, (task) => postSubmission(task, id, limit)));
  },
});

/** Stops trying to post a submission: `[submissionId]`. */
export const discardPostButton = defineButton({
  name: 'post-discard',
  bind: { user: true },
  ephemeral: true,
  execute: async (ctx, args) => {
    const id = args[0] ?? '';
    const { formId, userId } = await submissionOwner(ctx, id);
    await ctx.reply(await queued(ctx, formId, userId, (task) => discardSubmission(task, id)));
  },
});
