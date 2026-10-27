import { UserError } from '@bronto/core';
import { describe, expect, it } from 'vitest';
import { exportForm, fieldSchema, formJsonSchema, importForm, newFieldId, pages, PAGE_SIZE, type Field, type FormSettings } from './model.js';

const short = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'short', label: 'Title', required: true, ...extra });
const field = (id: string): Field => ({ id, type: 'short', label: `Field ${id}`, required: false });

const settings: FormSettings = {
  name: 'Story contest',
  active: true,
  channelId: '123456789012345678',
  pingUserIds: ['223456789012345678'],
  pingRoleIds: ['323456789012345678'],
  allowedRoleIds: [],
  oncePerMember: true,
};

const fields: Field[] = [
  { id: 'aaaaaaa1', type: 'short', label: 'Title', description: 'Name your story', required: true, minLength: 3, maxLength: 80, placeholder: 'A title' },
  { id: 'aaaaaaa2', type: 'long', label: 'Story', required: true, maxLength: 4000 },
  { id: 'aaaaaaa3', type: 'select', label: 'Genre', required: false, options: ['Fantasy', 'Sci-fi'], minChoices: 0, maxChoices: 1 },
  { id: 'aaaaaaa4', type: 'radio', label: 'Rating', required: true, options: ['All ages', 'Mature'] },
  { id: 'aaaaaaa5', type: 'checkboxes', label: 'Rules read', required: true, options: ['Yes'] },
  { id: 'aaaaaaa6', type: 'file', label: 'Cover', required: false, maxFiles: 2, fileTypes: ['image', '.pdf'] },
];

describe('pages', () => {
  it.each([
    [0, []],
    [5, [5]],
    [6, [5, 1]],
    [11, [5, 5, 1]],
  ])('chunks %i fields', (count, sizes) => {
    const all = Array.from({ length: count }, (_, i) => field(`f${i}`));
    expect(pages(all).map((p) => p.length)).toEqual(sizes);
    expect(pages(all).flat()).toEqual(all);
  });

  it('uses pages of 5', () => expect(PAGE_SIZE).toBe(5));
});

describe('fieldSchema', () => {
  it('accepts a 25-option select', () => {
    const options = Array.from({ length: 25 }, (_, i) => `o${i}`);
    expect(fieldSchema.safeParse({ id: 'aaaaaaa1', type: 'select', label: 'Pick', required: true, options, maxChoices: 25 }).success).toBe(true);
  });

  it('accepts every field type', () => {
    for (const f of fields) expect(fieldSchema.safeParse(f).success).toBe(true);
  });

  const rejected: [string, unknown][] = [
    ['a 46-character label', short('aaaaaaa1', { label: 'x'.repeat(46) })],
    ['an empty label', short('aaaaaaa1', { label: '' })],
    ['a 101-character description', short('aaaaaaa1', { description: 'x'.repeat(101) })],
    ['a 101-character placeholder', short('aaaaaaa1', { placeholder: 'x'.repeat(101) })],
    ['maxLength 4001', short('aaaaaaa1', { maxLength: 4001 })],
    ['minLength above maxLength', short('aaaaaaa1', { minLength: 10, maxLength: 5 })],
    ['26 options', { id: 'aaaaaaa1', type: 'select', label: 'Pick', required: true, options: Array.from({ length: 26 }, (_, i) => `o${i}`) }],
    ['no options', { id: 'aaaaaaa1', type: 'select', label: 'Pick', required: true, options: [] }],
    ['a 101-character option', { id: 'aaaaaaa1', type: 'select', label: 'Pick', required: true, options: ['x'.repeat(101)] }],
    ['duplicate option labels', { id: 'aaaaaaa1', type: 'radio', label: 'Pick', required: true, options: ['A', 'A'] }],
    ['a radio with 1 option', { id: 'aaaaaaa1', type: 'radio', label: 'Pick', required: true, options: ['A'] }],
    ['a radio with 11 options', { id: 'aaaaaaa1', type: 'radio', label: 'Pick', required: true, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }],
    ['checkboxes with 11 options', { id: 'aaaaaaa1', type: 'checkboxes', label: 'Pick', required: true, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }],
    ['checkboxes maxChoices 11', { id: 'aaaaaaa1', type: 'checkboxes', label: 'Pick', required: true, options: ['A', 'B'], maxChoices: 11 }],
    ['maxChoices above the option count', { id: 'aaaaaaa1', type: 'checkboxes', label: 'Pick', required: true, options: ['A', 'B'], maxChoices: 3 }],
    ['minChoices above maxChoices', { id: 'aaaaaaa1', type: 'checkboxes', label: 'Pick', required: true, options: ['A', 'B'], minChoices: 2, maxChoices: 1 }],
    ['maxFiles 11', { id: 'aaaaaaa1', type: 'file', label: 'Up', required: true, maxFiles: 11, fileTypes: [] }],
    ['maxFiles 0', { id: 'aaaaaaa1', type: 'file', label: 'Up', required: true, maxFiles: 0, fileTypes: [] }],
    ['a file type without a dot', { id: 'aaaaaaa1', type: 'file', label: 'Up', required: true, maxFiles: 1, fileTypes: ['pdf'] }],
    ['11 file types', { id: 'aaaaaaa1', type: 'file', label: 'Up', required: true, maxFiles: 1, fileTypes: Array.from({ length: 11 }, (_, i) => `.e${i}`) }],
    ['an invalid id', short('NOT-VALID')],
    ['an unknown type', { id: 'aaaaaaa1', type: 'date', label: 'When', required: true }],
  ];
  it.each(rejected)('rejects %s', (_name, value) => {
    expect(fieldSchema.safeParse(value).success).toBe(false);
  });
});

describe('newFieldId', () => {
  it('returns 8 base36 characters not in use', () => {
    const used = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newFieldId(used);
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      expect(used.has(id)).toBe(false);
      used.add(id);
    }
  });
});

describe('export and import', () => {
  it('round-trips', () => {
    expect(importForm(exportForm(settings, fields))).toEqual({ settings, fields });
  });

  it('exports pretty JSON with version 1', () => {
    const text = exportForm(settings, fields);
    expect(text).toContain('\n  ');
    expect(JSON.parse(text).version).toBe(1);
  });

  it('rejects text that is not JSON', () => {
    expect(() => importForm('{')).toThrow(UserError);
    expect(() => importForm('{')).toThrow(/JSON/);
  });

  it('rejects another version', () => {
    const text = JSON.stringify({ version: 2, settings, fields });
    expect(() => importForm(text)).toThrow(UserError);
  });

  it('rejects duplicate field ids', () => {
    const text = JSON.stringify({ version: 1, settings, fields: [fields[0], { ...fields[1], id: fields[0]!.id }] });
    expect(() => importForm(text)).toThrow(/duplicate/i);
    expect(formJsonSchema.safeParse(JSON.parse(text)).success).toBe(false);
  });

  it('names the path of the first problem', () => {
    const bad = [fields[0], { ...fields[1], label: 'x'.repeat(46) }];
    expect(() => importForm(JSON.stringify({ version: 1, settings, fields: bad }))).toThrow(/fields\.1\.label/);
  });

  it('rejects a malformed ping id', () => {
    const bad = { ...settings, pingUserIds: ['abc'] };
    expect(() => importForm(JSON.stringify({ version: 1, settings: bad, fields }))).toThrow(/settings\.pingUserIds/);
  });
});
