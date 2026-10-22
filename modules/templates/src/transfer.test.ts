import { UserError } from '@bronto/core';
import { describe, expect, it } from 'vitest';
import { exportJson, parseBody, parseTemplateJson } from './transfer.js';

const G = '123456789012345678';
const C = '223456789012345678';
const M = '323456789012345678';

describe('parseBody', () => {
  it.each([
    `https://discord.com/channels/${G}/${C}/${M}`,
    `https://ptb.discord.com/channels/${G}/${C}/${M}`,
    `https://canary.discord.com/channels/${G}/${C}/${M}/`,
    `  https://discordapp.com/channels/${G}/${C}/${M}\n`,
  ])('recognizes the message link %s', (link) => {
    expect(parseBody(link)).toEqual({ kind: 'link', guildId: G, channelId: C, messageId: M });
  });

  it('treats a link with other text as plain text', () => {
    const body = `see https://discord.com/channels/${G}/${C}/${M}`;
    expect(parseBody(body)).toEqual({ kind: 'text', content: body });
  });

  it('parses a JSON object body', () => {
    expect(parseBody('{"content":"hi"}')).toEqual({ kind: 'json', message: { content: 'hi', embed: null } });
  });

  it('parses a fenced JSON body', () => {
    expect(parseBody('```json\n{"content":"hi"}\n```')).toEqual({
      kind: 'json',
      message: { content: 'hi', embed: null },
    });
  });

  it('returns other bodies as raw text', () => {
    expect(parseBody('Hello there')).toEqual({ kind: 'text', content: 'Hello there' });
    expect(parseBody('  [1, 2]  ')).toEqual({ kind: 'text', content: '  [1, 2]  ' });
  });

  it('propagates the error for broken JSON that starts like JSON', () => {
    expect(() => parseBody('{"content": ')).toThrow(UserError);
    expect(() => parseBody('```json\n{oops\n```')).toThrow(UserError);
  });
});

describe('parseTemplateJson', () => {
  it('round-trips through exportJson', () => {
    const message = { content: 'hello', embed: { title: 'T', description: 'D', color: 5 } };
    expect(parseTemplateJson(exportJson(message))).toEqual(message);
  });

  it('keeps the first of several embeds', () => {
    const json = JSON.stringify({ embeds: [{ title: 'one' }, { title: 'two' }] });
    expect(parseTemplateJson(json)).toEqual({ content: '', embed: { title: 'one' } });
  });

  it('accepts a single embed key', () => {
    expect(parseTemplateJson('{"embed":{"title":"x"}}')).toEqual({ content: '', embed: { title: 'x' } });
  });

  it('drops Discord-added embed fields', () => {
    const json = JSON.stringify({ embeds: [{ type: 'rich', title: 'x', id: 4 }] });
    expect(parseTemplateJson(json).embed).toEqual({ title: 'x' });
  });

  it('accepts surrounding whitespace and a fenced block', () => {
    expect(parseTemplateJson('\n  ```\n{"content":"a"}\n```  ')).toEqual({ content: 'a', embed: null });
  });

  it.each([
    ['not json', 'That isn\'t template JSON:'],
    ['[1]', 'That isn\'t template JSON:'],
    ['"str"', 'That isn\'t template JSON:'],
    ['{"content": 5}', 'That isn\'t template JSON:'],
    ['{"embeds": "x"}', 'That isn\'t template JSON:'],
  ])('refuses %s', (text, prefix) => {
    expect(() => parseTemplateJson(text)).toThrow(UserError);
    expect(() => parseTemplateJson(text)).toThrow(prefix);
  });
});

describe('exportJson', () => {
  it('omits embeds without an embed', () => {
    expect(exportJson({ content: 'x', embed: null })).toBe('{\n  "content": "x"\n}');
  });

  it('wraps the embed in an array with 2-space indentation', () => {
    expect(exportJson({ content: '', embed: { title: 'T' } })).toBe(
      '{\n  "content": "",\n  "embeds": [\n    {\n      "title": "T"\n    }\n  ]\n}',
    );
  });
});
