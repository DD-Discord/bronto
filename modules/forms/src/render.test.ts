import { ComponentType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { Field } from './model.js';
import { MAX_COMPONENTS, MAX_FILES, MAX_TEXT, renderSubmission, type RenderInput, type RenderedPart } from './render.js';

const field = (id: string, type: 'long' | 'file' = 'long', label = `Field ${id}`): Field =>
  type === 'file'
    ? { id, type, label, required: false, maxFiles: 10, fileTypes: [] }
    : { id, type, label, required: false };

const base = (over: Partial<RenderInput>): RenderInput => ({
  formName: 'Story contest',
  userId: '111111111111111111',
  username: 'writer',
  avatarUrl: 'https://cdn.example/a.png',
  submittedAt: new Date('2026-01-02T03:04:05Z'),
  pingUserIds: [],
  pingRoleIds: [],
  fields: [],
  answers: {},
  files: [],
  uploadLimit: 10_000_000,
  answersApart: false,
  ...over,
});

const walk = (part: RenderedPart) => {
  const container = part.components[0] as any;
  return container.components as any[];
};
/** The container's components with each Section's children and accessory following it. */
const flat = (part: RenderedPart) => walk(part).flatMap((c) => (c.type === ComponentType.Section ? [c, ...c.components, c.accessory] : [c]));
const texts = (part: RenderedPart) => flat(part).filter((c) => c.type === ComponentType.TextDisplay).map((c) => c.content as string);
const chars = (part: RenderedPart) => texts(part).join('').length;
const count = (part: RenderedPart) =>
  1 + flat(part).reduce((n, c) => n + 1 + (c.type === ComponentType.MediaGallery ? c.items.length : 0), 0);

const fileInput = (n: number, size = 10, ext = 'txt') => ({
  fields: [field('fff00001', 'file')],
  files: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, fieldId: 'fff00001', name: `f.${ext}`, size })),
});

/** Answer text of a field across parts, continuation headers stripped. */
function collect(parts: RenderedPart[], title: string) {
  let out = '';
  for (const part of parts) {
    for (const t of texts(part)) {
      const m = t.match(new RegExp(`^\\*\\*${title}\\*\\*( \\(continued\\))?\\n`));
      if (m) out += t.slice(m[0].length);
    }
  }
  return out;
}

