import { UserError } from '@bronto/core';
import { randomInt } from 'node:crypto';
import { z } from 'zod';

/** Fields per modal page (Discord allows 5 labelled components per modal). */
export const PAGE_SIZE = 5;

export type FieldType = 'short' | 'long' | 'select' | 'radio' | 'checkboxes' | 'file';

const MAX_LABEL = 45;
/** Form names fit a modal title. */
export const MAX_NAME = 45;
const MAX_DESCRIPTION = 100;
const MAX_TEXT = 4000;
const MAX_OPTIONS = 25;
const MAX_OPTION = 100;
const MAX_GROUP_OPTIONS = 10;
const MAX_FILES = 10;
const MAX_FILE_TYPES = 10;
const MAX_PINGS = 100;

const fieldId = z.string().regex(/^[a-z0-9]{8}$/, 'must be 8 lowercase letters or digits');
const label = z.string().min(1).max(MAX_LABEL);
const description = z.string().min(1).max(MAX_DESCRIPTION);
const snowflake = z.string().regex(/^\d{17,20}$/, 'must be a Discord ID');

const base = {
  id: fieldId,
  label,
  description: description.optional(),
  required: z.boolean(),
};

/** Option lists: select menus hold 1-25 options, radio groups 2-10, checkbox groups 1-10. */
const optionList = (min: number, max: number) =>
  z
    .array(z.string().min(1).max(MAX_OPTION))
    .min(min)
    .max(max)
    .refine((list) => new Set(list).size === list.length, 'option labels must be unique');

const textField = z.strictObject({
  ...base,
  type: z.enum(['short', 'long']),
  minLength: z.number().int().min(0).max(MAX_TEXT).optional(),
  maxLength: z.number().int().min(1).max(MAX_TEXT).optional(),
  placeholder: z.string().min(1).max(MAX_DESCRIPTION).optional(),
});

const selectField = z.strictObject({
  ...base,
  type: z.literal('select'),
  options: optionList(1, MAX_OPTIONS),
  minChoices: z.number().int().min(0).max(MAX_OPTIONS).optional(),
  maxChoices: z.number().int().min(1).max(MAX_OPTIONS).optional(),
});

const checkboxesField = z.strictObject({
  ...base,
  type: z.literal('checkboxes'),
  options: optionList(1, MAX_GROUP_OPTIONS),
  minChoices: z.number().int().min(0).max(MAX_GROUP_OPTIONS).optional(),
  maxChoices: z.number().int().min(1).max(MAX_GROUP_OPTIONS).optional(),
});

const radioField = z.strictObject({
  ...base,
  type: z.literal('radio'),
  options: optionList(2, MAX_GROUP_OPTIONS),
});

/** `image`, `video`, `audio` or a dotted extension such as `.pdf`. */
const fileType = z.union([z.enum(['image', 'video', 'audio']), z.string().regex(/^\.[A-Za-z0-9]{1,15}$/, 'must be image, video, audio or an extension like .pdf')]);

const fileField = z.strictObject({
  ...base,
  type: z.literal('file'),
  maxFiles: z.number().int().min(1).max(MAX_FILES),
  fileTypes: z
    .array(fileType)
    .max(MAX_FILE_TYPES)
    .refine((list) => new Set(list.map((type) => type.toLowerCase())).size === list.length, 'file types must be unique'),
});

export const fieldSchema = z
  .discriminatedUnion('type', [textField, selectField, checkboxesField, radioField, fileField])
  .superRefine((field, ctx) => {
    if (field.type === 'short' || field.type === 'long') {
      if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) {
        ctx.addIssue({ code: 'custom', path: ['minLength'], message: 'minLength must not exceed maxLength' });
      }
    } else if (field.type === 'select' || field.type === 'checkboxes') {
      if (field.maxChoices !== undefined && field.maxChoices > field.options.length) {
        ctx.addIssue({ code: 'custom', path: ['maxChoices'], message: 'maxChoices must not exceed the number of options' });
      }
      if (field.minChoices !== undefined && field.minChoices > (field.maxChoices ?? field.options.length)) {
        ctx.addIssue({ code: 'custom', path: ['minChoices'], message: 'minChoices must not exceed maxChoices' });
      }
    }
  });

export type Field = z.infer<typeof fieldSchema>;

/** Discord's mentionable select holds 25 entries; the form's ping list is capped likewise. */
const MAX_PING_TOTAL = 25;

const settingsSchema = z.strictObject({
  name: z.string().min(1).max(MAX_NAME),
  active: z.boolean(),
  channelId: snowflake.nullable(),
  pingUserIds: z.array(snowflake).max(MAX_PINGS),
  pingRoleIds: z.array(snowflake).max(MAX_PINGS),
  allowedRoleIds: z.array(snowflake).max(MAX_PINGS),
  oncePerMember: z.boolean(),
  answersApart: z.boolean().default(false),
}).refine((s) => s.pingUserIds.length + s.pingRoleIds.length <= MAX_PING_TOTAL, {
  path: ['pingUserIds'],
  message: `at most ${MAX_PING_TOTAL} pings (users and roles combined)`,
});

export type FormSettings = z.infer<typeof settingsSchema>;

export const formJsonSchema = z
  .strictObject({
    version: z.literal(1),
    settings: settingsSchema,
    fields: z.array(fieldSchema),
  })
  .superRefine((form, ctx) => {
    const seen = new Set<string>();
    form.fields.forEach((field, index) => {
      if (seen.has(field.id)) {
        ctx.addIssue({ code: 'custom', path: ['fields', index, 'id'], message: `duplicate field ID "${field.id}"` });
      }
      seen.add(field.id);
    });
  });

/** The name trimmed and cut to `MAX_NAME`, without leaving half of a surrogate pair. */
export function formName(name: string): string {
  const cut = name.trim().slice(0, MAX_NAME).trimEnd();
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Splits fields into modal pages of `PAGE_SIZE`, keeping their order. */
export function pages(fields: Field[]): Field[][] {
  const result: Field[][] = [];
  for (let i = 0; i < fields.length; i += PAGE_SIZE) result.push(fields.slice(i, i + PAGE_SIZE));
  return result;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A random 8-character base36 ID that is not in `existing`. */
export function newFieldId(existing: Iterable<string>): string {
  const used = new Set(existing);
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!used.has(id)) return id;
  }
}

export function exportForm(settings: FormSettings, fields: Field[]): string {
  return JSON.stringify({ version: 1, settings, fields }, null, 2);
}

/** Parses an exported form; throws a `UserError` naming the first problem and its path. */
export function importForm(text: string): { settings: FormSettings; fields: Field[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UserError('That is not valid JSON.');
  }
  const parsed = formJsonSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.path.join('.');
    throw new UserError(`Invalid form${path ? ` at ${path}` : ''}: ${issue.message}`);
  }
  return { settings: parsed.data.settings, fields: parsed.data.fields };
}
