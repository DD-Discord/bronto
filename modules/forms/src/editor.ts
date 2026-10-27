import { defineButton, defineModal, defineSelect, UserError, type ButtonContext, type ReplyMessage } from '@bronto/core';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ModalBuilder,
} from 'discord.js';
import type { FormsContext } from './context.js';
import type { Form } from './db/schema.js';
import {
  applyLimits,
  buildField,
  FIELD_TYPE_NAMES,
  FIELD_TYPES,
  FieldInputError,
  fieldModal,
  fieldSummary,
  inputOf,
  LIMITS_BUTTON,
  limitsInputOf,
  limitsKindOf,
  limitsModal,
  parsePosition,
  type FieldInput,
  type LimitsInput,
} from './fields.js';
import { newFieldId, type Field, type FieldType } from './model.js';
import { formById, formForThread, requireEditor } from './permissions.js';
import { editorBinding } from './binding.js';
import { registerRetry, retryReply, TryAgainError, type Draft } from './retry.js';
import { changeForm, savedMessage } from './save.js';

// A string select holds 25 options.
const PICKER_SIZE = 25;
const MAX_OPTION_TEXT = 100;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function typeArg(value: string | undefined): FieldType {
  const type = FIELD_TYPES.find((candidate) => candidate === value);
  if (type === undefined) throw new UserError('Unknown field type.');
  return type;
}

/** The field modal for a new field (`fieldId` null) or a stored one, filled with `input`. */
export function fieldModalFor(ctx: FormsContext, form: Form, type: FieldType, fieldId: string | null, input: FieldInput): ModalBuilder {
  const customId = ctx.customId(fieldModalDefinition, [form.id, type, fieldId ?? '-']);
  return fieldModal(customId, type, fieldId !== null, input);
}

function readInput(ctx: Parameters<typeof fieldModalDefinition.execute>[0], type: FieldType): FieldInput {
  return {
    label: ctx.field('label'),
    description: ctx.field('description'),
    options: type === 'select' || type === 'radio' || type === 'checkboxes' ? ctx.field('options') : '',
    position: ctx.field('position'),
    required: ctx.interaction.fields.getCheckbox('required'),
  };
}

/** Saves the field a modal describes: a new one when `fieldId` is null, otherwise the stored one with that ID. */
async function saveField(ctx: FormsContext, formId: string, type: FieldType, fieldId: string | null, input: FieldInput) {
  const draft: Draft = { kind: 'field', type, fieldId, input };
  let savedId = fieldId ?? '';
  const saved = await changeForm(ctx, formId, (form) => {
    const index = fieldId === null ? -1 : form.fields.findIndex((field) => field.id === fieldId);
    if (fieldId !== null && index < 0) throw new UserError('That field no longer exists.');
    const previous = index < 0 ? null : form.fields[index]!;
    const id = fieldId ?? newFieldId([...form.fields.map((field) => field.id), ...form.removedFieldIds]);
    savedId = id;
    let field: Field;
    let target: number | null;
    try {
      field = buildField(type, input, id, previous);
      target = parsePosition(input.position, fieldId === null ? form.fields.length + 1 : form.fields.length);
    } catch (error) {
      if (error instanceof FieldInputError) throw new TryAgainError(error.message, draft);
      throw error;
    }
    const fields = form.fields.slice();
    if (index >= 0) fields.splice(index, 1);
    fields.splice(target ?? (index >= 0 ? index : fields.length), 0, field);
    return { fields };
  });
  return { ...saved, fieldId: savedId };
}

registerRetry('field', (ctx, form, draft) => fieldModalFor(ctx, form, draft.type, draft.fieldId, draft.input));

