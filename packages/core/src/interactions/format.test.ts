import { describe, expect, it } from 'vitest';
import { batchLines, plainText, truncate } from './format.js';

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
    expect(plainText('**bold** `code` ~~gone~~ ||spoiler|| # head')).toBe('bold code gone spoiler   head');
  });
});
