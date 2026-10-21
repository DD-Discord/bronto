import type { APIEmbed } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { embedLength, normalizeEmbed, parseColor, sendableEmbed, validateTemplate } from './content.js';

const check = (content: string, embed: APIEmbed | null = null) => validateTemplate({ content, embed });

describe('validateTemplate limits', () => {
  const cases: Array<[string, number, (text: string) => { content: string; embed: APIEmbed | null }]> = [
    ['Content', 2000, (text) => ({ content: text, embed: null })],
    ['Title', 256, (text) => ({ content: '', embed: { title: text } })],
    ['Description', 4096, (text) => ({ content: '', embed: { description: text } })],
    ['Field name', 256, (text) => ({ content: '', embed: { fields: [{ name: text, value: 'v' }] } })],
    ['Field value', 1024, (text) => ({ content: '', embed: { fields: [{ name: 'n', value: text }] } })],
    ['Footer text', 2048, (text) => ({ content: '', embed: { footer: { text } } })],
    ['Author name', 256, (text) => ({ content: '', embed: { author: { name: text } } })],
  ];

  for (const [part, limit, build] of cases) {
    it(`${part} allows ${limit} characters and refuses ${limit + 1}`, () => {
      expect(validateTemplate(build('x'.repeat(limit)))).toBeNull();
      expect(validateTemplate(build('x'.repeat(limit + 1)))).toBe(`${part} can be at most ${limit} characters.`);
    });
  }

  it('allows 25 fields and refuses 26', () => {
    const fields = (n: number) => Array.from({ length: n }, () => ({ name: 'n', value: 'v' }));
    expect(check('', { fields: fields(25) })).toBeNull();
    expect(check('', { fields: fields(26) })).toBe('An embed can have at most 25 fields.');
  });

  it('25 fields of 256+1024 characters exceed 6000', () => {
    const fields = Array.from({ length: 25 }, () => ({ name: 'n'.repeat(256), value: 'v'.repeat(1024) }));
    expect(embedLength({ fields })).toBe(32000);
    expect(check('', { fields })).toBe('The embed is longer than 6000 characters (32000/6000).');
  });

  it('allows an embed of exactly 6000 characters and refuses 6001', () => {
    const embed = (extra: number): APIEmbed => ({
      description: 'd'.repeat(4000),
      fields: [{ name: 'n', value: 'v'.repeat(1024) }, { name: 'n', value: 'v'.repeat(974 + extra) }],
    });
    expect(embedLength(embed(0))).toBe(6000);
    expect(check('', embed(0))).toBeNull();
    expect(check('', embed(1))).toBe('The embed is longer than 6000 characters (6001/6000).');
  });
});

describe('embedLength', () => {
  it('counts title, description, field names and values, footer text and author name', () => {
    expect(
      embedLength({
        title: 'ab',
        description: 'cde',
        fields: [{ name: 'f', value: 'gh' }],
        footer: { text: 'ij' },
        author: { name: 'k' },
        url: 'https://example.com/ignored',
      }),
    ).toBe(11);
  });
});

