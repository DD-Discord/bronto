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
  buildField,
  FIELD_TYPE_NAMES,
  FIELD_TYPES,
  FieldInputError,
  fieldModal,
  inputOf,
  parsePosition,
  type FieldInput,
} from './fields.js';
import { newFieldId, type Field, type FieldType } from './model.js';
import { formById, formForThread, requireEditor } from './permissions.js';
import { editorBinding, retryReply, type Draft } from './retry.js';
import { changeForm, savedMessage, TryAgainError } from './save.js';

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

function readInput(ctx: Parameters<typeof fieldModalDefinition.execute>[0]): FieldInput {
  return {
    label: ctx.field('label'),
    description: ctx.field('description'),
    options: ctx.field('options'),
    position: ctx.field('position'),
    required: ctx.interaction.fields.getCheckbox('required'),
  };
}

/** Saves the field a modal describes: a new one when `fieldId` is null, otherwise the stored one with that ID. */
async function saveField(ctx: FormsContext, formId: string, type: FieldType, fieldId: string | null, input: FieldInput) {
  const draft: Draft = { kind: 'field', type, fieldId, input };
  return changeForm(ctx, formId, (form) => {
    const index = fieldId === null ? -1 : form.fields.findIndex((field) => field.id === fieldId);
    if (fieldId !== null && index < 0) throw new UserError('That field no longer exists.');
    const previous = index < 0 ? null : form.fields[index]!;
    const id = fieldId ?? newFieldId([...form.fields.map((field) => field.id), ...form.removedFieldIds]);
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
}

export const fieldModalDefinition = defineModal({
  name: 'field-modal',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const formId = args[0] ?? '';
    const type = typeArg(args[1]);
    const fieldId = args[2] === undefined || args[2] === '-' ? null : args[2];
    try {
      const input = readInput(ctx);
      const saved = await saveField(ctx, formId, type, fieldId, input);
      await ctx.reply(savedMessage(`${fieldId === null ? 'Added' : 'Saved'} "${input.label.trim()}".`, saved.postUpdated));
    } catch (error) {
      if (!(error instanceof TryAgainError)) throw error;
      await ctx.reply(retryReply(ctx, formId, error));
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
    await ctx.showModal(fieldModalFor(ctx, form, type, null, inputOf(null, type, null)));
  },
});

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
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    await ctx.update(picker(ctx, form, Number(args[1])));
  },
});

export const fieldPickSelect = defineSelect({
  name: 'field-pick',
  ...editorBinding,
  execute: async (ctx, args) => {
    requireEditor(ctx);
    const form = await formById(ctx, args[0] ?? '');
    const index = form.fields.findIndex((field) => field.id === ctx.values[0]);
    if (index < 0) throw new UserError('That field no longer exists.');
    const field = form.fields[index]!;
    const button = (definition: typeof fieldEditButton, label: string, style: ButtonStyle) =>
      new ButtonBuilder().setCustomId(ctx.customId(definition, [form.id, field.id])).setLabel(label).setStyle(style);
    await ctx.update({
      content: `**${index + 1}. ${field.label}** · ${FIELD_TYPE_NAMES[field.type].toLowerCase()} · ${field.required ? 'required' : 'optional'}`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(fieldEditButton, 'Edit', ButtonStyle.Primary),
          button(fieldRemoveButton, 'Remove field', ButtonStyle.Danger),
        ),
      ],
    });
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
    await ctx.showModal(fieldModalFor(ctx, form, field.type, field.id, inputOf(field, field.type, index + 1)));
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

export const editorComponents = [fieldModalDefinition, fieldTypeSelect, fieldPageButton, fieldPickSelect, fieldEditButton, fieldRemoveButton];
