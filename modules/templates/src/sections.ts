import { UserError, type ModalContext } from '@bronto/core';
import {
  CheckboxBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbed,
  type APIEmbedField,
} from 'discord.js';
import type { TemplatesContext } from './context.js';
import type { ImageSlot, Template } from './db/schema.js';
import { sectionModalDefinition } from './editor.js';

export type Section = 'content' | 'body' | 'author' | 'footer' | 'images' | 'field' | 'add-field';

/** What was typed into a section's form, to fill it in again after an error. */
export interface Draft {
  values: Record<string, string>;
  checks: Record<string, boolean>;
  fieldIndex?: number;
}

/** An image uploaded through a form, not yet downloaded. */
export interface UploadedImage {
  name: string;
  url: string;
}

/** A submitted section form; a text input missing from the form keeps its part. Or the removal of the embed. */
export type SectionChange =
  | {
      section: Section;
      fieldIndex?: number;
      values: Record<string, string | undefined>;
      checks: Record<string, boolean | undefined>;
      files: Partial<Record<ImageSlot, UploadedImage>>;
    }
  | { section: 'remove-embed' };

/** Wrong input in a section form; the editor answers it with [Try again], which reopens the form with `draft`. */
export class TryAgainError extends UserError {
  constructor(
    message: string,
    readonly section: Section,
    readonly draft: Draft,
  ) {
    super(message);
  }
}

export const MAX_FIELDS = 25;
const URL_MAX = 2048;
const UPLOAD_PREFIX = 'attachment://';

interface Source {
  template: Template;
  embed: APIEmbed;
  field: APIEmbedField | undefined;
  index: number | undefined;
}

type Input =
  | { kind: 'text'; id: string; label: string; max: number; paragraph?: boolean; required?: boolean; placeholder?: string; get: (s: Source) => string | undefined }
  | { kind: 'check'; id: string; label: string; get: (s: Source) => boolean }
  | { kind: 'upload'; id: string; label: string; slot: ImageSlot };

const url = (id: string, label: string, get: (s: Source) => string | undefined): Input => ({
  kind: 'text',
  id,
  label,
  max: URL_MAX,
  placeholder: 'https://…',
  get,
});
const upload = (id: string, label: string, slot: ImageSlot): Input => ({ kind: 'upload', id, label, slot });

/** The form of each section: its title and inputs, in order. */
export const SECTIONS: Record<Section, { title: string; inputs: Input[] }> = {
  content: {
    title: 'Content',
    inputs: [{ kind: 'text', id: 'content', label: 'Message text', max: 2000, paragraph: true, get: (s) => s.template.content }],
  },
  body: {
    title: 'Body',
    inputs: [
      { kind: 'text', id: 'title', label: 'Title', max: 256, get: (s) => s.embed.title },
      { kind: 'text', id: 'description', label: 'Description', max: 4000, paragraph: true, get: (s) => s.embed.description },
      url('url', 'Title link', (s) => s.embed.url),
      { kind: 'text', id: 'color', label: 'Color', max: 7, placeholder: '#5865F2', get: (s) => colorText(s.embed.color) },
    ],
  },
  author: {
    title: 'Author',
    inputs: [
      { kind: 'text', id: 'name', label: 'Name', max: 256, get: (s) => s.embed.author?.name },
      url('url', 'Name link', (s) => s.embed.author?.url),
      url('icon_url', 'Icon link', (s) => s.embed.author?.icon_url),
      upload('icon_upload', 'Or upload an icon', 'author_icon'),
    ],
  },
  footer: {
    title: 'Footer',
    inputs: [
      { kind: 'text', id: 'text', label: 'Text', max: 2048, paragraph: true, get: (s) => s.embed.footer?.text },
      url('icon_url', 'Icon link', (s) => s.embed.footer?.icon_url),
      upload('icon_upload', 'Or upload an icon', 'footer_icon'),
      { kind: 'check', id: 'show_time', label: 'Show the time of posting', get: (s) => s.template.showPostTime },
    ],
  },
  images: {
    title: 'Images',
    inputs: [
      url('image_url', 'Image link', (s) => s.embed.image?.url),
      upload('image_upload', 'Or upload an image', 'image'),
      url('thumbnail_url', 'Thumbnail link', (s) => s.embed.thumbnail?.url),
      upload('thumbnail_upload', 'Or upload a thumbnail', 'thumbnail'),
    ],
  },
  field: {
    title: 'Field',
    inputs: [
      { kind: 'text', id: 'name', label: 'Name', max: 256, get: (s) => s.field?.name },
      { kind: 'text', id: 'value', label: 'Value', max: 1024, paragraph: true, get: (s) => s.field?.value },
      { kind: 'check', id: 'inline', label: 'Inline', get: (s) => s.field?.inline === true },
      { kind: 'text', id: 'position', label: 'Position', max: 2, get: (s) => (s.index === undefined ? undefined : String(s.index + 1)) },
    ],
  },
  'add-field': {
    title: 'Add a field',
    inputs: [
      { kind: 'text', id: 'name', label: 'Name', max: 256, required: true, get: () => undefined },
      { kind: 'text', id: 'value', label: 'Value', max: 1024, paragraph: true, required: true, get: () => undefined },
      { kind: 'check', id: 'inline', label: 'Inline', get: () => false },
    ],
  },
};

