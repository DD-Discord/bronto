import { defineButton, UserError, type Reply, type ReplyMessage } from '@bronto/core';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, MessageFlags, type MessageMentionOptions } from 'discord.js';
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
  return {
    content: `Your submission to **${form.name}** isn't fully posted yet. Press Try again to post the rest, or Discard.`,
    components: [retryRow(ctx, posting.id)],
  };
}

/**
 * Why the member can't fill in the form now, checked in order: closed, not one of the allowed roles, already
 * submitted (a submission still being posted offers Try again and Discard instead), no fields, no channel. Null when
 * they can.
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
  if (form.channelId === null) return 'This form has no channel for submissions yet.';
  return null;
}

async function usernameOf(ctx: FormsContext, userId: string): Promise<string> {
  try {
    return (await ctx.client.users.fetch(userId)).username;
  } catch {
    return userId;
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
  const parts = renderSubmission({
    formName: form.name,
    userId,
    username: await usernameOf(ctx, userId),
    submittedAt,
    pingUserIds: form.pingUserIds,
    pingRoleIds: form.pingRoleIds,
    fields: form.fields,
    answers: draft.answers,
    files: kept,
    uploadLimit: limit,
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
        channelId: form.channelId!,
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

function failure(ctx: FormsContext, form: Form, submissionId: string, reason: string): ReplyMessage {
  return {
    content: `I couldn't post your submission to **${form.name}**: ${reason} Your answers are saved; press Try again to post the rest, or Discard.`,
    components: [retryRow(ctx, submissionId)],
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof MissingFileError) return `${error.file.name} is no longer available.`;
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

/**
 * Posts the stored parts of a submission not posted yet, one message each, recording each message as soon as it is
 * sent so that a retry continues after it. When all are posted, the draft and its files are deleted. Files are
 * downloaded from the drafts post with fresh links; `limit` caps each download.
 */
export async function postSubmission(ctx: FormsContext, submissionId: string, limit: number): Promise<Reply> {
  const { submission, form } = await loadSubmission(ctx, submissionId);
  if (submission.status === 'posted') return confirmation(form, submission);
  const { parts } = submission.render;
  try {
    const start = submission.partMessageIds.length;
    const pending = new Set(parts.slice(start).flatMap((part) => part.fileKeys));
    const data = await downloadFiles(ctx, submission.files.filter((file) => pending.has(file.key)), limit);
    const channel = await ctx.client.channels.fetch(submission.channelId);
    if (channel === null || !channel.isSendable()) return failure(ctx, form, submissionId, "the submissions channel can't be posted in.");
    for (const [index, part] of parts.entries()) {
      if (index < start) continue;
      const message = await channel.send({
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
            files: current.files.map((file) => (posted.has(file.key) ? { ...file, messageId: message.id, attachmentId: posted.get(file.key)! } : file)),
          })
          .where(eq(submissions.id, submissionId));
      });
    }
  } catch (error) {
    ctx.log.warn({ err: error, submissionId }, 'Posting a submission failed');
    return failure(ctx, form, submissionId, reasonOf(error));
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
