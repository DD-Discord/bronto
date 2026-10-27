import { CheckboxBuilder, LabelBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { fieldSchema, type Field, type FieldType } from './model.js';

export const FIELD_TYPE_NAMES: Record<FieldType, string> = {
  short: 'Short text',
  long: 'Long text',
  select: 'Select menu',
  radio: 'Radio buttons',
  checkboxes: 'Checkboxes',
  file: 'File upload',
};

export const FIELD_TYPES = Object.keys(FIELD_TYPE_NAMES) as FieldType[];

/** What the field modal holds, as typed. */
export interface FieldInput {
  label: string;
  description: string;
  options: string;
  position: string;
  required: boolean;
}

const MAX_LABEL = 45;
const MAX_DESCRIPTION = 100;
const MAX_OPTIONS_TEXT = 4000;
const MAX_FILES = 10;
const MAX_FILE_TYPES = 10;
const MAX_PLACEHOLDER = 100;
const MAX_TEXT = 4000;
const CHOICE_COUNTS: Record<'select' | 'radio' | 'checkboxes', [number, number]> = { select: [1, 25], radio: [2, 10], checkboxes: [1, 10] };
const FILE_TYPE = /^(?:image|video|audio|\.[A-Za-z0-9]{1,15})$/i;

/** Wrong input; the message names the problem. */
export class FieldInputError extends Error {}

const OPTIONS_HELP: Record<'select' | 'radio' | 'checkboxes', string> = {
  select: 'One option per line (1 to 25).',
  radio: 'One option per line (2 to 10).',
  checkboxes: 'One option per line (1 to 10).',
};

type ChoiceType = keyof typeof OPTIONS_HELP;
const isChoice = (type: FieldType): type is ChoiceType => type === 'select' || type === 'radio' || type === 'checkboxes';

/** The text of the options input of a stored choice field; other types have none. */
function optionsText(field: Field | null): string {
  return field !== null && 'options' in field ? field.options.join('\n') : '';
}

/** The modal's values for a stored field, or for a new one of `type`. */
export function inputOf(field: Field | null, position: number | null): FieldInput {
  return {
    label: field?.label ?? '',
    description: field?.description ?? '',
    options: optionsText(field),
    position: position === null ? '' : String(position),
    required: field?.required ?? false,
  };
}

const textInput = (id: string, style: TextInputStyle, required: boolean, max: number, value: string) => {
  const builder = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
  return value === '' ? builder : builder.setValue(value);
};

const short = (id: string, label: string, required: boolean, max: number, value: string, placeholder?: string, description?: string) => {
  const input = textInput(id, TextInputStyle.Short, required, max, value);
  if (placeholder !== undefined) input.setPlaceholder(placeholder);
  const wrapper = new LabelBuilder().setLabel(label).setTextInputComponent(input);
  return description === undefined ? wrapper : wrapper.setDescription(description);
};

/** The field modal: label, description, required, position, and the options of a choice type. `input` fills them. */
export function fieldModal(customId: string, type: FieldType, editing: boolean, input: FieldInput): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`${editing ? 'Edit' : 'Add'} ${FIELD_TYPE_NAMES[type].toLowerCase()} field`)
    .addLabelComponents(
      short('label', 'Label', true, MAX_LABEL, input.label),
      short('description', 'Description', false, MAX_DESCRIPTION, input.description),
      new LabelBuilder().setLabel('Required').setCheckboxComponent(new CheckboxBuilder().setCustomId('required').setDefault(input.required)),
      short('position', 'Position', false, 4, input.position, '1, 2, 3… or end', editing ? 'Blank keeps the position.' : 'Blank adds the field at the end.'),
    );
  if (isChoice(type)) {
    modal.addLabelComponents(
      new LabelBuilder()
        .setLabel('Options')
        .setDescription(OPTIONS_HELP[type])
        .setTextInputComponent(textInput('options', TextInputStyle.Paragraph, true, MAX_OPTIONS_TEXT, input.options).setPlaceholder('First option\nSecond option')),
    );
  }
  return modal;
}

/** What a type-specific pop-up holds, as typed. */
export type LimitsInput =
  | { kind: 'text'; placeholder: string; minLength: string; maxLength: string }
  | { kind: 'choice'; minChoices: string; maxChoices: string }
  | { kind: 'file'; maxFiles: string; fileTypes: string };

export const LIMITS_BUTTON: Record<LimitsInput['kind'], string> = { text: 'Text limits', choice: 'Choice limits', file: 'File settings' };

/** Which type-specific pop-up a field type has; radio fields have none. */
export function limitsKindOf(type: FieldType): LimitsInput['kind'] | null {
  if (type === 'short' || type === 'long') return 'text';
  if (type === 'select' || type === 'checkboxes') return 'choice';
  return type === 'file' ? 'file' : null;
}