function colorText(color: number | undefined): string | undefined {
  return color === undefined ? undefined : `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

const isSection = (value: string): value is Section => Object.hasOwn(SECTIONS, value);

/** The section named by a custom ID argument; throws for anything else. */
export function sectionArg(value: string | undefined): Section {
  if (value === undefined || !isSection(value)) throw new Error(`Unknown template section "${value}".`);
  return value;
}

function textInput(input: Extract<Input, { kind: 'text' }>, value: string): TextInputBuilder {
  const builder = new TextInputBuilder()
    .setCustomId(input.id)
    .setStyle(input.paragraph === true ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(input.max)
    .setRequired(input.required === true);
  if (input.placeholder !== undefined) builder.setPlaceholder(input.placeholder);
  if (value !== '') builder.setValue(value);
  return builder;
}

/**
 * The section's form, prefilled from the template or, after an error, from `draft`. A stored value longer than its
 * input allows (a description over 4000 characters) is shown as text instead and stays as it is.
 */
export function sectionModal(ctx: TemplatesContext, section: Section, template: Template, fieldIndex?: number, draft?: Draft): ModalBuilder {
  const embed = template.embed ?? {};
  const field = fieldIndex === undefined ? undefined : embed.fields?.[fieldIndex];
  if (section === 'field' && field === undefined) throw new UserError('That field no longer exists.');
  const source: Source = { template, embed, field, index: fieldIndex };
  const args = section === 'field' ? [section, String(fieldIndex)] : [section];
  const title = section === 'field' ? `Field ${fieldIndex! + 1}` : SECTIONS[section].title;
  const modal = new ModalBuilder().setCustomId(ctx.customId(sectionModalDefinition, args)).setTitle(title);

  for (const input of SECTIONS[section].inputs) {
    const label = new LabelBuilder().setLabel(input.label);
    if (input.kind === 'text') {
      const value = draft?.values[input.id] ?? input.get(source) ?? '';
      if (value.length > input.max) {
        modal.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**${input.label}** is longer than ${input.max} characters, more than a form holds. It stays as it is; change it with Import.`),
        );
        continue;
      }
      if (input.id.endsWith('url') && value.startsWith(UPLOAD_PREFIX)) label.setDescription('Uploaded image. Keep this to keep it, clear it to remove it.');
      modal.addLabelComponents(label.setTextInputComponent(textInput(input, value)));
    } else if (input.kind === 'check') {
      const checked = draft?.checks[input.id] ?? input.get(source);
      modal.addLabelComponents(label.setCheckboxComponent(new CheckboxBuilder().setCustomId(input.id).setDefault(checked)));
    } else {
      const files = new FileUploadBuilder({ custom_id: input.id, min_values: 0, max_values: 1, required: false, file_types: ['image'] });
      modal.addLabelComponents(label.setDescription('Replaces the link.').setFileUploadComponent(files));
    }
  }
  return modal;
}

function optional<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** The draft to reopen a form with: what was typed, without the files. */
export function draftOf(change: Extract<SectionChange, { values: unknown }>): Draft {
  const values: Record<string, string> = {};
  const checks: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(change.values)) if (value !== undefined) values[id] = value;
  for (const [id, value] of Object.entries(change.checks)) if (value !== undefined) checks[id] = value;
  return { values, checks, ...(change.fieldIndex === undefined ? {} : { fieldIndex: change.fieldIndex }) };
}

const megabytes = (bytes: number) => Math.round((bytes / 1_048_576) * 10) / 10;

/** Reads a submitted section form. Uploads that aren't images or are larger than the bot may upload here are refused. */
export function readSection(ctx: ModalContext, section: Section, fieldIndex?: number): SectionChange {
  const change = { section, fieldIndex, values: {}, checks: {}, files: {} } as Extract<SectionChange, { values: unknown }>;
  const fields = ctx.interaction.fields;
  for (const input of SECTIONS[section].inputs) {
    if (input.kind === 'text') change.values[input.id] = optional(() => fields.getTextInputValue(input.id));
    else if (input.kind === 'check') change.checks[input.id] = optional(() => fields.getCheckbox(input.id));
  }
  const limit = ctx.interaction.attachmentSizeLimit;
  for (const input of SECTIONS[section].inputs) {
    if (input.kind !== 'upload') continue;
    const file = optional(() => fields.getUploadedFiles(input.id))?.first();
    if (file === undefined) continue;
    if (file.contentType !== null && file.contentType !== undefined && !file.contentType.startsWith('image/')) {
      throw new TryAgainError('Uploads must be images.', section, draftOf(change));
    }
    if (file.size > limit) {
      throw new TryAgainError(`That file is larger than I can upload here (${megabytes(limit)} MB).`, section, draftOf(change));
    }
    change.files[input.slot] = { name: file.name, url: file.url };
  }
  return change;
}
