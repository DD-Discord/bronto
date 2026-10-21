import { UserError } from '@bronto/core';
import type { APIEmbed, APIEmbedField } from 'discord.js';
import { parseColor } from './content.js';
import type { ImageSlot, Template } from './db/schema.js';
import { uploadFileName, type PendingUpload } from './preview.js';
import { setSlot } from './render.js';
import { MAX_FIELDS, type SectionChange } from './sections.js';

const LINK = /^https?:\/\/\S+$/i;
const UPLOAD_PREFIX = 'attachment://';
export const NEEDS_EMBED = 'The template has no text, so it needs its embed. Add text before removing the embed.';

/** The content, embed and time-of-posting setting a change leads to, before normalizing and validating. */
export interface NextTemplate {
  content: string;
  embed: APIEmbed | null;
  showPostTime: boolean;
}

/** A single-line value as typed, trimmed; a multi-line one as typed unless it is only whitespace. */
function clean(value: string | undefined, paragraph = false): string | undefined {
  if (value === undefined) return undefined;
  if (!paragraph || value.trim() === '') return value.trim();
  return value;
}

function link(typed: string | undefined, current: string | undefined): string | undefined {
  if (typed === undefined) return current;
  if (typed === '') return undefined;
  if (!LINK.test(typed)) throw new UserError('Links must start with http:// or https://.');
  return typed;
}

/** The slot's new URL: an upload's `attachment://` name, the typed link, or the current upload kept as it is. */
function imageUrl(slot: ImageSlot, typed: string | undefined, current: string | undefined, uploads: PendingUpload[]): string | undefined {
  const uploaded = uploads.find((entry) => entry.slot === slot);
  if (uploaded !== undefined) return `${UPLOAD_PREFIX}${uploadFileName(uploaded)}`;
  if (typed?.startsWith(UPLOAD_PREFIX) === true) {
    if (typed === current) return current;
    throw new UserError('To show an image file, upload it.');
  }
  return link(typed, current);
}

function setText(embed: APIEmbed, key: 'title' | 'description' | 'url', value: string | undefined): void {
  if (value === undefined || value === '') delete embed[key];
  else embed[key] = value;
}

/**
 * Applies a section change to the template as it is now. `uploads` are the change's downloaded files. Throws a
 * UserError for wrong input; limits and "shows something" are checked by the caller.
 */
export function applySection(current: Template, change: SectionChange, uploads: PendingUpload[]): NextTemplate {
  const next: NextTemplate = { content: current.content, embed: null, showPostTime: current.showPostTime };
  if (change.section === 'remove-embed') {
    if (current.content.trim() === '') throw new UserError(NEEDS_EMBED);
    return next;
  }
  const embed: APIEmbed = structuredClone(current.embed ?? {});
  const v = (id: string, paragraph = false) => clean(change.values[id], paragraph);

  switch (change.section) {
    case 'content':
      next.content = v('content', true) ?? current.content;
      break;
    case 'body': {
      const title = v('title');
      if (title !== undefined) setText(embed, 'title', title);
      const description = v('description', true);
      if (description !== undefined) setText(embed, 'description', description);
      setText(embed, 'url', link(v('url'), embed.url));
      const color = v('color');
      if (color !== undefined) {
        const parsed = parseColor(color);
        if (parsed === 'invalid') throw new UserError('Colors are hex values like #5865F2.');
        if (parsed === null) delete embed.color;
        else embed.color = parsed;
      }
      break;
    }
    case 'author': {
      const name = v('name') ?? embed.author?.name ?? '';
      const href = link(v('url'), embed.author?.url);
      const icon = imageUrl('author_icon', v('icon_url'), embed.author?.icon_url, uploads);
      if (name === '') {
        if (icon !== undefined) throw new UserError('An author icon needs an author name.');
        if (href !== undefined) throw new UserError('An author link needs an author name.');
        delete embed.author;
      } else {
        embed.author = { name, ...(href === undefined ? {} : { url: href }), ...(icon === undefined ? {} : { icon_url: icon }) };
      }
      break;
    }
    case 'footer': {
      const text = v('text', true) ?? embed.footer?.text ?? '';
      const icon = imageUrl('footer_icon', v('icon_url'), embed.footer?.icon_url, uploads);
      if (text === '') {
        if (icon !== undefined) throw new UserError('A footer icon needs footer text.');
        delete embed.footer;
      } else {
        embed.footer = { text, ...(icon === undefined ? {} : { icon_url: icon }) };
      }
      next.showPostTime = change.checks.show_time ?? current.showPostTime;
      break;
    }
    case 'images': {
      const image = imageUrl('image', v('image_url'), embed.image?.url, uploads);
      const thumbnail = imageUrl('thumbnail', v('thumbnail_url'), embed.thumbnail?.url, uploads);
      if (image === undefined) delete embed.image;
      else setSlot(embed, 'image', image);
      if (thumbnail === undefined) delete embed.thumbnail;
      else setSlot(embed, 'thumbnail', thumbnail);
      break;
    }
    case 'field':
      embed.fields = editField(embed.fields ?? [], change.fieldIndex, v('name'), v('value', true), change.checks.inline, v('position'));
      break;
    case 'add-field': {
      const fields = embed.fields ?? [];
      if (fields.length >= MAX_FIELDS) throw new UserError(`An embed can have at most ${MAX_FIELDS} fields.`);
      const name = v('name') ?? '';
      const value = v('value', true) ?? '';
      if (name === '' || value === '') throw new UserError('A field needs a name and a value.');
      embed.fields = [...fields, { name, value, ...(change.checks.inline === true ? { inline: true } : {}) }];
      break;
    }
  }
  if (embed.fields?.length === 0) delete embed.fields;
  next.embed = embed;
  return next;
}

/** The fields after editing the one at `index`: cleared name and value delete it, a position (1-based, clamped) moves it. */
function editField(
  fields: APIEmbedField[],
  index: number | undefined,
  typedName: string | undefined,
  typedValue: string | undefined,
  inline: boolean | undefined,
  position: string | undefined,
): APIEmbedField[] {
  const field = index === undefined ? undefined : fields[index];
  if (field === undefined) throw new UserError('That field no longer exists.');
  const rest = fields.filter((_, i) => i !== index);
  const name = typedName ?? field.name;
  const value = typedValue ?? field.value;
  if (name === '' && value === '') return rest;
  if (name === '' || value === '') throw new UserError('A field needs a name and a value. Clear both to delete it.');
  let target = index!;
  if (position !== undefined && position !== '') {
    if (!/^\d+$/.test(position)) throw new UserError('The position must be a whole number.');
    target = Math.min(Math.max(Number(position), 1), rest.length + 1) - 1;
  }
  const keepsInline = inline ?? field.inline === true;
  rest.splice(target, 0, { name, value, ...(keepsInline ? { inline: true } : {}) });
  return rest;
}
