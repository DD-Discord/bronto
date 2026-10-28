import { defineButton, defineModal, downloadFile, UserError, type ButtonContext, type ModalContext, type Reply, type ReplyMessage } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  CheckboxBuilder,
  CheckboxGroupBuilder,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RadioGroupBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Attachment,
} from 'discord.js';
import { and, eq } from 'drizzle-orm';
import type { FormsContext } from './context.js';
import { drafts, forms, openers, type Answer, type Draft, type DraftFile, type Form } from './db/schema.js';
import { deleteDraft, DRAFT_TTL_MS, isExpired, loadDraft, releaseFiles, storeFiles, type NewFile } from './drafts.js';
import { pages, PAGE_SIZE, type Field } from './model.js';
import { formById, formForThread, requireEditor } from './permissions.js';
import { renderSubmission } from './render.js';
import { hasSubmitted, postingRefusal, queued, refusal, submit, submitterOf, tooLarge } from './submit.js';

// Discord's limit for modal titles.
const MAX_TITLE = 45;
const MAX_TEXT = 4000;
// Discord's limit for label descriptions.
const MAX_DESCRIPTION = 100;
const EXPIRED = 'Your answers to the earlier pages are no longer saved. Open the form again to start over.';
const CHANGED = 'This form changed while you were filling it in. Press Try again to see the current page.';

const flag = (dry: boolean) => (dry ? '1' : '0');

/** `<name> (p/n)`, cut to Discord's title length; the page count stays whole. */
function modalTitle(name: string, page: number, count: number): string {
  const suffix = count > 1 ? ` (${page + 1}/${count})` : '';
  if (name.length + suffix.length <= MAX_TITLE) return name + suffix;
  return `${name.slice(0, MAX_TITLE - suffix.length - 1)}…${suffix}`;
}

const choicesOf = (answer: Answer | undefined) => (answer !== undefined && 'choices' in answer ? answer.choices : []);

/** `Already uploaded: a.png, b.png. Upload again to replace.`, the names cut to fit a label description. */
function uploadedNote(names: string[]): string {
  const head = 'Already uploaded: ';
  const tail = '. Upload again to replace.';
  const room = MAX_DESCRIPTION - head.length - tail.length;
  const list = names.join(', ');
  return head + (list.length <= room ? list : `${list.slice(0, room - 1)}…`) + tail;
}

