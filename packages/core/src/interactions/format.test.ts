import { describe, expect, it } from 'vitest';
import { batchLines, plainText, truncate, yesNo } from './format.js';

describe('batchLines', () => {
  it('keeps lines together while they fit', () => {
    expect(batchLines(['a', 'b', 'c'], 3)).toEqual(['a\nb', 'c']);
  });

  it('never splits a line, even an oversized one', () => {
    expect(batchLines(['abcdef', 'g'], 3)).toEqual(['abcdef', 'g']);
  });

  it('returns nothing for no lines', () => {
    expect(batchLines([])).toEqual([]);
  });
});

describe('truncate', () => {
  it('cuts long values and marks the cut', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('plainText', () => {
  it('strips markdown', () => {
    expect(plainText('**bold** *it* __under__ _em_ `code` ~~gone~~ ||spoiler||')).toBe('bold it under em code gone spoiler');
    expect(plainText('# head\n## sub\n> quote')).toBe('head\nsub\nquote');
  });

  it('keeps characters that are not markdown', () => {
    for (const text of ['foo_bar_baz', '2 * 3 * 4', '<#123>', '<@123> <@&456>', '#general', 'a # b', 'snake_case_name']) {
      expect(plainText(text)).toBe(text);
    }
  });
});

describe('yesNo', () => {
  it('words a boolean', () => {
    expect(yesNo(true)).toBe('Yes');
    expect(yesNo(false)).toBe('No');
  });
});