const numberText = (value: number | undefined) => (value === undefined ? '' : String(value));

/** The type-specific pop-up's values for a stored field, or null when its type has none. */
export function limitsInputOf(field: Field): LimitsInput | null {
  switch (field.type) {
    case 'short':
    case 'long':
      return { kind: 'text', placeholder: field.placeholder ?? '', minLength: numberText(field.minLength), maxLength: numberText(field.maxLength) };
    case 'select':
    case 'checkboxes':
      return { kind: 'choice', minChoices: numberText(field.minChoices), maxChoices: numberText(field.maxChoices) };
    case 'file':
      return { kind: 'file', maxFiles: String(field.maxFiles), fileTypes: field.fileTypes.join(', ') };
    default:
      return null;
  }
}

/** The type-specific pop-up, one input per value, filled with `input`. */
export function limitsModal(customId: string, input: LimitsInput): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(LIMITS_BUTTON[input.kind]);
  switch (input.kind) {
    case 'text':
      return modal.addLabelComponents(
        short('placeholder', 'Placeholder', false, MAX_PLACEHOLDER, input.placeholder, undefined, 'Shown inside the empty box.'),
        short('minLength', 'Min length', false, 4, input.minLength, undefined, 'Blank for no minimum.'),
        short('maxLength', 'Max length', false, 4, input.maxLength, undefined, `Blank for no maximum, up to ${MAX_TEXT}.`),
      );
    case 'choice':
      return modal.addLabelComponents(
        short('minChoices', 'Min choices', false, 2, input.minChoices, undefined, 'Blank for the default.'),
        short('maxChoices', 'Max choices', false, 2, input.maxChoices, undefined, 'Blank for the default.'),
      );
    case 'file':
      return modal.addLabelComponents(
        short('maxFiles', 'Max files', true, 2, input.maxFiles, `1 to ${MAX_FILES}`),
        short('fileTypes', 'File types', false, 200, input.fileTypes, 'image, video, .txt, .md', 'Comma separated. Blank allows any type.'),
      );
  }
}

/** Lines of the options input, trimmed; blank ones stay so that line numbers match what the member sees. */
const linesOf = (text: string) => text.split(/\r?\n/).map((line) => line.trim());

function parseChoices(type: ChoiceType, lines: string[]): string[] {
  const options: string[] = [];
  lines.forEach((line, index) => {
    if (line === '') return;
    if (line.length > 100) throw new FieldInputError(`Options line ${index + 1}: an option can have at most 100 characters.`);
    if (options.includes(line)) throw new FieldInputError(`Options line ${index + 1}: "${line}" is listed twice.`);
    options.push(line);
  });
  const [min, max] = CHOICE_COUNTS[type];
  if (options.length < min || options.length > max) {
    throw new FieldInputError(`${FIELD_TYPE_NAMES[type]} fields need ${min === max ? min : `${min} to ${max}`} options, one per line; there are ${options.length}.`);
  }
  return options;
}

/** A whole number from `min` to `max`, or undefined when blank; `name` is the input in the message. */
function parseWhole(text: string, name: string, min: number, max: number): number | undefined {
  const value = text.trim();
  if (value === '') return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new FieldInputError(`${name}: write a whole number from ${min} to ${max}, or leave it blank.`);
  }
  return Number(value);
}

/** The target index for a position input; null keeps the field where it is (a new one goes last). */
export function parsePosition(text: string, count: number): number | null {
  const value = text.trim().toLowerCase();
  if (value === '' || value === 'end') return null;
  const position = Number(value);
  if (!/^\d+$/.test(value) || position < 1 || position > count) {
    throw new FieldInputError(`Position must be a number from 1 to ${count}, or blank.`);
  }
  return position - 1;
}

function checkedField(candidate: Record<string, unknown>): Field {
  const parsed = fieldSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new FieldInputError(`${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}.`);
  }
  return parsed.data;
}

/**
 * The field the input describes. `previous` lends the type-specific values the field modal has no input for (limits,
 * placeholder, file settings), as far as they still fit the options; a new field gets the defaults.
 */