function fieldLabel(field: Field, draft: Draft | null): LabelBuilder {
  const label = new LabelBuilder().setLabel(field.label);
  if (field.description !== undefined) label.setDescription(field.description);
  const answer = draft?.answers[field.id];
  const chosen = choicesOf(answer);
  switch (field.type) {
    case 'short':
    case 'long': {
      const input = new TextInputBuilder()
        .setCustomId(field.id)
        .setStyle(field.type === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
        .setRequired(field.required)
        .setMaxLength(field.maxLength ?? MAX_TEXT);
      if (field.minLength !== undefined) input.setMinLength(field.minLength);
      if (field.placeholder !== undefined) input.setPlaceholder(field.placeholder);
      const value = answer !== undefined && 'text' in answer ? answer.text : '';
      const limit = field.maxLength ?? MAX_TEXT;
      // A longer earlier answer isn't cut: the member shortens it themself.
      if (value.length > limit) label.setDescription(`Your earlier answer was longer than the new limit of ${limit} characters. Shorten it.`);
      else if (value !== '') input.setValue(value);
      return label.setTextInputComponent(input);
    }
    case 'select': {
      const most = field.maxChoices ?? 1;
      const select = new StringSelectMenuBuilder()
        .setCustomId(field.id)
        .setRequired(field.required)
        .setMinValues(field.required ? Math.max(1, field.minChoices ?? 1) : (field.minChoices ?? 0))
        .setMaxValues(most)
        .addOptions(field.options.map((option) => ({ label: option, value: option, default: chosen.includes(option) })));
      return label.setStringSelectMenuComponent(select);
    }
    case 'radio':
      return label.setRadioGroupComponent(
        new RadioGroupBuilder()
          .setCustomId(field.id)
          .setRequired(field.required)
          .addOptions(field.options.map((option) => ({ label: option, value: option, default: chosen.includes(option) }))),
      );
    case 'checkboxes':
      if (field.options.length === 1) {
        return label.setCheckboxComponent(new CheckboxBuilder().setCustomId(field.id).setDefault(chosen.length > 0));
      }
      return label.setCheckboxGroupComponent(
        new CheckboxGroupBuilder()
          .setCustomId(field.id)
          .setRequired(field.required)
          .setMinValues(field.minChoices ?? (field.required ? 1 : 0))
          .setMaxValues(field.maxChoices ?? field.options.length)
          .addOptions(field.options.map((option) => ({ label: option, value: option, default: chosen.includes(option) }))),
      );
    case 'file': {
      // Files uploaded before stay unless new ones are uploaded, so the input is optional then.
      const uploaded = (draft?.files ?? []).filter((file) => file.fieldId === field.id).map((file) => file.name);
      const required = field.required && uploaded.length === 0;
      if (uploaded.length > 0) label.setDescription(uploadedNote(uploaded));
      const upload = new FileUploadBuilder(field.fileTypes.length > 0 ? { file_types: field.fileTypes as never } : {})
        .setCustomId(field.id)
        .setRequired(required)
        .setMinValues(required ? 1 : 0)
        .setMaxValues(field.maxFiles);
      return label.setFileUploadComponent(upload);
    }
  }
}

/**
 * The modal of one page of the form, filled in from the draft. Its custom ID carries when it was shown, so that a
 * repeated submit of the same modal is recognised.
 */
export function pageModal(ctx: FormsContext, form: Form, page: number, draft: Draft | null, dry: boolean): ModalBuilder {
  const all = pages(form.fields);
  return new ModalBuilder()
    .setCustomId(ctx.customId(pageSubmit, [form.id, String(page), flag(dry), Date.now().toString(36)]))
    .setTitle(modalTitle(form.name, page, all.length))
    .addLabelComponents((all[page] ?? []).map((field) => fieldLabel(field, draft)));
}

/** The page a draft continues with; past the last page (a refused final submit) it is the last page again. */
const currentPage = (form: Form, draft: Draft | null) => Math.min(draft?.page ?? 0, Math.max(pages(form.fields).length - 1, 0));

/** The draft unless it expired; an expired one is deleted with its files. */
async function liveDraft(ctx: FormsContext, formId: string, userId: string, dry: boolean): Promise<Draft | null> {
  const draft = await loadDraft(ctx, formId, userId, dry);
  if (draft === null || !isExpired(draft)) return draft;
  await deleteDraft(ctx, formId, userId, dry);
  return null;
}

/** Starts filling in the form behind an opener button, or continues the member's draft. */
export async function openForm(ctx: ButtonContext, openerId: string): Promise<void> {
  const [row] = await ctx.db.run(async (tx) =>
    tx
      .select({ form: forms })
      .from(openers)
      .innerJoin(forms, eq(openers.formId, forms.id))
      .where(eq(openers.id, openerId)),
  );
  if (row === undefined) throw new UserError('This form no longer exists.');
  const { form } = row;
  const userId = ctx.actorId!;
  const refused = await refusal(ctx, form, userId);
  if (refused !== null) {
    await ctx.reply(refused);
    return;
  }
  const draft = await loadDraft(ctx, form.id, userId, false);
  if (draft !== null && isExpired(draft)) {
    // The modal goes first: Discord allows three seconds to show it. The queue keeps the cleanup ahead of the submit.
    await ctx.showModal(pageModal(ctx, form, 0, null, false));
    await queued(ctx, form.id, userId, (task) => liveDraft(task, form.id, userId, false));
    return;
  }
  await ctx.showModal(pageModal(ctx, form, currentPage(form, draft), draft, false));
}

/** The preview's Try it button: fills in the form without posting; earlier trial answers are dropped. */
export async function openTrial(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  if (form.fields.length === 0) throw new UserError('This form has no fields yet.');
  const userId = ctx.actorId!;
  await ctx.showModal(pageModal(ctx, form, 0, null, true));
  await queued(ctx, form.id, userId, (task) => deleteDraft(task, form.id, userId, true));
}

function buttonRow(...buttons: ButtonBuilder[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

const continueTo = (ctx: FormsContext, formId: string, dry: boolean, label: string) =>
  new ButtonBuilder().setCustomId(ctx.customId(continueButton, [formId, flag(dry)])).setLabel(label).setStyle(ButtonStyle.Primary);

const cancel = (ctx: FormsContext, formId: string, dry: boolean) =>
  new ButtonBuilder().setCustomId(ctx.customId(cancelButton, [formId, flag(dry)])).setLabel('Cancel').setStyle(ButtonStyle.Secondary);

/** `Page p of n saved.` with Continue and Cancel; `next` is the index of the page that follows. */
function savedReply(ctx: FormsContext, formId: string, dry: boolean, next: number, count: number): ReplyMessage {
  return {
    content: `Page ${next} of ${count} saved.`,
    components: [buttonRow(continueTo(ctx, formId, dry, `Continue (${next + 1}/${count})`), cancel(ctx, formId, dry))],
  };
}

/** A refusal that keeps what was typed; Try again shows the page again. */
const retryReply = (ctx: FormsContext, formId: string, dry: boolean, message: string): ReplyMessage => ({
  content: message,
  components: [buttonRow(continueTo(ctx, formId, dry, 'Try again'), cancel(ctx, formId, dry))],
});

/** A refusal that leaves the draft as it is; Cancel deletes it. */
const cancelReply = (ctx: FormsContext, formId: string, message: string): ReplyMessage => ({
  content: message,
  components: [buttonRow(cancel(ctx, formId, false))],
});

interface PageInput {
  answers: Record<string, Answer>;
  uploads: Map<string, Attachment[]>;
  /** Fields of the page the modal didn't have: the form changed since it was shown. */
  missing: Field[];
}

function readPage(ctx: ModalContext, fields: Field[]): PageInput {
  const { fields: values } = ctx.interaction;
  const input: PageInput = { answers: {}, uploads: new Map(), missing: [] };
  const known = (field: { options: string[] }, chosen: readonly string[]) => chosen.filter((value) => field.options.includes(value));
  for (const field of fields) {
    try {
      switch (field.type) {
        case 'short':
        case 'long':
          input.answers[field.id] = { text: values.getTextInputValue(field.id) };
          break;
        case 'select':
          input.answers[field.id] = { choices: known(field, values.getStringSelectValues(field.id)) };
          break;
        case 'radio': {
          const value = values.getRadioGroup(field.id);
          input.answers[field.id] = { choices: value === null ? [] : known(field, [value]) };
          break;
        }
        case 'checkboxes':
          input.answers[field.id] = {
            choices: field.options.length === 1 ? (values.getCheckbox(field.id) ? [field.options[0]!] : []) : known(field, values.getCheckboxGroup(field.id)),
          };
          break;
        case 'file':
          input.uploads.set(field.id, [...(values.getUploadedFiles(field.id)?.values() ?? [])]);
          break;
      }
    } catch {
      input.missing.push(field);
    }
  }
  return input;
}

/** Whether the file matches one of the field's types: `image`, `video`, `audio` or an extension. */
function accepts(field: Extract<Field, { type: 'file' }>, file: Attachment): boolean {
  if (field.fileTypes.length === 0) return true;
  const name = file.name.toLowerCase();
  const kind = file.contentType?.split('/')[0];
  return field.fileTypes.some((type) => (type.startsWith('.') ? name.endsWith(type.toLowerCase()) : kind === type));
}

/** Saves typed answers without moving to the next page; files are kept as they were. */
async function keepTyped(ctx: FormsContext, formId: string, userId: string, dry: boolean, page: number, answers: Record<string, Answer>): Promise<void> {
  await ctx.db.run(async (tx) => {
    const [row] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, dry)))
      .for('update');
    const merged = { ...row?.answers, ...answers };
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    await tx
      .insert(drafts)
      .values({ formId, userId, dry, page, answers: merged, files: [], expiresAt })
      .onConflictDoUpdate({ target: [drafts.formId, drafts.userId, drafts.dry], set: { answers: merged, expiresAt } });
  });
}