describe('renderSubmission', () => {
  it('renders a one-field submission as one part with a header', () => {
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: 'Once upon a time' } } }));
    expect(parts).toHaveLength(1);
    const [header, , answer] = texts(parts[0]!);
    expect(header).toContain('## Story contest');
    expect(header).toContain('<@111111111111111111>');
    expect(header).toContain('<t:');
    expect(answer).toBe('**Field aaaaaaaa**\nOnce upon a time');
  });

  it('starts part 1 with the details section, avatar and small line', () => {
    const [part] = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: 'Hi' } } }));
    const kids = walk(part!);
    expect(kids.map((c) => c.type)).toEqual([ComponentType.Section, ComponentType.TextDisplay, ComponentType.Separator, ComponentType.TextDisplay]);
    expect(kids[0].components).toHaveLength(1);
    expect(kids[0].components[0].content).toBe('## Story contest\n**From** <@111111111111111111> (writer)\n**Sent** <t:1767323045:F>');
    expect(kids[0].accessory).toMatchObject({ type: ComponentType.Thumbnail, media: { url: 'https://cdn.example/a.png' } });
    expect(kids[1].content).toBe('-# User ID 111111111111111111');
  });

  it('names the pinged roles and users in the small line', () => {
    const [part] = renderSubmission(base({ pingRoleIds: ['222222222222222222'], pingUserIds: ['333333333333333333'] }));
    expect(texts(part!)[1]).toBe('-# For <@&222222222222222222> <@333333333333333333> · User ID 111111111111111111');
  });

  it('labels later parts with the form, submitter and part number', () => {
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: 'x '.repeat(3000) } } }));
    expect(parts.length).toBeGreaterThan(1);
    expect(texts(parts[1]!)[0]).toBe(`-# Story contest · from <@111111111111111111> · part 2 of ${parts.length}`);
  });

  it('formats choices as bullets and leaves out unanswered fields', () => {
    const parts = renderSubmission(
      base({
        fields: [field('aaaaaaaa'), field('bbbbbbbb'), field('cccccccc')],
        answers: { aaaaaaaa: { choices: ['a', 'b'] }, bbbbbbbb: { text: '  ' } },
      }),
    );
    expect(texts(parts[0]!).slice(2)).toEqual(['**Field aaaaaaaa**\n• a\n• b']);
  });

  it('splits long answers without losing text or exceeding limits', () => {
    const ids = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'];
    const answers = Object.fromEntries(ids.map((id, i) => [id, { text: `${'word '.repeat(799)}end${i}` }]));
    const parts = renderSubmission(base({ fields: ids.map((id) => field(id)), answers }));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(chars(part)).toBeLessThanOrEqual(MAX_TEXT);
    ids.forEach((id) => expect(collect(parts, `Field ${id}`)).toBe((answers[id] as { text: string }).text));
  });

  it('never splits inside a word', () => {
    const text = Array.from({ length: 700 }, (_, i) => `w${i}x`).join(' ').slice(0, 4000);
    const other = 'q'.repeat(10) + ' ' + 'z '.repeat(1500);
    const parts = renderSubmission(
      base({ fields: [field('aaaaaaaa'), field('bbbbbbbb')], answers: { aaaaaaaa: { text }, bbbbbbbb: { text: other } } }),
    );
    for (const part of parts) expect(chars(part)).toBeLessThanOrEqual(MAX_TEXT);
    expect(collect(parts, 'Field aaaaaaaa')).toBe(text);
    expect(collect(parts, 'Field bbbbbbbb')).toBe(other);
    const pieces = texts(parts[0]!).slice(2);
    for (const piece of pieces) expect(piece.endsWith(' ') || piece === text || /\bw\d+x$/.test(piece) || piece.endsWith('z ')).toBe(true);
  });

  it('prefers paragraph breaks, then sentence ends', () => {
    const para = `${'a'.repeat(1500)}\n\n${'b'.repeat(2000)}\n\n${'c'.repeat(1500)}`;
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: para } } }));
    expect(texts(parts[0]!)[2]).toBe(`**Field aaaaaaaa**\n${'a'.repeat(1500)}\n\n${'b'.repeat(2000)}\n\n`);
    const sentences = 'Sentence here. '.repeat(400);
    const split = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: sentences } } }));
    expect(split).toHaveLength(2);
    expect(texts(split[0]!)[2]!.endsWith('here. ')).toBe(true);
    expect(collect(split, 'Field aaaaaaaa')).toBe(sentences);
  });

  it('moves a field that fits a fresh part whole instead of splitting it', () => {
    const parts = renderSubmission(
      base({ fields: [field('aaaaaaaa'), field('bbbbbbbb')], answers: { aaaaaaaa: { text: 'x'.repeat(3000) }, bbbbbbbb: { text: 'y'.repeat(2000) } } }),
    );
    expect(parts).toHaveLength(2);
    expect(texts(parts[1]!)[1]).toBe(`**Field bbbbbbbb**\n${'y'.repeat(2000)}`);
    expect(texts(parts[1]!)[0]).toBe('-# Story contest · from <@111111111111111111> · part 2 of 2');
  });

  it('hard cuts text without whitespace', () => {
    const text = 'x'.repeat(9000);
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text } } }));
    for (const part of parts) expect(chars(part)).toBeLessThanOrEqual(MAX_TEXT);
    expect(collect(parts, 'Field aaaaaaaa')).toBe(text);
  });

  it('splits 12 small files into 10 and 2 with unique attachment names', () => {
    const parts = renderSubmission(base(fileInput(12)));
    expect(parts.map((p) => p.files.length)).toEqual([MAX_FILES, 2]);
    for (const part of parts) {
      const names = part.files.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
      const urls = walk(part).filter((c) => c.type === ComponentType.File).map((c) => c.file.url);
      expect(urls).toEqual(names.map((n) => `attachment://${n}`));
      expect(part.fileKeys).toEqual(part.files.map((f) => f.key));
    }
    expect(texts(parts[1]!)).toContain('**Field fff00001** (continued)');
  });

  it('puts images into a media gallery', () => {
    const [part] = renderSubmission(base(fileInput(3, 10, 'png')));
    const gallery = walk(part!).find((c) => c.type === ComponentType.MediaGallery);
    expect(gallery.items).toHaveLength(3);
    expect(gallery.items[0].media.url).toBe(`attachment://${part!.files[0]!.name}`);
  });

  it('splits files across parts when their sizes exceed the upload limit', () => {
    const parts = renderSubmission(base({ ...fileInput(5, 400), uploadLimit: 1000 }));
    expect(parts.map((p) => p.files.length)).toEqual([2, 2, 1]);
  });

  it('throws for a single file over the upload limit', () => {
    expect(() => renderSubmission(base({ ...fileInput(1, 2000), uploadLimit: 1000 }))).toThrow();
  });

  it('keeps components per part within the limit', () => {
    const fields = Array.from({ length: 100 }, (_, i) => field(`f${String(i).padStart(7, '0')}`));
    const answers = Object.fromEntries(fields.map((f) => [f.id, { text: 'short' }]));
    const parts = renderSubmission(base({ fields, answers }));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(count(part)).toBeLessThanOrEqual(MAX_COMPONENTS);
    const images = renderSubmission(base(fileInput(10, 1, 'png')));
    for (const part of images) expect(count(part)).toBeLessThanOrEqual(MAX_COMPONENTS);
  });

  it('allows pings only on the first part', () => {
    const parts = renderSubmission(
      base({
        pingUserIds: ['222222222222222222'],
        pingRoleIds: ['333333333333333333'],
        fields: [field('aaaaaaaa')],
        answers: { aaaaaaaa: { text: 'x '.repeat(3000) } },
      }),
    );
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.allowedMentions).toEqual({ parse: [], users: ['222222222222222222'], roles: ['333333333333333333'] });
    expect(texts(parts[0]!)[1]).toBe('-# For <@&333333333333333333> <@222222222222222222> · User ID 111111111111111111');
    for (const part of parts.slice(1)) expect(part.allowedMentions).toEqual({ parse: [] });
  });

  it('does not let mentions in answers ping', () => {
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: '@everyone <@123>' } } }));
    for (const part of parts) {
      expect(part.allowedMentions.parse).toEqual([]);
      expect(part.allowedMentions.users ?? []).not.toContain('123');
    }
  });

  it('keeps every part within the limit with 25 pings and a long answer', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `${100000000000000000 + i}`);
    const text = 'word '.repeat(800);
    const parts = renderSubmission(
      base({ pingUserIds: ids.slice(0, 13), pingRoleIds: ids.slice(13), username: 'u'.repeat(32), formName: 'F'.repeat(45), fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text } } }),
    );
    for (const part of parts) expect(chars(part)).toBeLessThanOrEqual(MAX_TEXT);
    expect(collect(parts, 'Field aaaaaaaa')).toBe(text);
  });

  it('keeps a field label with its first file', () => {
    const files = [
      ...Array.from({ length: 10 }, (_, i) => ({ key: `a${i}`, fieldId: 'fff00001', name: 'a.txt', size: 1 })),
      { key: 'b0', fieldId: 'fff00002', name: 'b.txt', size: 1 },
    ];
    const parts = renderSubmission(base({ fields: [field('fff00001', 'file', 'A'), field('fff00002', 'file', 'B')], files }));
    expect(parts.map((p) => p.files.length)).toEqual([10, 1]);
    expect(texts(parts[0]!)).not.toContain('**B**');
    expect(texts(parts[1]!)).toContain('**B**');
    expect(texts(parts[1]!).join()).not.toContain('(continued)');
  });

  it('makes attachment names safe', () => {
    const [part] = renderSubmission(base({ fields: [field('fff00001', 'file')], files: [{ key: 'k', fieldId: 'fff00001', name: 'my file (1).png', size: 1 }] }));
    expect(part!.files[0]!.name).toBe('1-my_file__1_.png');
    const [long] = renderSubmission(base({ fields: [field('fff00001', 'file')], files: [{ key: 'k', fieldId: 'fff00001', name: `${'n'.repeat(300)}.png`, size: 1 }] }));
    expect(long!.files[0]!.name.length).toBeLessThanOrEqual(100);
    expect(long!.files[0]!.name.endsWith('.png')).toBe(true);
  });

  it('puts only the details in part 1 when answers are apart', () => {
    const input = { fields: [field('aaaaaaaa')], answers: { aaaaaaaa: { text: 'Once upon a time' } } };
    const parts = renderSubmission(base({ ...input, answersApart: true }));
    expect(parts).toHaveLength(2);
    expect(texts(parts[0]!).join('\n')).not.toContain('Once upon a time');
    expect(walk(parts[0]!).map((c) => c.type)).toEqual([ComponentType.Section, ComponentType.TextDisplay]);
    expect(texts(parts[1]!)).toEqual(['-# Story contest · from <@111111111111111111> · part 2 of 2', '**Field aaaaaaaa**\nOnce upon a time']);
    expect(renderSubmission(base(input))).toHaveLength(1);
  });

  it('posts one part when answers are apart but nothing was answered', () => {
    const parts = renderSubmission(base({ fields: [field('aaaaaaaa')], answers: {}, answersApart: true }));
    expect(parts).toHaveLength(1);
    expect(texts(parts[0]!).join('\n')).not.toContain('part 1');
    expect(walk(parts[0]!).map((c) => c.type)).toEqual([ComponentType.Section, ComponentType.TextDisplay]);
  });
});
