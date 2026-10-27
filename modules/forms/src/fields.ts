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
const CHOICE_COUNTS: Record<'select' | 'radio' | 'checkboxes', [number, number]> = { select: [1, 25], radio: [2, 10], checkboxes: [1, 10] };
const LENGTH_RANGE = /^(\d*)-(\d*)$/;
const FILE_TYPE = /^(?:image|video|audio|\.[A-Za-z0-9]{1,15})$/i;

/** Wrong input; the message names the problem. */
export class FieldInputError extends Error {}

const OPTIONS_HELP: Record<FieldType, { description: string; placeholder: string }> = {
  short: { description: 'Line 1: length as min-max. Line 2: placeholder.', placeholder: '5-200\nShown inside the empty box' },
  long: { description: 'Line 1: length as min-max. Line 2: placeholder.', placeholder: '50-2000\nShown inside the empty box' },
  select: { description: 'One option per line (1 to 25).', placeholder: 'First option\nSecond option' },
  radio: { description: 'One option per line (2 to 10).', placeholder: 'First option\nSecond option' },
  checkboxes: { description: 'One option per line (1 to 10).', placeholder: 'First option\nSecond option' },
  file: { description: 'Line 1: most files (1-10). Line 2: types, like image, .pdf', placeholder: '3\nimage, .pdf' },
};

function optionsText(field: Field | null, type: FieldType): string {
  if (field === null) return type === 'file' ? '1' : '';
  switch (field.type) {
    case 'short':
    case 'long': {
      const range = field.minLength === undefined && field.maxLength === undefined ? '' : `${field.minLength ?? ''}-${field.maxLength ?? ''}`;
      return field.placeholder === undefined ? range : `${range}\n${field.placeholder}`;
    }
    case 'file':
      return `${field.maxFiles}\n${field.fileTypes.join(', ')}`;
    default:
      return field.options.join('\n');
  }
}

/** The modal's values for a stored field, or for a new one of `type`. */
export function inputOf(field: Field | null, type: FieldType, position: number | null): FieldInput {
  return {
    label: field?.label ?? '',
    description: field?.description ?? '',
    options: optionsText(field, type),
    position: position === null ? '' : String(position),
    required: field?.required ?? false,
  };
}

/** The five inputs of the field modal; `input` fills them. */
export function fieldModal(customId: string, type: FieldType, editing: boolean, input: FieldInput): ModalBuilder {
  const help = OPTIONS_HELP[type];
  const text = (id: string, style: TextInputStyle, required: boolean, max: number, value: string) => {
    const builder = new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(max);
    return value === '' ? builder : builder.setValue(value);
  };
  const choices = type === 'select' || type === 'radio' || type === 'checkboxes';
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`${editing ? 'Edit' : 'Add'} ${FIELD_TYPE_NAMES[type].toLowerCase()} field`)
    .addLabelComponents(
      new LabelBuilder().setLabel('Label').setTextInputComponent(text('label', TextInputStyle.Short, true, MAX_LABEL, input.label)),
      new LabelBuilder()
        .setLabel('Description')
        .setTextInputComponent(text('description', TextInputStyle.Short, false, MAX_DESCRIPTION, input.description)),
      new LabelBuilder()
        .setLabel('Options')
        .setDescription(help.description)
        .setTextInputComponent(text('options', TextInputStyle.Paragraph, choices, MAX_OPTIONS_TEXT, input.options).setPlaceholder(help.placeholder)),
      new LabelBuilder().setLabel('Required').setCheckboxComponent(new CheckboxBuilder().setCustomId('required').setDefault(input.required)),
      new LabelBuilder()
        .setLabel('Position')
        .setDescription(editing ? 'Blank keeps the position.' : 'Blank adds the field at the end.')
        .setTextInputComponent(text('position', TextInputStyle.Short, false, 4, input.position).setPlaceholder('1, 2, 3… or end')),
    );
}

/** Lines of the options input, trimmed; blank ones stay so that line numbers match what the member sees. */
const linesOf = (text: string) => text.split(/\r?\n/).map((line) => line.trim());

function parseText(lines: string[]): { minLength?: number; maxLength?: number; placeholder?: string } {
  const [range = '', placeholder = '', ...extra] = lines;
  if (extra.some((line) => line !== '')) throw new FieldInputError('Options line 3: a text field uses two lines, the length and the placeholder.');
  const out: { minLength?: number; maxLength?: number; placeholder?: string } = {};
  if (range !== '') {
    const match = LENGTH_RANGE.exec(range);
    if (match === null || (match[1] === '' && match[2] === '')) {
      throw new FieldInputError('Options line 1: write the length as min-max, like 5-200. Either side may be left out.');
    }
    if (match[1] !== '') out.minLength = Number(match[1]);
    if (match[2] !== '') out.maxLength = Number(match[2]);
  }
  if (placeholder !== '') {
    if (placeholder.length > MAX_PLACEHOLDER) throw new FieldInputError(`Options line 2: the placeholder can have at most ${MAX_PLACEHOLDER} characters.`);
    out.placeholder = placeholder;
  }
  return out;
}

function parseChoices(type: 'select' | 'radio' | 'checkboxes', lines: string[]): string[] {
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

function parseFile(lines: string[]): { maxFiles: number; fileTypes: string[] } {
  const [count = '', types = '', ...extra] = lines;
  if (extra.some((line) => line !== '')) throw new FieldInputError('Options line 3: a file field uses two lines, the most files and the types.');
  let maxFiles = 1;
  if (count !== '') {
    if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > MAX_FILES) {
      throw new FieldInputError(`Options line 1: write how many files are allowed, from 1 to ${MAX_FILES}.`);
    }
    maxFiles = Number(count);
  }
  const fileTypes = types
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type !== '');
  for (const type of fileTypes) {
    if (!FILE_TYPE.test(type)) throw new FieldInputError(`Options line 2: "${type}" is not image, video, audio or an extension like .pdf.`);
  }
  if (fileTypes.length > MAX_FILE_TYPES) throw new FieldInputError(`Options line 2: list at most ${MAX_FILE_TYPES} file types.`);
  return { maxFiles, fileTypes: fileTypes.map((type) => (type.startsWith('.') ? type : type.toLowerCase())) };
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

/**
 * The field the input describes. `previous` lends the choice limits that the modal has no input for, as far as they
 * still fit the options.
 */
export function buildField(type: FieldType, input: FieldInput, id: string, previous: Field | null): Field {
  const label = input.label.trim();
  if (label === '') throw new FieldInputError("The label can't be empty.");
  const description = input.description.trim();
  const lines = linesOf(input.options);
  const candidate: Record<string, unknown> = {
    id,
    type,
    label,
    required: input.required,
    ...(description === '' ? {} : { description }),
  };
  if (type === 'short' || type === 'long') Object.assign(candidate, parseText(lines));
  else if (type === 'file') Object.assign(candidate, parseFile(lines));
  else {
    const options = parseChoices(type, lines);
    candidate.options = options;
    if (previous !== null && previous.type === type && (previous.type === 'select' || previous.type === 'checkboxes')) {
      const { minChoices, maxChoices } = previous;
      if (maxChoices !== undefined && maxChoices <= options.length) candidate.maxChoices = maxChoices;
      if (minChoices !== undefined && minChoices <= (candidate.maxChoices as number | undefined ?? options.length)) candidate.minChoices = minChoices;
    }
  }
  const parsed = fieldSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new FieldInputError(`${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}.`);
  }
  return parsed.data;
}