/** The first required field without an answer, if any. */
function unanswered(form: Form, draft: Draft): number {
  return form.fields.findIndex((field) => {
    if (!field.required) return false;
    const answer = draft.answers[field.id];
    if (answer === undefined) return true;
    if ('text' in answer) return answer.text.trim() === '';
    if ('choices' in answer) return answer.choices.length === 0;
    return answer.files.length === 0;
  });
}

/** Part 1 of the submission as it would be posted; file fields list their files by name. */
async function trialReply(ctx: FormsContext, form: Form, draft: Draft, limit: number): Promise<Reply> {
  const fields = form.fields.map((field) => (field.type === 'file' ? ({ ...field, type: 'long' } as unknown as Field) : field));
  const answers: Record<string, Answer> = { ...draft.answers };
  for (const field of form.fields) {
    if (field.type !== 'file') continue;
    const names = draft.files.filter((file) => file.fieldId === field.id).map((file) => `• ${file.name}`);
    answers[field.id] = { text: names.join('\n') };
  }
  const { username, avatarUrl } = await submitterOf(ctx, draft.userId);
  const parts = renderSubmission({
    formName: form.name,
    userId: draft.userId,
    username,
    avatarUrl,
    submittedAt: new Date(),
    pingUserIds: form.pingUserIds,
    pingRoleIds: form.pingRoleIds,
    fields,
    answers,
    files: [],
    uploadLimit: limit,
    answersApart: form.answersApart,
  });
  await deleteDraft(ctx, form.id, draft.userId, true);
  return { components: parts[0]!.components, flags: MessageFlags.IsComponentsV2 };
}