describe('validateTemplate content', () => {
  it('accepts content-only and embed-only templates', () => {
    expect(check('hello')).toBeNull();
    expect(check('', { description: 'hello' })).toBeNull();
  });

  it('refuses an empty template', () => {
    expect(check('')).toBe('A template needs text or an embed.');
    expect(check('   ', {})).toBe('A template needs text or an embed.');
    expect(check('', { footer: { text: '' } })).toBe('A template needs text or an embed.');
  });

  it('refuses colors outside 0..0xFFFFFF', () => {
    expect(check('', { description: 'x', color: 0x5865f2 })).toBeNull();
    expect(check('', { description: 'x', color: -1 })).toBe('Colors are hex values like #5865F2.');
    expect(check('', { description: 'x', color: 0x1000000 })).toBe('Colors are hex values like #5865F2.');
    expect(check('', { description: 'x', color: 1.5 })).toBe('Colors are hex values like #5865F2.');
  });

  it('accepts http(s) and attachment links and refuses others in every URL field', () => {
    const bad = 'ftp://example.com/a.png';
    const embeds: APIEmbed[] = [
      { description: 'x', url: bad },
      { description: 'x', author: { name: 'a', url: bad } },
      { description: 'x', author: { name: 'a', icon_url: bad } },
      { description: 'x', footer: { text: 'f', icon_url: bad } },
      { description: 'x', image: { url: bad } },
      { description: 'x', thumbnail: { url: bad } },
    ];
    for (const embed of embeds) expect(check('', embed)).toBe('Links must start with http:// or https://.');
    expect(check('', { description: 'x', url: 'javascript:alert(1)' })).toBe('Links must start with http:// or https://.');
    for (const url of ['https://', 'https://exa mple.com', ' https://example.com', 'https://example.com/a b', 'https:example.com', 'http:/example.com']) {
      expect(check('', { description: 'x', url })).toBe('Links must start with http:// or https://.');
    }
    expect(
      check('', {
        description: 'x',
        url: 'http://example.com',
        image: { url: 'attachment://image.png' },
        thumbnail: { url: 'https://example.com/t.png' },
      }),
    ).toBeNull();
  });
});

describe('parseColor', () => {
  it('reads hex colors with or without #', () => {
    expect(parseColor('#5865F2')).toBe(0x5865f2);
    expect(parseColor('5865f2')).toBe(0x5865f2);
    expect(parseColor(' #000000 ')).toBe(0);
  });

  it('maps empty input to null and anything else to invalid', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('  ')).toBeNull();
    expect(parseColor('red')).toBe('invalid');
    expect(parseColor('#fff')).toBe('invalid');
    expect(parseColor('#5865F2FF')).toBe('invalid');
  });
});

describe('normalizeEmbed', () => {
  it('removes an empty footer and other empty parts', () => {
    expect(normalizeEmbed({ description: 'hi', footer: { text: '' }, fields: [], author: { name: '' } })).toEqual({
      description: 'hi',
    });
  });

  it('drops incomplete fields and keeps the color', () => {
    expect(
      normalizeEmbed({ title: 't', color: 5, fields: [{ name: 'a', value: '' }, { name: 'b', value: 'c', inline: true }] }),
    ).toEqual({ title: 't', color: 5, fields: [{ name: 'b', value: 'c', inline: true }] });
  });

  it('returns null when nothing visible remains', () => {
    expect(normalizeEmbed({})).toBeNull();
    expect(normalizeEmbed({ url: 'https://example.com', color: 3, footer: { text: '' } })).toBeNull();
  });
});

describe('sendableEmbed', () => {
  it('drops what Discord adds and keeps what a webhook may send', () => {
    expect(
      sendableEmbed({
        type: 'rich',
        title: 'T',
        description: 'D',
        color: 5,
        timestamp: '2026-01-01T00:00:00.000Z',
        footer: { text: 'F', proxy_icon_url: 'x' },
        image: { url: 'https://example.com/i.png', proxy_url: 'x', width: 1, height: 1 },
        thumbnail: { url: 'https://example.com/t.png', width: 1 },
        author: { name: 'A', url: 'https://example.com', proxy_icon_url: 'x' },
        fields: [{ name: 'n', value: 'v', inline: false }, { name: '', value: 'x' }],
        provider: { name: 'p' },
      }),
    ).toEqual({
      title: 'T',
      description: 'D',
      color: 5,
      timestamp: '2026-01-01T00:00:00.000Z',
      footer: { text: 'F' },
      image: { url: 'https://example.com/i.png' },
      thumbnail: { url: 'https://example.com/t.png' },
      author: { name: 'A', url: 'https://example.com' },
      fields: [{ name: 'n', value: 'v', inline: false }],
    });
  });

  it('returns null for non-objects and embeds with nothing to show', () => {
    expect(sendableEmbed(undefined)).toBeNull();
    expect(sendableEmbed('x')).toBeNull();
    expect(sendableEmbed({ type: 'link', url: 'https://example.com' })).toBeNull();
  });
});