export const fieldModalDefinition = defineModal({
  name: 'field-modal',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const formId = args[0] ?? '';
    const type = typeArg(args[1]);
    const fieldId = args[2] === undefined || args[2] === '-' ? null : args[2];
    try {
      const input = readInput(ctx, type);
      const saved = await saveField(ctx, formId, type, fieldId, input);
      const note = savedMessage(`${fieldId === null ? 'Added' : 'Saved'} "${input.label.trim()}".`, saved.postUpdated);
      await ctx.update(detailMessage(ctx, saved.form, saved.fieldId, note));
    } catch (error) {
      if (!(error instanceof TryAgainError)) throw error;
      await ctx.update(retryReply(ctx, formId, error));
    }
  },
});

/** Answers the preview's Add field button with the type select. */
export async function openAddField(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  const select = new StringSelectMenuBuilder()
    .setCustomId(ctx.customId(fieldTypeSelect, [form.id]))
    .setPlaceholder('Type of field')
    .addOptions(FIELD_TYPES.map((type) => ({ label: FIELD_TYPE_NAMES[type], value: type })));
  await ctx.reply({ content: 'What kind of field do you want to add?', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] });
}

export const fieldTypeSelect = defineSelect({
  name: 'field-type',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const type = typeArg(ctx.values[0]);
    await ctx.showModal(fieldModalFor(ctx, form, type, null, inputOf(null, null)));
  },
});

/** The field's summary with buttons to edit it, change its type-specific settings (if its type has any) and remove it. */
function detailMessage(ctx: FormsContext, form: Form, fieldId: string, note?: string): ReplyMessage {
  const index = form.fields.findIndex((field) => field.id === fieldId);
  const field = form.fields[index]!;
  const button = (definition: typeof fieldEditButton, label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(ctx.customId(definition, [form.id, field.id])).setLabel(label).setStyle(style);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button(fieldEditButton, 'Edit', ButtonStyle.Primary));
  const kind = limitsKindOf(field.type);
  if (kind !== null) row.addComponents(button(fieldLimitsButton, LIMITS_BUTTON[kind], ButtonStyle.Secondary));
  row.addComponents(button(fieldRemoveButton, 'Remove field', ButtonStyle.Danger));
  return { content: note === undefined ? fieldSummary(field, index) : `${note}\n\n${fieldSummary(field, index)}`, components: [row] };
}

function picker(ctx: FormsContext, form: Form, page: number): ReplyMessage {
  const pages = Math.max(1, Math.ceil(form.fields.length / PICKER_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const start = current * PICKER_SIZE;
  const select = new StringSelectMenuBuilder()
    .setCustomId(ctx.customId(fieldPickSelect, [form.id]))
    .setPlaceholder('Pick a field')
    .addOptions(
      form.fields.slice(start, start + PICKER_SIZE).map((field, i) => ({
        label: cut(`${start + i + 1}. ${field.label}`, MAX_OPTION_TEXT),
        value: field.id,
        description: FIELD_TYPE_NAMES[field.type],
      })),
    );
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  if (pages > 1) {
    const step = (label: string, to: number, disabled: boolean) =>
      new ButtonBuilder().setCustomId(ctx.customId(fieldPageButton, [form.id, String(to)])).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(step('‹', current - 1, current === 0), step('›', current + 1, current === pages - 1)));
  }
  return { content: `Which field do you want to change?${pages > 1 ? ` (page ${current + 1} of ${pages})` : ''}`, components };
}

/** Answers the preview's Edit field button with a select of the form's fields. */
export async function openEditField(ctx: ButtonContext): Promise<void> {
  requireEditor(ctx);
  const form = await formForThread(ctx, ctx.channelId!);
  if (form.fields.length === 0) throw new UserError('This form has no fields yet.');
  await ctx.reply(picker(ctx, form, 0));
}

export const fieldPageButton = defineButton({
  name: 'field-page',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    await ctx.update(picker(ctx, form, Number(args[1])));
  },
});

export const fieldPickSelect = defineSelect({
  name: 'field-pick',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const index = form.fields.findIndex((field) => field.id === ctx.values[0]);
    if (index < 0) throw new UserError('That field no longer exists.');
    await ctx.update(detailMessage(ctx, form, form.fields[index]!.id));
  },
});