interface PageSubmit {
  formId: string;
  page: number;
  dry: boolean;
  userId: string;
  limit: number;
  /** When the modal was shown. */
  openedAt: Date;
  read: (fields: Field[]) => PageInput;
}

/** Saves one page and moves on: the next page, the submission, or the trial preview. Runs in the member's queue. */
async function savePage(ctx: FormsContext, input: PageSubmit): Promise<Reply> {
  const { formId, page, dry, userId, limit } = input;
  const form = await formById(ctx, formId);
  const all = pages(form.fields);
  if (all.length === 0) return 'This form has no fields yet.';
  if (!dry) {
    // Checked before any file work: the files of a submission being posted stay as they are.
    const stuck = await postingRefusal(ctx, form, userId);
    if (stuck !== null) return stuck;
    if (form.oncePerMember && (await hasSubmitted(ctx, formId, userId))) return cancelReply(ctx, formId, 'You already submitted this form.');
    // A repeated submit of a last page that was already submitted.
    if (page === all.length - 1 && (await hasSubmitted(ctx, formId, userId, input.openedAt))) return 'You already submitted this form.';
  }
  const draft = await liveDraft(ctx, formId, userId, dry);
  const current = currentPage(form, draft);
  if (page < current) return savedReply(ctx, formId, dry, current, all.length);
  if (page > current) {
    if (!dry && (await hasSubmitted(ctx, formId, userId, new Date(Date.now() - DRAFT_TTL_MS)))) return 'You already submitted this form.';
    return EXPIRED;
  }

  const fields = all[page]!;
  const { answers, uploads, missing } = input.read(fields);
  const refuse = async (message: string) => {
    await keepTyped(ctx, formId, userId, dry, page, answers);
    return retryReply(ctx, formId, dry, message);
  };
  if (missing.length > 0) return refuse(CHANGED);
  for (const field of fields) {
    if (field.type === 'checkboxes' && field.required && field.options.length === 1 && choicesOf(answers[field.id]).length === 0) {
      return refuse(`**${field.label}** needs an answer.`);
    }
  }
  const keep = 'Press Try again to upload the files again; your other answers are kept.';
  const fresh: NewFile[] = [];
  for (const field of fields) {
    if (field.type !== 'file') continue;
    for (const file of uploads.get(field.id) ?? []) {
      if (file.size > limit) return refuse(`${tooLarge(file.name, limit)} ${keep}`);
      if (!accepts(field, file)) return refuse(`${file.name} isn't a file type ${field.label} accepts (${field.fileTypes.join(', ')}). ${keep}`);
    }
  }
  for (const field of fields) {
    if (field.type !== 'file') continue;
    for (const file of uploads.get(field.id) ?? []) {
      try {
        fresh.push({ fieldId: field.id, name: file.name, size: file.size, contentType: file.contentType, data: await downloadFile(file.url, limit) });
      } catch (error) {
        ctx.log.warn({ err: error, formId }, 'Downloading an uploaded file failed');
        return refuse(`I couldn't download ${file.name}. ${keep}`);
      }
    }
  }

  let stored: DraftFile[];
  try {
    stored = await storeFiles(ctx, fresh, limit);
  } catch (error) {
    ctx.log.warn({ err: error, formId }, 'Storing uploaded files failed');
    return refuse(`I couldn't store your files. ${keep}`);
  }
  const pageFiles = new Set(fields.filter((field) => field.type === 'file').map((field) => field.id));
  // A file field submitted empty keeps the files uploaded to it before; new uploads replace them.
  const uploaded = new Set([...pageFiles].filter((id) => (uploads.get(id)?.length ?? 0) > 0));
  const save = ctx.db.run(async (tx) => {
    const [row] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, dry)))
      .for('update');
    // The sweep took the draft meanwhile: the earlier pages are gone.
    if (page > 0 && row === undefined) return null;
    const replaced = (row?.files ?? []).filter((file) => uploaded.has(file.fieldId));
    const files = [...(row?.files ?? []).filter((file) => !uploaded.has(file.fieldId)), ...stored];
    const merged: Record<string, Answer> = { ...row?.answers, ...answers };
    for (const id of pageFiles) merged[id] = { files: files.filter((file) => file.fieldId === id).map((file) => file.key) };
    const values = { page: page + 1, answers: merged, files, expiresAt: new Date(Date.now() + DRAFT_TTL_MS) };
    const [draftRow] = await tx
      .insert(drafts)
      .values({ formId, userId, dry, ...values })
      .onConflictDoUpdate({ target: [drafts.formId, drafts.userId, drafts.dry], set: values })
      .returning();
    return { draft: draftRow!, replaced };
  });
  let saved: Awaited<typeof save>;
  try {
    saved = await save;
  } catch (error) {
    await releaseFiles(ctx, stored, []);
    throw error;
  }
  if (saved === null) {
    await releaseFiles(ctx, stored, []);
    return EXPIRED;
  }
  await releaseFiles(ctx, saved.replaced, saved.draft.files);

  if (page + 1 < all.length) return savedReply(ctx, formId, dry, page + 1, all.length);
  if (dry) return trialReply(ctx, form, saved.draft, limit);
  const gap = unanswered(form, saved.draft);
  if (gap >= 0) {
    const target = Math.floor(gap / PAGE_SIZE);
    await ctx.db.run(async (tx) => {
      await tx
        .update(drafts)
        .set({ page: target })
        .where(and(eq(drafts.formId, formId), eq(drafts.userId, userId), eq(drafts.dry, false)));
    });
    return retryReply(ctx, formId, false, `**${form.fields[gap]!.label}** needs an answer; the form changed after you filled in that page.`);
  }
  return submit(ctx, formId, userId, limit, input.openedAt, (message, retry) => (retry ? retryReply(ctx, formId, false, message) : cancelReply(ctx, formId, message)));
}