export function buildField(type: FieldType, input: FieldInput, id: string, previous: Field | null): Field {
  const label = input.label.trim();
  if (label === '') throw new FieldInputError("The label can't be empty.");
  const description = input.description.trim();
  const candidate: Record<string, unknown> = {
    id,
    type,
    label,
    required: input.required,
    ...(description === '' ? {} : { description }),
  };
  const same = previous !== null && previous.type === type ? previous : null;
  if (type === 'short' || type === 'long') {
    if (same !== null && (same.type === 'short' || same.type === 'long')) {
      const { placeholder, minLength, maxLength } = same;
      Object.assign(candidate, { ...(placeholder === undefined ? {} : { placeholder }), ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }) });
    }
  } else if (type === 'file') {
    const kept = same !== null && same.type === 'file' ? same : null;
    Object.assign(candidate, { maxFiles: kept?.maxFiles ?? 1, fileTypes: kept?.fileTypes ?? [] });
  } else {
    const options = parseChoices(type, linesOf(input.options));
    candidate.options = options;
    if (same !== null && (same.type === 'select' || same.type === 'checkboxes')) {
      const { minChoices, maxChoices } = same;
      if (maxChoices !== undefined && maxChoices <= options.length) candidate.maxChoices = maxChoices;
      if (minChoices !== undefined && minChoices <= ((candidate.maxChoices as number | undefined) ?? options.length)) candidate.minChoices = minChoices;
    }
  }
  return checkedField(candidate);
}

/** The field with the type-specific values `input` describes; blank limits are removed. */
export function applyLimits(field: Field, input: LimitsInput): Field {
  const candidate: Record<string, unknown> = { ...field };
  const set = (key: string, value: unknown) => {
    if (value === undefined) delete candidate[key];
    else candidate[key] = value;
  };
  if (input.kind === 'text' && (field.type === 'short' || field.type === 'long')) {
    const placeholder = input.placeholder.trim();
    if (placeholder.length > MAX_PLACEHOLDER) throw new FieldInputError(`Placeholder: use at most ${MAX_PLACEHOLDER} characters.`);
    const minLength = parseWhole(input.minLength, 'Min length', 0, MAX_TEXT);
    const maxLength = parseWhole(input.maxLength, 'Max length', 1, MAX_TEXT);
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new FieldInputError("Min length can't be more than Max length.");
    set('placeholder', placeholder === '' ? undefined : placeholder);
    set('minLength', minLength);
    set('maxLength', maxLength);
  } else if (input.kind === 'choice' && (field.type === 'select' || field.type === 'checkboxes')) {
    const count = field.options.length;
    const minChoices = parseWhole(input.minChoices, 'Min choices', 0, count);
    const maxChoices = parseWhole(input.maxChoices, 'Max choices', 1, count);
    if (minChoices !== undefined && maxChoices !== undefined && minChoices > maxChoices) throw new FieldInputError("Min choices can't be more than Max choices.");
    set('minChoices', minChoices);
    set('maxChoices', maxChoices);
  } else if (input.kind === 'file' && field.type === 'file') {
    const maxFiles = parseWhole(input.maxFiles, 'Max files', 1, MAX_FILES);
    if (maxFiles === undefined) throw new FieldInputError(`Max files: write a whole number from 1 to ${MAX_FILES}.`);
    const fileTypes = input.fileTypes
      .split(',')
      .map((type) => type.trim())
      .filter((type) => type !== '');
    for (const type of fileTypes) {
      if (!FILE_TYPE.test(type)) throw new FieldInputError(`File types: "${type}" is not image, video, audio or an extension like .pdf.`);
    }
    if (fileTypes.length > MAX_FILE_TYPES) throw new FieldInputError(`File types: list at most ${MAX_FILE_TYPES}.`);
    set('maxFiles', maxFiles);
    set('fileTypes', fileTypes.map((type) => (type.startsWith('.') ? type : type.toLowerCase())));
  } else {
    throw new FieldInputError("That field doesn't have these settings.");
  }
  return checkedField(candidate);
}

const MAX_SUMMARY_OPTIONS = 1200;

/** The detail view's text: the field and all its settings. */
export function fieldSummary(field: Field, index: number): string {
  const lines = [`**${index + 1}. ${field.label}** · ${FIELD_TYPE_NAMES[field.type].toLowerCase()} · ${field.required ? 'required' : 'optional'}`];
  if (field.description !== undefined) lines.push(`Description: ${field.description}`);
  const none = (value: number | undefined, other: string) => (value === undefined ? other : String(value));
  switch (field.type) {
    case 'short':
    case 'long':
      lines.push(`Placeholder: ${field.placeholder ?? 'none'}`, `Min length: ${none(field.minLength, 'none')}`, `Max length: ${none(field.maxLength, 'none')}`);
      break;
    case 'select':
    case 'checkboxes':
      lines.push(`Min choices: ${none(field.minChoices, 'default')}`, `Max choices: ${none(field.maxChoices, 'default')}`);
      break;
    case 'file':
      lines.push(`Max files: ${field.maxFiles}`, `File types: ${field.fileTypes.length === 0 ? 'any' : field.fileTypes.join(', ')}`);
      break;
  }
  if ('options' in field) {
    const joined = field.options.map((option) => `- ${option}`).join('\n');
    lines.push(`Options:\n${joined.length <= MAX_SUMMARY_OPTIONS ? joined : `${joined.slice(0, MAX_SUMMARY_OPTIONS - 1)}…`}`);
  }
  return lines.join('\n');
}