export const fieldEditButton = defineButton({
  name: 'field-edit',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const index = form.fields.findIndex((field) => field.id === args[1]);
    if (index < 0) throw new UserError('That field no longer exists.');
    const field = form.fields[index]!;
    await ctx.showModal(fieldModalFor(ctx, form, field.type, field.id, inputOf(field, index + 1)));
  },
});

function limitsModalFor(ctx: FormsContext, form: Form, fieldId: string, input: LimitsInput): ModalBuilder {
  return limitsModal(ctx.customId(fieldLimitsModal, [form.id, fieldId]), input);
}

registerRetry('limits', (ctx, form, draft) => limitsModalFor(ctx, form, draft.fieldId, draft.input));

/** Opens the type-specific pop-up of a field: `[formId, fieldId]`. */
export const fieldLimitsButton = defineButton({
  name: 'field-limits',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const field = form.fields.find((candidate) => candidate.id === args[1]);
    if (field === undefined) throw new UserError('That field no longer exists.');
    const input = limitsInputOf(field);
    if (input === null) throw new UserError("That field doesn't have these settings.");
    await ctx.showModal(limitsModalFor(ctx, form, field.id, input));
  },
});

function readLimits(ctx: Parameters<typeof fieldLimitsModal.execute>[0], kind: LimitsInput['kind']): LimitsInput {
  switch (kind) {
    case 'text':
      return { kind, placeholder: ctx.field('placeholder'), minLength: ctx.field('minLength'), maxLength: ctx.field('maxLength') };
    case 'choice':
      return { kind, minChoices: ctx.field('minChoices'), maxChoices: ctx.field('maxChoices') };
    case 'file':
      return { kind, maxFiles: ctx.field('maxFiles'), fileTypes: ctx.field('fileTypes') };
  }
}

export const fieldLimitsModal = defineModal({
  name: 'field-limits-modal',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const formId = args[0] ?? '';
    const fieldId = args[1] ?? '';
    try {
      let input: LimitsInput | undefined;
      const saved = await changeForm(ctx, formId, (form) => {
        const index = form.fields.findIndex((field) => field.id === fieldId);
        if (index < 0) throw new UserError('That field no longer exists.');
        const field = form.fields[index]!;
        const kind = limitsKindOf(field.type);
        if (kind === null) throw new UserError("That field doesn't have these settings.");
        input = readLimits(ctx, kind);
        try {
          return { fields: form.fields.map((candidate, i) => (i === index ? applyLimits(field, input!) : candidate)) };
        } catch (error) {
          if (error instanceof FieldInputError) throw new TryAgainError(error.message, { kind: 'limits', fieldId, input: input! });
          throw error;
        }
      });
      await ctx.update(detailMessage(ctx, saved.form, fieldId, savedMessage('Saved.', saved.postUpdated)));
    } catch (error) {
      if (!(error instanceof TryAgainError)) throw error;
      await ctx.update(retryReply(ctx, formId, error));
    }
  },
});

export const fieldRemoveButton = defineButton({
  name: 'field-remove',
  ...editorBinding,
  defer: 'update',
  execute: async (ctx, args) => {
    requireEditor(ctx);
    let label = '';
    const { postUpdated } = await changeForm(ctx, args[0] ?? '', (form) => {
      const field = form.fields.find((candidate) => candidate.id === args[1]);
      if (field === undefined) throw new UserError('That field no longer exists.');
      label = field.label;
      return {
        fields: form.fields.filter((candidate) => candidate !== field),
        removedFieldIds: [...form.removedFieldIds, field.id],
      };
    });
    await ctx.update({ content: savedMessage(`Field "${label}" removed. Answers already submitted keep it.`, postUpdated), components: [] });
  },
});

export const editorComponents = [fieldModalDefinition, fieldTypeSelect, fieldPageButton, fieldPickSelect, fieldEditButton, fieldLimitsButton, fieldLimitsModal, fieldRemoveButton];