/** A page of the form submitted: `[formId, page, dry, shown]`, `shown` being when the modal was shown (base36 ms). */
export const pageSubmit = defineModal({
  name: 'fill-page',
  ephemeral: true,
  execute: async (ctx, args) => {
    const formId = args[0] ?? '';
    const userId = ctx.actorId!;
    const reply = await queued(ctx, formId, userId, (task) =>
      savePage(task, {
        formId,
        page: Number(args[1]),
        dry: args[2] === '1',
        userId,
        limit: ctx.interaction.attachmentSizeLimit,
        openedAt: new Date(Number.parseInt(args[3] ?? '0', 36)),
        read: (fields) => readPage(ctx, fields),
      }),
    );
    await ctx.reply(reply);
  },
});

/** Shows the page the member's draft continues with: `[formId, dry]`. */
export const continueButton = defineButton({
  name: 'fill-continue',
  bind: { user: true },
  ephemeral: true,
  execute: async (ctx, args) => {
    const form = await formById(ctx, args[0] ?? '');
    const dry = args[1] === '1';
    const draft = await loadDraft(ctx, form.id, ctx.actorId!, dry);
    if (draft === null || isExpired(draft)) throw new UserError(EXPIRED);
    await ctx.showModal(pageModal(ctx, form, currentPage(form, draft), draft, dry));
  },
});

/** Deletes the member's draft and its files: `[formId, dry]`. */
export const cancelButton = defineButton({
  name: 'fill-cancel',
  bind: { user: true },
  ephemeral: true,
  defer: 'update',
  execute: async (ctx, args) => {
    const formId = args[0] ?? '';
    const userId = ctx.actorId!;
    await queued(ctx, formId, userId, (task) => deleteDraft(task, formId, userId, args[1] === '1'));
    await ctx.update({ content: 'Cancelled. Your answers and files were deleted.', components: [] });
  },
});

export const fillComponents = [pageSubmit, continueButton, cancelButton];
