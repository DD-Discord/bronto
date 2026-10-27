import { defineButton, UserError, type Reply, type ReplyMessage } from '@bronto/core';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, DiscordAPIError, MessageFlags, type MessageMentionOptions } from 'discord.js';
import { and, eq, sql } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { drafts, forms, submissions, type Answer, type Form, type Submission, type SubmissionFile } from './db/schema.js';
import { downloadFiles, loadDraft, MissingFileError, releaseFiles } from './drafts.js';
import { renderSubmission, type RenderedPart } from './render.js';

/** Discord's limit on the text of a plain message. */
const MAX_CONTENT = 2000;
const MAX_SUMMARY_LINE = 120;

/** The queue key that serializes one member's work on one form. */
export const fillKey = (formId: string, userId: string) => `submit:${formId}:${userId}`;

/**
 * Runs `work` in the member's queue for the form and returns its reply. A task replaced while waiting yields to the
 * newer one, which answers its own interaction.
 */
export async function queued(ctx: FormsContext, formId: string, userId: string, work: (task: FormsContext) => Promise<Reply>): Promise<Reply> {
  let outcome: { reply: Reply } | { error: unknown } | undefined;
  await ctx.queue.run(fillKey(formId, userId), async (task) => {
    try {
      outcome = { reply: await work(task as FormsContext) };
    } catch (error) {
      outcome = { error };
    }
  });
  if (outcome === undefined) return 'Your answers are already being saved.';
  if ('error' in outcome) throw outcome.error;
  return outcome.reply;
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

/** Whether the member has a posted or posting submission of the form. */
export async function hasSubmitted(ctx: FormsContext, formId: string, userId: string, since?: Date): Promise<boolean> {
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.formId, formId), eq(submissions.userId, userId), since === undefined ? undefined : sql`${submissions.submittedAt} >= ${since}`))
      .limit(1),
  );
  return row !== undefined;
}

function retryRow(ctx: FormsContext, submissionId: string): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder().setCustomId(ctx.customId(retryPostButton, [submissionId])).setLabel('Try again').setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Why the member can't fill in the form now, checked in order: closed, not one of the allowed roles, already
 * submitted (a submission still being posted offers Try again instead), no fields, no channel. Null when they can.
 */
export async function refusal(ctx: FormsContext, form: Form, userId: string): Promise<Reply | null> {
  if (!form.active) return 'This form is currently closed.';
  if (form.allowedRoleIds.length > 0) {
    const guild = await ctx.client.guilds.fetch(ctx.guildId);
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.hasAny(...form.allowedRoleIds)) return "You can't fill in this form.";
  }
  const posting = await postingSubmission(ctx, form.id, userId);
  if (posting !== null) {
    return { content: `Your submission to **${form.name}** isn't fully posted yet. Press Try again to post the rest.`, components: [retryRow(ctx, posting.id)] };
  }
  if (form.oncePerMember && (await hasSubmitted(ctx, form.id, userId))) return 'You already submitted this form.';
  if (form.fields.length === 0) return 'This form has no fields yet.';
  if (form.channelId === null) return 'This form has no channel for submissions yet.';
  return null;
}

/**
 * Turns the member's draft into a submission and posts it. The open checks run again first; the unique index on
 * one-per-member submissions decides a race between two final submits.
 */
export async function submit(ctx: FormsContext, formId: string, userId: string, limit: number): Promise<Reply> {
  const [form] = await ctx.db.run(async (tx) => tx.select().from(forms).where(eq(forms.id, formId)));
  if (form === undefined) throw new UserError('This form no longer exists.');
  const refused = await refusal(ctx, form, userId);
  if (refused !== null) return refused;
  const draft = await loadDraft(ctx, formId, userId, false);
  if (draft === null) return 'Your answers are no longer saved. Open the form again to start over.';
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .insert(submissions)
      .values({
        formId,
        userId,
        answers: draft.answers,
        files: draft.files,
        channelId: form.channelId!,
        status: 'posting',
        once: form.oncePerMember,
      })
      .onConflictDoNothing()
      .returning(),
  );
  if (row === undefined) return 'You already submitted this form.';
  ctx.log.info({ formId, submissionId: row.id }, 'Form submitted');
  return postSubmission(ctx, row.id, limit);
}

function answerSummary(answer: Answer | undefined, files: SubmissionFile[]): string | null {
  if (answer === undefined) return null;
  let text: string;
  if ('text' in answer) text = answer.text.trim().replace(/\s+/g, ' ');
  else if ('choices' in answer) text = answer.choices.join(', ');
  else text = files.filter((file) => answer.files.includes(file.key)).map((file) => file.name).join(', ');
  if (text === '') return null;
  return text.length <= MAX_SUMMARY_LINE ? text : `${text.slice(0, MAX_SUMMARY_LINE - 1)}…`;
}

