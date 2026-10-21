import { MessageFlags, type APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { TemplatesContext } from './context.js';
import type { Template } from './db/schema.js';
import { editorView } from './editor.js';
import { sectionModal, SECTIONS, type Section } from './sections.js';

// Custom IDs are signed by the runtime; here they only need to name the component and its arguments.
const ctx = {
  customId: (component: { name: string }, args: string[] = []) => ['templates', component.name, ...args, 'exp', 'signature'].join(':'),
} as unknown as TemplatesContext;

function template(embed: APIEmbed | null, content = 'Hello'): Template {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    guildId: '1',
    name: 'Welcome rules',
    content,
    embed,
    showPostTime: false,
    threadId: '2',
    previewMessageId: '2',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Template;
}

type Json = Record<string, any>;

/** Every component in a V2 message, nested ones included (section accessories too). */
function allComponents(components: Json[]): Json[] {
  return components.flatMap((component) => [
    component,
    ...allComponents(component.components ?? []),
    ...(component.accessory === undefined ? [] : [component.accessory]),
  ]);
}

function view(embed: APIEmbed | null, content = 'Hello') {
  const message = editorView(ctx, template(embed, content), []);
  const json = (message.components ?? []).map((component) => (component as { toJSON(): Json }).toJSON());
  return { message, json, all: allComponents(json) };
}

const ids = (all: Json[]) => all.map((component) => component.custom_id).filter((id): id is string => typeof id === 'string');
const fields = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `Rule ${i + 1}`, value: 'v'.repeat(200), inline: i % 2 === 0 }));

describe('editorView', () => {
  it('stays within 40 components and 25 options at 25 fields, without Add field', () => {
    const { message, json, all } = view({ title: 'T', color: 0x5865f2, fields: fields(25) });
    expect(message.flags).toBe(MessageFlags.IsComponentsV2);
    expect(json).toHaveLength(1);
    expect(json[0]!.accent_color).toBe(0x5865f2);
    expect(all.length).toBeLessThanOrEqual(40);
    const select = all.find((component) => component.options !== undefined)!;
    expect(select.options).toHaveLength(25);
    expect(select.options.map((option: Json) => option.value)).toEqual(Array.from({ length: 25 }, (_, i) => String(i)));
    expect(ids(all).some((id) => id.startsWith('templates:section:add-field:'))).toBe(false);
    expect(ids(all).some((id) => id.startsWith('templates:remove-embed:'))).toBe(true);
    for (const id of ids(all)) expect(id.length).toBeLessThanOrEqual(100);
  });

  it('shows the counts and every section with its own Edit button', () => {
    const { all } = view({ title: 'T', fields: fields(3) });
    const text = all.filter((component) => typeof component.content === 'string').map((component) => component.content).join('\n');
    expect(text).toContain('## Editing "Welcome rules"');
    expect(text).toContain(`**Fields (3/25) · ${1 + 3 * (6 + 200)}/6000 characters**`);
    for (const section of ['content', 'body', 'author', 'footer', 'images', 'add-field']) {
      expect(ids(all).some((id) => id.startsWith(`templates:section:${section}:`))).toBe(true);
    }
  });

  it('offers Remove embed only with an embed, and no field select without fields', () => {
    const { all } = view(null);
    expect(ids(all).some((id) => id.startsWith('templates:remove-embed:'))).toBe(false);
    expect(all.some((component) => component.options !== undefined)).toBe(false);
    const text = all.filter((component) => typeof component.content === 'string').map((component) => component.content).join('\n');
    expect(text).toContain('**Body**  (none)');
  });
});

describe('sectionModal', () => {
  const sections = Object.keys(SECTIONS) as Section[];
  const full = template({ title: 'T', description: 'D', fields: [{ name: 'N', value: 'V' }], footer: { text: 'F' }, author: { name: 'A' } });

  for (const section of sections) {
    it(`builds the ${section} modal within Discord's limits`, () => {
      const modal = sectionModal(ctx, section, full, section === 'field' ? 0 : undefined).toJSON();
      expect(modal.title.length).toBeLessThanOrEqual(45);
      expect(modal.components.length).toBeLessThanOrEqual(5);
      expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    });
  }

  it('prefills from the template and from a draft', () => {
    const fromTemplate = JSON.stringify(sectionModal(ctx, 'body', full).toJSON());
    expect(fromTemplate).toContain('"value":"T"');
    const fromDraft = JSON.stringify(sectionModal(ctx, 'body', full, undefined, { values: { title: 'Typed' }, checks: {} }).toJSON());
    expect(fromDraft).toContain('"value":"Typed"');
  });

  it('shows a description too long for a text input as text and leaves it out of the form', () => {
    const long = template({ description: 'd'.repeat(4001) });
    const modal = JSON.stringify(sectionModal(ctx, 'body', long).toJSON());
    expect(modal).not.toContain('"custom_id":"description"');
    expect(modal).toContain('longer than 4000 characters');
  });
});
