import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordAPIError, type Client } from 'discord.js';
import { UserError } from '../interactions/errors.js';
import type { ModalContext } from '../interactions/context.js';
import { deleteThread, escapeLinkText, exportFileName, importModal, MAX_IMPORT_TEXT, recordList, uploadedJson } from './ui.js';

const clientFetching = (fetch: () => Promise<unknown>) => ({ channels: { fetch } }) as unknown as Client;

describe('deleteThread', () => {
  it('deletes the thread', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    await deleteThread(clientFetching(async () => ({ delete: remove })), 't1');
    expect(remove).toHaveBeenCalledOnce();
  });

  it('counts an Unknown Channel as done', async () => {
    const unknown = new DiscordAPIError({ code: 10003, message: 'Unknown Channel' }, 10003, 404, 'GET', '/channels/t1', {});
    await expect(deleteThread(clientFetching(() => Promise.reject(unknown)), 't1')).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const missing = new DiscordAPIError({ code: 50001, message: 'Missing Access' }, 50001, 403, 'GET', '/channels/t1', {});
    await expect(deleteThread(clientFetching(() => Promise.reject(missing)), 't1')).rejects.toBe(missing);
  });
});

describe('uploadedJson', () => {
  const URL_ = 'https://cdn.discordapp.com/attachments/1/2/a.json';
  const modal = (file?: { name: string; size: number; url?: string }) =>
    ({
      interaction: { fields: { getUploadedFiles: () => (file === undefined ? undefined : { first: () => file }) } },
    }) as unknown as ModalContext;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null without a file', async () => {
    expect(await uploadedJson(modal())).toBeNull();
  });

  it('returns the text of the file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"a":1}'));
    expect(await uploadedJson(modal({ name: 'A.JSON', size: 7, url: URL_ }))).toBe('{"a":1}');
  });

  it.each([
    ['a file that is not .json', { name: 'a.txt', size: 1, url: URL_ }, 'The file must be a .json file.'],
    ['a file that is too large', { name: 'a.json', size: 1_000_001, url: URL_ }, 'The file is too large.'],
  ])('refuses %s', async (_, file, message) => {
    await expect(uploadedJson(modal(file))).rejects.toThrow(new UserError(message));
  });

  it('refuses a file that cannot be downloaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(uploadedJson(modal({ name: 'a.json', size: 1, url: URL_ }))).rejects.toThrow(
      new UserError("I couldn't download that file."),
    );
  });
});

describe('importModal', () => {
  it('has a paragraph for the JSON and an optional file upload', () => {
    const json = importModal({ customId: 'c', title: 'Import x', label: 'X JSON' }).toJSON();
    expect(json.custom_id).toBe('c');
    expect(json.title).toBe('Import x');
    const [first, second] = json.components as any[];
    expect(first.label).toBe('X JSON');
    expect(first.description).toBeUndefined();
    expect(first.component).toMatchObject({ custom_id: 'json', style: 2, max_length: MAX_IMPORT_TEXT, required: false });
    expect(second.label).toBe('Or a .json file');
    expect(second.component).toMatchObject({ custom_id: 'file', min_values: 0, max_values: 1, required: false });
  });

  it('adds the description when given', () => {
    const json = importModal({ customId: 'c', title: 't', label: 'l', description: 'Replaces all.' }).toJSON();
    expect((json.components as any[])[0].description).toBe('Replaces all.');
  });
});

describe('exportFileName', () => {
  it('slugs the name', () => {
    expect(exportFileName('Hello, World!', 'form')).toBe('hello-world.json');
  });

  it('falls back when nothing is left', () => {
    expect(exportFileName('!!!', 'form')).toBe('form.json');
  });

  it('cuts the slug to 50 characters', () => {
    expect(exportFileName('a'.repeat(80), 'form')).toBe(`${'a'.repeat(50)}.json`);
  });
});

describe('escapeLinkText', () => {
  it('escapes the characters that end a link early', () => {
    expect(escapeLinkText('a[b](c)\\')).toBe('a\\[b\\]\\(c\\)\\\\');
  });
});

describe('recordList', () => {
  const link = (name: string, id: string) => `[${name}](https://discord.com/channels/g/${id})`;

  it('sorts case-insensitively and keeps ties stable', () => {
    const text = recordList({
      guildId: 'g',
      rows: [
        { name: 'b', threadId: '1' },
        { name: 'A', threadId: '2' },
        { name: 'a', threadId: '3' },
      ],
    });
    expect(text).toBe([link('A', '2'), link('a', '3'), link('b', '1')].join('\n'));
  });

  it('adds the suffix after the link', () => {
    expect(recordList({ guildId: 'g', rows: [{ name: 'a', threadId: '1', suffix: 'active' }] })).toBe(`${link('a', '1')} · active`);
  });

  it('stops at 50 records', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ name: 'n', threadId: '1' }));
    const lines = recordList({ guildId: 'g', rows }).split('\n');
    expect(lines).toHaveLength(51);
    expect(lines.at(-1)).toBe('…and 10 more');
  });

  it('stays within a message for long names', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ name: `${String(i).padStart(2, '0')}${'x'.repeat(200)}`, threadId: String(i) }));
    const text = recordList({ guildId: 'g', rows });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/\n…and \d+ more$/);
  });
});