/** The confirmation: the form, what was answered (cut to fit one message), and files that weren't posted. */
function confirmation(form: Form, submission: Submission, dropped: number): string {
  const head = `Submitted to **${form.name}**.`;
  const note = dropped === 0 ? '' : `\n${dropped === 1 ? "1 file for a field that was removed wasn't posted." : `${dropped} files for fields that were removed weren't posted.`}`;
  const lines: string[] = [];
  let used = head.length + note.length;
  const more = '\n…';
  for (const field of form.fields) {
    const summary = answerSummary(submission.answers[field.id], submission.files);
    if (summary === null) continue;
    const line = `\n**${field.label}:** ${summary}`;
    if (used + line.length + more.length > MAX_CONTENT) {
      lines.push(more);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return head + lines.join('') + note;
}

function failure(ctx: FormsContext, form: Form, submissionId: string, reason: string): ReplyMessage {
  return {
    content: `I couldn't post your submission to **${form.name}**: ${reason} Your answers are saved; press Try again to post the rest.`,
    components: [retryRow(ctx, submissionId)],
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof MissingFileError) return `${error.file.name} is no longer available.`;
  if (error instanceof DiscordAPIError) return `Discord answered "${error.message}".`;
  return 'something went wrong.';
}

async function usernameOf(ctx: FormsContext, userId: string): Promise<string> {
  try {
    return (await ctx.client.users.fetch(userId)).username;
  } catch {
    return userId;
  }
}

/**
 * Posts the parts of a submission not posted yet, one message each, recording each message as soon as it is sent so
 * that a retry continues after it. When all are posted, the draft and its files are deleted. Files are downloaded
 * from the drafts post with fresh links; `limit` is the upload limit of the interaction that posts.
 */
export async function postSubmission(ctx: FormsContext, submissionId: string, limit: number): Promise<Reply> {
  const loaded = await ctx.db.run(async (tx) => {
    const [submission] = await tx.select().from(submissions).where(eq(submissions.id, submissionId));
    if (submission === undefined) return null;
    const [form] = await tx.select().from(forms).where(eq(forms.id, submission.formId));
    return form === undefined ? null : { submission, form };
  });
  if (loaded === null) throw new UserError('This submission no longer exists.');
  const { submission, form } = loaded;
  const fileFields = new Set(form.fields.filter((field) => field.type === 'file').map((field) => field.id));
  const files = submission.files.filter((file) => fileFields.has(file.fieldId));
  const dropped = submission.files.length - files.length;
  if (submission.status === 'posted') return confirmation(form, submission, dropped);

  const big = files.find((file) => file.size > limit);
  if (big !== undefined) return failure(ctx, form, submissionId, tooLarge(big.name, limit));
  let parts: RenderedPart[];
  try {
    parts = renderSubmission({
      formName: form.name,
      userId: submission.userId,
      username: await usernameOf(ctx, submission.userId),
      submittedAt: submission.submittedAt,
      pingUserIds: form.pingUserIds,
      pingRoleIds: form.pingRoleIds,
      fields: form.fields,
      answers: submission.answers,
      files,
      uploadLimit: limit,
    });
  } catch (error) {
    ctx.log.warn({ err: error, submissionId }, 'Rendering a submission failed');
    return failure(ctx, form, submissionId, 'it could not be laid out.');
  }

  try {
    const start = submission.partMessageIds.length;
    const pending = new Set(parts.slice(start).flatMap((part) => part.fileKeys));
    const data = await downloadFiles(ctx, files.filter((file) => pending.has(file.key)), limit);
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

  const gone = await ctx.db.run(async (tx) => {
    await tx.update(submissions).set({ status: 'posted' }).where(eq(submissions.id, submissionId));
    return tx
      .delete(drafts)
      .where(and(eq(drafts.formId, form.id), eq(drafts.userId, submission.userId), eq(drafts.dry, false)))
      .returning();
  });
  await releaseFiles(ctx, gone.flatMap((draft) => draft.files), []);
  ctx.log.info({ formId: form.id, submissionId, parts: parts.length }, 'Submission posted');
  return confirmation(form, submission, dropped);
}

/** Posts the rest of a submission whose posting failed. */
export const retryPostButton = defineButton({
  name: 'post-retry',
  bind: { user: true },
  ephemeral: true,
  execute: async (ctx, args) => {
    const id = args[0] ?? '';
    const [row] = await ctx.db.run(async (tx) => tx.select({ formId: submissions.formId, userId: submissions.userId }).from(submissions).where(eq(submissions.id, id)));
    if (row === undefined) throw new UserError('This submission no longer exists.');
    const limit = ctx.interaction.attachmentSizeLimit;
    await ctx.reply(await queued(ctx, row.formId, row.userId, (task) => postSubmission(task, id, limit)));
  },
});
